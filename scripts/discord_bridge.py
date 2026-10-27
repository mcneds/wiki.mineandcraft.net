"""Guild-only chat relay; local Fabric transport never accepts commands."""
import asyncio
from collections import OrderedDict, deque
import contextlib
import hmac
import logging
from pathlib import Path
import re
import sqlite3
import time
import unicodedata
import uuid

from aiohttp import web
import discord
from discord import app_commands

LOG = logging.getLogger('mineandcraft.chat')
TTL = 30
QUEUE_LIMIT = 100


def plain(value, limit=6000):
    value = re.sub(r'§.', '', value)
    value = ''.join(c if not unicodedata.category(c).startswith('C') else ' ' for c in value)
    value = ' '.join(value.split())
    return value if len(value) <= limit else value[:limit - 1] + '…'


def chunks(value, limit=1500):
    while value:
        end = len(value) if len(value) <= limit else value.rfind(' ', 0, limit + 1)
        if end <= 0:
            end = min(limit, len(value))
        # Adjacent Discord mention tokens need not have spaces between them.
        for mention in re.finditer(r'<@!?\d+>|<@&\d+>', value):
            if mention.start() < end < mention.end():
                end = mention.start()
                break
        yield value[:end]
        value = value[end:].lstrip()


def public_channel(channel):
    if isinstance(channel, discord.Thread):
        if channel.is_private():
            return False
        channel = channel.parent
    return (isinstance(channel, discord.TextChannel)
            and channel.permissions_for(channel.guild.default_role).view_channel)


class Store:
    def __init__(self, path):
        Path(path).parent.mkdir(parents=True, exist_ok=True)
        self.db = sqlite3.connect(path)
        self.db.execute('CREATE TABLE IF NOT EXISTS toggles(guild TEXT,user TEXT,PRIMARY KEY(guild,user))')
        self.db.execute('CREATE TABLE IF NOT EXISTS seen(id TEXT PRIMARY KEY,created REAL NOT NULL)')
        self.db.commit()

    def enabled(self, guild, user):
        return self.db.execute('SELECT 1 FROM toggles WHERE guild=? AND user=?', (str(guild), str(user))).fetchone() is not None

    def toggle(self, guild, user):
        enabled = not self.enabled(guild, user)
        with self.db:
            self.db.execute('INSERT INTO toggles VALUES(?,?)' if enabled else 'DELETE FROM toggles WHERE guild=? AND user=?', (str(guild), str(user)))
        return enabled

    def remember(self, key):
        with self.db:
            self.db.execute('DELETE FROM seen WHERE created<?', (time.time() - 86400,))
            return bool(self.db.execute('INSERT OR IGNORE INTO seen VALUES(?,?)', (key, time.time())).rowcount)

    def contains(self, key):
        return self.db.execute('SELECT 1 FROM seen WHERE id=?', (key,)).fetchone() is not None


