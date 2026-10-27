import asyncio
from pathlib import Path
import sys
import tempfile
import time
from types import SimpleNamespace
import unittest
from unittest.mock import AsyncMock, MagicMock, patch
import uuid

import discord
from aiohttp.test_utils import TestClient, TestServer

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
from discord_bridge import Bridge, Store, chunks, plain, public_channel


class BridgeTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.client = discord.Client(intents=discord.Intents.none())
        self.guild = SimpleNamespace(id=123, default_role=object(), members=[], roles=[])
        self.channel = self.make_channel(456)
        self.public = self.make_channel(789)
        self.member = MagicMock(spec=discord.Member)
        self.member.id = 101
        self.member.bot = False
        self.member.guild = self.guild
        self.member.name = 'alex_mc'
        self.member.display_name = 'Alex'
        self.member.is_timed_out.return_value = False
        self.role = MagicMock(spec=discord.Role)
        self.role.id, self.role.name = 333, 'Alex'
        self.role.is_default.return_value = False
        self.guild.members, self.guild.roles = [self.member], [self.role]
        self.client.get_channel = MagicMock(side_effect=lambda i: {456:self.channel,789:self.public}.get(i))
        self.client.get_guild = MagicMock(return_value=self.guild)
        self.client.is_ready = MagicMock(return_value=True)
        self.client.wait_until_ready = AsyncMock()
        self.bridge = Bridge(self.client, 123, 456, 'a' * 40, self.directory.name)
        self.http = TestClient(TestServer(self.bridge.application()))
        await self.http.start_server()
        self.headers = {'Authorization':'Bearer ' + 'a' * 40}
        self.session = str(uuid.uuid4())
        await self.poll()

    async def asyncTearDown(self):
        await self.http.close()
        await self.bridge.close()
        await self.client.close()
        self.directory.cleanup()

    def make_channel(self, channel_id):
        channel = MagicMock(spec=discord.TextChannel)
        channel.id, channel.guild = channel_id, self.guild
        channel.permissions_for.return_value = SimpleNamespace(view_channel=True,send_messages=True)
        channel.send = AsyncMock()
        return channel

    def message(self, **changes):
        values = dict(id=123456789012345678, guild=self.guild, author=self.member, webhook_id=None,
            type=discord.MessageType.default, channel=self.channel, clean_content='Hello @Alex',
            content='Hello <@&333>', attachments=[], role_mentions=[self.role],
            reply=AsyncMock(), jump_url='https://discord.com/channels/123/789/123456789012345678')
        values.update(changes)
        return SimpleNamespace(**values)

    async def poll(self, session=None, players=1):
        return await self.http.get('/bridge/poll',params={'session':session or self.session,'players':str(players)},headers=self.headers)

    def event(self, **changes):
        result = dict(id=str(uuid.uuid4()),playerId=str(uuid.uuid4()),sender='Alex',text='Hello @alex_mc @"Alex" @everyone',createdAt=time.time()*1000)
        result.update(changes)
        return result

    async def test_dedicated_channel_relays_once_and_retains_notification_names(self):
        message=self.message()
        self.bridge.store.toggle(123,101)
        await self.bridge.on_message(message)
        await self.bridge.on_message(message)
        response=await self.poll()
        values=(await response.json())['messages']
        self.assertEqual(len(values),1)
        self.assertEqual(values[0]['notifyNames'],['Alex'])
        self.assertEqual(values[0]['text'],'Hello @Alex')
        self.assertNotIn('discordText',values[0])
        self.assertEqual((await self.http.post('/bridge/ack',json={'session':self.session,'ids':[str(message.id)]},headers=self.headers)).status,200)
        self.assertFalse(self.bridge.pending)
        self.assertTrue(self.bridge.outgoing.empty())

    async def test_toggle_public_messages_are_copied_only_after_ack_and_keep_mentions(self):
        message=self.message(channel=self.public)
        await self.bridge.on_message(message)
        self.assertFalse(self.bridge.pending)
        self.bridge.store.toggle(123,101)
        await self.bridge.on_message(message)
        self.assertEqual(len(self.bridge.pending),1)
        self.assertTrue(self.bridge.outgoing.empty())
        for _ in range(2):
            await self.http.post('/bridge/ack',json={'session':self.session,'ids':[str(message.id)]},headers=self.headers)
        self.assertEqual(self.bridge.outgoing.qsize(),1)
        value=self.bridge.outgoing.get_nowait()
        self.assertEqual(value['text'],'Hello <@&333>')
        self.assertIs(value['message'], message)

    async def test_private_channels_threads_bots_webhooks_dms_and_other_guilds_are_excluded(self):
        self.bridge.store.toggle(123,101)
        self.public.permissions_for.return_value.view_channel=False
        self.assertFalse(self.bridge.eligible(self.message(channel=self.public)))
        thread=MagicMock(spec=discord.Thread)
        thread.id,thread.parent=999,self.channel
        thread.is_private.return_value=True
        self.assertFalse(self.bridge.eligible(self.message(channel=thread)))
        thread.is_private.return_value=False
        self.assertTrue(self.bridge.eligible(self.message(channel=thread)))
        for changes in ({'guild':None},{'guild':SimpleNamespace(id=777)},{'webhook_id':888},{'type':discord.MessageType.pins_add}):
            self.assertFalse(self.bridge.eligible(self.message(**changes)))
        self.member.bot=True
        self.assertFalse(self.bridge.eligible(self.message()))
        self.member.bot=False
        self.channel.permissions_for.return_value.send_messages=False
        self.assertFalse(self.bridge.eligible(self.message()))

    async def test_channel_becoming_private_before_poll_prevents_delivery(self):
        self.bridge.store.toggle(123,101)
        await self.bridge.on_message(self.message(channel=self.public))
        self.public.permissions_for.return_value.view_channel=False
        self.assertEqual((await (await self.poll()).json())['messages'],[])
        self.assertFalse(self.bridge.pending)

    async def test_removed_member_and_revoked_permissions_do_not_relay_queued_text(self):
        self.client._connection._intents.members=True
        self.guild.get_member=MagicMock(return_value=self.member)
        await self.bridge.on_message(self.message())
        self.guild.get_member.return_value=None
        self.assertEqual((await (await self.poll()).json())['messages'],[])
        self.assertFalse(self.bridge.pending)

    async def test_expired_outgoing_never_posts_and_queue_limit_is_enforced(self):
        self.bridge.outgoing.put_nowait({'sender':'Old','text':'stale','kind':'Minecraft','expires':0})
        task=asyncio.create_task(self.bridge.sender())
        await asyncio.wait_for(self.bridge.outgoing.join(),1)
        task.cancel()
        with self.assertRaises(asyncio.CancelledError):await task
        self.channel.send.assert_not_awaited()
        for i in range(100):self.bridge.outgoing.put_nowait({'expires':0})
        response=await self.http.post('/bridge/events',json=self.event(),headers=self.headers)
        self.assertEqual(response.status,503)

    async def test_toggle_ephemeral_persistent_personal_and_can_disable_without_permission(self):
        callback=self.bridge.tree.get_command('macnet',guild=discord.Object(id=123)).get_command('bridgechat').callback
        interaction=SimpleNamespace(guild_id=123,user=self.member,response=SimpleNamespace(send_message=AsyncMock()))
        await callback(interaction)
        self.assertTrue(self.bridge.store.enabled(123,101))
        self.assertFalse(self.bridge.store.enabled(123,102))
        self.assertTrue(interaction.response.send_message.call_args.kwargs['ephemeral'])
        other=Store(Path(self.directory.name)/'chat.sqlite3')
        self.assertTrue(other.enabled(123,101));other.db.close()
        self.channel.permissions_for.return_value.view_channel=False
        await callback(interaction)
        self.assertFalse(self.bridge.store.enabled(123,101))

    async def test_outage_zero_players_limits_and_restart_fail_with_feedback(self):
        self.bridge.last_poll=0
        message=self.message()
        await self.bridge.on_message(message)
        self.assertFalse(self.bridge.pending);message.reply.assert_awaited()
        await self.poll(players=0)
        empty=self.message(id=message.id+1)
        await self.bridge.on_message(empty)
        self.assertEqual(len(self.bridge.pending),1);empty.reply.assert_not_awaited()
        await self.http.post('/bridge/ack',json={'session':self.session,'ids':[str(empty.id)]},headers=self.headers)
        await self.poll(players=1)
        self.bridge.rates.clear()
        for index in range(6):
            latest=self.message(id=message.id+10+index)
            await self.bridge.on_message(latest)
        self.assertEqual(len(self.bridge.pending),5);latest.reply.assert_awaited()
        await self.poll(session=str(uuid.uuid4()))
        self.assertFalse(self.bridge.pending)

    async def test_transport_auth_validation_duplicate_events_and_expiry(self):
        self.assertEqual((await self.http.get('/bridge/directory')).status,401)
        self.assertEqual((await self.http.post('/bridge/events',json={},headers=self.headers)).status,400)
        self.assertEqual((await self.http.post('/bridge/events',json=self.event(createdAt=0),headers=self.headers)).status,400)
        event=self.event()
        for _ in range(2):
            self.assertEqual((await self.http.post('/bridge/events',json=event,headers=self.headers)).status,200)
        self.assertEqual(self.bridge.outgoing.qsize(),1)
        message=self.message()
        await self.bridge.on_message(message)
        self.bridge.pending[str(message.id)]['expiresAt']=0
        self.assertEqual((await (await self.poll()).json())['messages'],[])
        task=asyncio.create_task(self.bridge.expire())
        await asyncio.sleep(.01)
        task.cancel()
        with self.assertRaises(asyncio.CancelledError):await task
        message.reply.assert_awaited()

    async def test_mentions_autocomplete_and_discord_delivery_allow_pings(self):
        directory=await (await self.http.get('/bridge/directory',headers=self.headers)).json()
        self.assertIn('@alex_mc',directory['suggestions'])
        self.assertIn('@"Alex"',directory['suggestions'])
        self.assertIn('@Alex',directory['suggestions'])
        self.assertEqual(self.bridge.mentions('Hi @Alex'), 'Hi <@&333>')
        self.assertEqual(self.bridge.mentions('Hi @alex_mc @"Alex" @everyone @here'), 'Hi <@101> <@&333> @everyone @here')
        self.assertEqual(self.bridge.mentions('mail@alex_mc @alex_mc_more'), 'mail@alex_mc @alex_mc_more')
        await self.http.post('/bridge/events',json=self.event(),headers=self.headers)
        task=asyncio.create_task(self.bridge.sender())
        await asyncio.wait_for(self.bridge.outgoing.join(),1)
        task.cancel()
        with self.assertRaises(asyncio.CancelledError):await task
        text=self.channel.send.call_args.args[0]
        self.assertIn('<@101>',text);self.assertIn('<@&333>',text);self.assertIn('@everyone',text)
        mentions=self.channel.send.call_args.kwargs['allowed_mentions']
        self.assertTrue(mentions.everyone and mentions.roles and mentions.users)

    def test_plain_text_and_chunking(self):
        self.assertEqual(plain('hello\n§cworld\x00'), 'hello world')
        self.assertEqual(''.join(chunks('x'*4000)), 'x'*4000)
        self.assertTrue(all(len(c)<=1500 for c in chunks('x'*4000)))
        tokens='<@123456789012345678>'*100
        parts=list(chunks(tokens))
        self.assertEqual(''.join(parts),tokens)
        self.assertTrue(all(part.endswith('>') for part in parts))


if __name__=='__main__':unittest.main()
