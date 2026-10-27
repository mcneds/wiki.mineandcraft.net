#!/usr/bin/env python3
"""Mirror the wiki's public Minecraft roster in the existing bot's presence."""
import asyncio
import contextlib
import json
import logging
import os
import time
from urllib.parse import urlparse


LOG = logging.getLogger('mineandcraft.discord-status')
INTERVAL = 15
MAX_AGE_MS = 45000
MAX_STATUS = 128
UNAVAILABLE = ('idle', ['Status unavailable'])


def presence(data, now=None):
    """Fail closed on stale/malformed data; paginate without dropping names."""
    now = time.time() * 1000 if now is None else now
    if not isinstance(data, dict):
        return UNAVAILABLE
    updated = data.get('updated')
    if type(updated) not in (int, float) or not 0 <= now - updated <= MAX_AGE_MS:
        return UNAVAILABLE
    if data.get('availability') == 'offline':
        return 'dnd', ['Server offline']
    if data.get('availability') != 'online':
        return UNAVAILABLE
    players, capacity = data.get('players'), data.get('capacity')
    if (not isinstance(players, list) or len(players) > 10000
            or type(capacity) is not int or not 1 <= capacity <= 10000
            or data.get('online') != len(players)
            or any(not isinstance(name, str) or not 1 <= len(name) <= 64
                   or any(ord(char) < 32 or ord(char) == 127 for char in name)
                   for name in players)):
        return UNAVAILABLE
    prefix = f'{len(players)}/{capacity} online · '
    if not players:
        return 'online', [prefix + 'No players online']
    players = sorted(players, key=str.casefold)
    full = prefix + ', '.join(players)
    if len(full) <= MAX_STATUS:
        return 'online', [full]
    # Reserve room for the largest page indicator, even for a 10,000-player roster.
    budget = MAX_STATUS - len(prefix) - len(' [10000/10000]')
    groups, group = [], ''
    for name in players:
        candidate = group + ', ' + name if group else name
        if len(candidate) > budget:
            groups.append(group)
            group = name
        else:
            group = candidate
    groups.append(group)
    return 'online', [f'{prefix}{group} [{index}/{len(groups)}]'
                      for index, group in enumerate(groups, 1)]


def site_origin(value):
    parsed = urlparse(value)
    if (parsed.scheme != 'https' or not parsed.hostname or parsed.username or parsed.password
            or parsed.path not in ('', '/') or parsed.query or parsed.fragment):
        raise ValueError('SITE_ORIGIN must be an HTTPS origin.')
    return value.rstrip('/')


def make_client(origin):
    import aiohttp
    import discord

    class StatusClient(discord.Client):
        def __init__(self):
            bridge_enabled = bool(os.environ.get('CHAT_BRIDGE_CHANNEL_ID'))
            intents = discord.Intents.none()
            if bridge_enabled:
                intents.guilds = intents.guild_messages = intents.message_content = True
                intents.members = os.environ.get('CHAT_MEMBER_AUTOCOMPLETE', '1') == '1'
            super().__init__(intents=intents,
                             activity=discord.CustomActivity('Status unavailable'),
                             status=discord.Status.idle, max_messages=None)
            self.previous = None
            self.pages = None
            self.page = 0
            self.updater = None
            self.bridge = None
            if bridge_enabled:
                from discord_bridge import Bridge
                self.bridge = Bridge(self, int(os.environ['CHAT_BRIDGE_GUILD_ID']),
                    int(os.environ['CHAT_BRIDGE_CHANNEL_ID']), os.environ['CHAT_BRIDGE_KEY'],
                    os.environ.get('STATE_DIRECTORY', '/var/lib/mineandcraft-discord'))

        async def setup_hook(self):
            self.updater = asyncio.create_task(self.update_loop())
            if self.bridge:
                await self.bridge.start()

        async def on_message(self, message):
            if self.bridge:
                await self.bridge.on_message(message)

        async def on_ready(self):
            # A fresh Identify can restore an older cached presence. Re-send on
            # the next scheduled tick, without creating duplicate update loops.
            self.previous = None
            LOG.info('Discord connected as %s.', self.user.name)

        async def update_loop(self):
            async with aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=10)) as session:
                while not self.is_closed():
                    await self.wait_until_ready()
                    try:
                        async with session.get(origin + '/api/server-status/', allow_redirects=False,
                                               headers={'Cache-Control': 'no-cache'}) as response:
                            if response.status != 200:
                                raise ValueError('Status endpoint failed.')
                            try:
                                raw = await response.content.readexactly(1024 * 1024 + 1)
                            except asyncio.IncompleteReadError as end:
                                raw = end.partial
                            if len(raw) > 1024 * 1024:
                                raise ValueError('Status response too large.')
                            data = json.loads(raw)
                        status, pages = presence(data)
                    except Exception as error:
                        # Exception text from providers is deliberately excluded.
                        LOG.warning('Status fetch failed (%s).', type(error).__name__)
                        status, pages = UNAVAILABLE
                    if pages != self.pages:
                        self.pages, self.page = pages, 0
                    text = pages[self.page % len(pages)]
                    value = (status, text)
                    if self.is_ready():
                        try:
                            if value != self.previous:
                                await self.change_presence(activity=discord.CustomActivity(text),
                                                           status=discord.Status(status))
                                self.previous = value
                                LOG.info('Presence sent: %s', text)
                            self.page += 1
                        except Exception as error:
                            LOG.warning('Presence will retry (%s).', type(error).__name__)
                    await asyncio.sleep(INTERVAL)

        async def close(self):
            if self.bridge:
                await self.bridge.close()
                self.bridge = None
            if self.updater:
                self.updater.cancel()
                with contextlib.suppress(asyncio.CancelledError):
                    await self.updater
            await super().close()

    return StatusClient()


if __name__ == '__main__':
    logging.basicConfig(level=logging.INFO, format='%(levelname)s %(name)s: %(message)s')
    origin = site_origin(os.environ.get('SITE_ORIGIN', 'https://wiki.mineandcraft.net'))
    token = os.environ['DISCORD_BOT_TOKEN'].strip()
    if not token:
        raise ValueError('DISCORD_BOT_TOKEN is required.')
    make_client(origin).run(token, log_handler=None)