class Bridge:
    def __init__(self, client, guild_id, channel_id, key, state_dir):
        if len(key) < 32:
            raise ValueError('CHAT_BRIDGE_KEY must contain at least 32 characters.')
        self.client, self.guild_id, self.channel_id, self.key = client, guild_id, channel_id, key
        self.store = Store(Path(state_dir) / 'chat.sqlite3')
        self.pending = OrderedDict()
        self.outgoing = asyncio.Queue(maxsize=QUEUE_LIMIT)
        self.rates = {}
        self.last_poll, self.players, self.session = 0, 0, None
        self.tasks, self.runner = [], None
        self.tree = app_commands.CommandTree(client)
        group = app_commands.Group(name='macnet', description='MineAndCraft server tools')

        @group.command(name='bridgechat', description='Toggle relaying your public-channel messages to Minecraft')
        async def bridgechat(interaction: discord.Interaction):
            if interaction.guild_id != self.guild_id:
                await interaction.response.send_message('This command is only available in the MineAndCraft server.', ephemeral=True)
                return
            # Always allow disabling even if access has since been removed.
            if not self.store.enabled(self.guild_id, interaction.user.id) and not self.allowed_member(interaction.user):
                await interaction.response.send_message('You need access to view and send messages in #minecraft-chat.', ephemeral=True)
                return
            enabled = self.store.toggle(self.guild_id, interaction.user.id)
            await interaction.response.send_message(
                'Bridge chat ON: your new messages in public text channels and public threads will be copied to #minecraft-chat and Minecraft. Private channels and DMs are excluded. Run /macnet bridgechat again to turn it off.'
                if enabled else 'Bridge chat OFF. Only messages you send directly in #minecraft-chat will relay to Minecraft.', ephemeral=True)

        self.tree.add_command(group, guild=discord.Object(id=guild_id))

    def channel(self):
        channel = self.client.get_channel(self.channel_id)
        return channel if isinstance(channel, discord.TextChannel) and channel.guild.id == self.guild_id else None

    def allowed_member(self, member):
        channel = self.channel()
        if not channel or not isinstance(member, discord.Member) or member.guild.id != self.guild_id:
            return False
        permissions = channel.permissions_for(member)
        return permissions.view_channel and permissions.send_messages and not member.is_timed_out()

    def eligible(self, message):
        if (not message.guild or message.guild.id != self.guild_id or message.author.bot
                or message.webhook_id or message.type not in (discord.MessageType.default, discord.MessageType.reply)
                or not self.allowed_member(message.author)):
            return False
        if message.channel.id == self.channel_id:
            return True
        return self.store.enabled(self.guild_id, message.author.id) and public_channel(message.channel)

    def still_allowed(self, message):
        channel = self.client.get_channel(message.channel.id)
        guild = self.client.get_guild(self.guild_id)
        member = guild.get_member(message.author.id) if guild and self.client.intents.members else message.author
        if not channel or not member or not self.allowed_member(member):
            return False
        return channel.id == self.channel_id or (self.store.enabled(self.guild_id, member.id) and public_channel(channel))

    def rate_allowed(self, key):
        now = time.monotonic()
        # Remove idle senders as well as old timestamps to keep memory bounded.
        self.rates = {k: v for k, v in self.rates.items() if v and v[-1] > now - 10}
        times = self.rates.setdefault(key, deque())
        while times and times[0] <= now - 10:
            times.popleft()
        if len(times) >= 5:
            return False
        times.append(now)
        return True

    def mention_names(self):
        guild = self.client.get_guild(self.guild_id)
        if not guild:
            return {}
        # Unique usernames are unambiguous even when display names collide.
        names = {'@' + member.name: f'<@{member.id}>' for member in guild.members if not member.bot}
        for role in guild.roles:
            if not role.is_default():
                names['@"' + role.name.replace('"', '') + '"'] = f'<@&{role.id}>'
                if re.fullmatch(r'[\w.-]+', role.name):
                    names.setdefault('@' + role.name, f'<@&{role.id}>')
        names['@everyone'], names['@here'] = '@everyone', '@here'
        return names

    def mentions(self, text):
        names = self.mention_names()
        if not names:
            return text
        # Do not interpret email addresses, URL fragments or partial usernames.
        pattern = r'(?<![\w/@])(?:' + '|'.join(re.escape(n) for n in sorted(names, key=len, reverse=True)) + r')(?![\w.])'
        return re.sub(pattern, lambda match: names[match.group()], text)

    async def directory(self, request):
        return web.json_response({'suggestions': sorted(self.mention_names(), key=str.casefold)[:5000]})

    async def feedback(self, message, text):
        try:
            await message.reply(text, mention_author=False, allowed_mentions=discord.AllowedMentions.none())
        except discord.HTTPException:
            LOG.warning('Could not report a chat delivery failure.')

    async def on_message(self, message):
        if not self.eligible(message) or self.store.contains('discord:' + str(message.id)):
            return
        text = plain('\n'.join([message.clean_content, *[a.url for a in message.attachments]]))
        if not text:
            return
        # Deduplicate before the first await; reconnect delivery may be concurrent.
        self.store.remember('discord:' + str(message.id))
        if not self.rate_allowed(('discord', message.author.id)):
            await self.feedback(message, 'Chat bridge limit: five messages per ten seconds. Please wait before sending another.')
            return
        if not self.client.is_ready() or time.monotonic() - self.last_poll > 5:
            await self.feedback(message, 'Minecraft chat is unavailable. This message was not relayed; please try again when the server reconnects.')
            return
        if len(self.pending) >= QUEUE_LIMIT:
            await self.feedback(message, 'The chat bridge is busy. This message was not relayed; please try again shortly.')
            return
        self.pending[str(message.id)] = {
            'id': str(message.id), 'sender': plain(message.author.display_name, 64), 'text': text,
            'discordText': plain('\n'.join([message.content, *[a.url for a in message.attachments]])),
            'notifyNames': sorted({role.name for role in message.role_mentions if not role.is_default()})[:100],
            'expiresAt': int((time.time() + TTL) * 1000), 'source': message,
        }

    @web.middleware
    async def authenticate(self, request, handler):
        if not hmac.compare_digest(request.headers.get('Authorization', ''), 'Bearer ' + self.key):
            raise web.HTTPUnauthorized()
        return await handler(request)

    def application(self):
        app = web.Application(middlewares=[self.authenticate], client_max_size=32768)
        app.router.add_get('/bridge/poll', self.poll)
        app.router.add_post('/bridge/ack', self.ack)
        app.router.add_post('/bridge/events', self.event)
        app.router.add_get('/bridge/directory', self.directory)
        app.router.add_get('/bridge/health', self.health)
        return app

    async def health(self, request):
        return web.json_response({'discordReady': self.client.is_ready(), 'channelReady': self.channel() is not None,
            'minecraftConnected': bool(self.session) and time.monotonic() - self.last_poll < 5,
            'players': self.players, 'pending': len(self.pending), 'outgoing': self.outgoing.qsize(),
            'completionCount': len(self.mention_names()),
            'preferences': self.store.db.execute('SELECT COUNT(*) FROM toggles').fetchone()[0]})

    async def poll(self, request):
        try:
            session = str(uuid.UUID(request.query['session']))
            players = int(request.query['players'])
            if not 0 <= players <= 10000:
                raise ValueError()
        except (KeyError, ValueError):
            raise web.HTTPBadRequest()
        if self.session and session != self.session:
            await self.fail_pending('Minecraft restarted before this message could be delivered. Please send it again.')
        self.session, self.players, self.last_poll = session, players, time.monotonic()
        values = []
        for value in list(self.pending.values()):
            source = value['source']
            # Re-check current channel visibility before exposing queued text.
            if not self.still_allowed(source):
                self.pending.pop(value['id'], None)
                continue
            if value['expiresAt'] > time.time() * 1000 and self.client.is_ready():
                values.append({k: v for k, v in value.items() if k not in ('source', 'discordText')})
        return web.json_response({'messages': values[:5]})

    async def ack(self, request):
        body = await request.json()
        if not isinstance(body, dict) or body.get('session') != self.session or not isinstance(body.get('ids'), list) or len(body['ids']) > 100 or any(not isinstance(i, str) for i in body['ids']):
            raise web.HTTPBadRequest()
        for key in body['ids']:
            value = self.pending.pop(key, None)
            if not value or value['source'].channel.id == self.channel_id:
                continue
            source = value['source']
            if not self.still_allowed(source):
                continue
            # Queue the public-channel copy only after Minecraft acknowledges it.
            if not self.outgoing.full():
                self.outgoing.put_nowait({'sender': value['sender'], 'text': value['discordText'],
                    'message': source, 'kind': 'Discord', 'expires': time.monotonic() + TTL})
            else:
                await self.feedback(source, 'Delivered to Minecraft, but the bridge channel copy could not be queued.')
        return web.json_response({'ok': True})

    async def event(self, request):
        body = await request.json()
        try:
            if not isinstance(body, dict):
                raise ValueError()
            key = 'minecraft:' + str(uuid.UUID(body['id']))
            player_id = str(uuid.UUID(body['playerId']))
            if not isinstance(body['sender'], str) or not isinstance(body['text'], str) or not 0 <= time.time() * 1000 - body['createdAt'] <= TTL * 1000:
                raise ValueError()
            sender, text = plain(body['sender'], 64), plain(body['text'], 1024)
            if not sender or not text:
                raise ValueError()
        except (KeyError, ValueError, TypeError):
            raise web.HTTPBadRequest()
        if self.store.contains(key):
            return web.json_response({'ok': True})
        if not self.client.is_ready() or not self.channel() or self.outgoing.full():
            raise web.HTTPServiceUnavailable()
        if not self.rate_allowed(('minecraft', player_id)):
            self.store.remember(key)
            raise web.HTTPTooManyRequests()
        self.store.remember(key)
        self.outgoing.put_nowait({'sender': sender, 'text': text, 'kind': 'Minecraft',
                                 'expires': time.monotonic() + TTL})
        return web.json_response({'ok': True})

    async def sender(self):
        while True:
            value = await self.outgoing.get()
            try:
                remaining = value['expires'] - time.monotonic()
                if remaining <= 0:
                    continue
                async def deliver():
                    await self.client.wait_until_ready()
                    channel = self.channel()
                    if not channel or (value.get('message') and not self.still_allowed(value['message'])):
                        return
                    prefix = f"[{value['kind']}] {plain(value['sender'], 64)}: "
                    # Resolve names before splitting so a mention token stays intact.
                    for part in chunks(self.mentions(value['text'])):
                        text = discord.utils.escape_mentions(discord.utils.escape_markdown(prefix)) + discord.utils.escape_markdown(part)
                        await channel.send(text, allowed_mentions=discord.AllowedMentions(everyone=True, users=True, roles=True, replied_user=False), suppress_embeds=True)
                await asyncio.wait_for(deliver(), timeout=remaining)
            except (discord.HTTPException, asyncio.TimeoutError):
                # Do not resend ambiguous HTTP failures and risk duplicate posts.
                LOG.warning('Chat relay delivery failed or expired.')
            finally:
                self.outgoing.task_done()

    async def fail_pending(self, reason):
        values = list(self.pending.values())
        self.pending.clear()
        for value in values:
            await self.feedback(value['source'], reason)

    async def expire(self):
        while True:
            for key, value in list(self.pending.items()):
                if value['expiresAt'] <= time.time() * 1000:
                    self.pending.pop(key, None)
                    await self.feedback(value['source'], 'Minecraft did not confirm delivery before this message expired. It will not be replayed later.')
            await asyncio.sleep(1)

    async def start(self):
        self.runner = web.AppRunner(self.application(), access_log=None)
        await self.runner.setup()
        await web.TCPSite(self.runner, '127.0.0.1', 25586).start()
        self.tasks = [asyncio.create_task(self.sender()), asyncio.create_task(self.expire())]
        LOG.info('Chat transport listening on loopback.')

    async def close(self):
        for task in self.tasks:
            task.cancel()
        for task in self.tasks:
            with contextlib.suppress(asyncio.CancelledError):
                await task
        if self.runner:
            await self.runner.cleanup()
        self.store.db.close()
