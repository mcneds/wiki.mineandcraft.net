import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location('discord_status', Path(__file__).resolve().parents[1] / 'scripts' / 'discord-status.py')
status = importlib.util.module_from_spec(spec)
spec.loader.exec_module(status)


class DiscordStatusTests(unittest.TestCase):
    def snapshot(self, players=(), **changes):
        return dict(availability='online', players=list(players), online=len(players),
                    capacity=20, updated=100000, **changes)

    def test_count_and_all_world_names(self):
        self.assertEqual(status.presence(self.snapshot(['Steve', '.Bedrock', 'Alex']), now=100001),
                         ('online', ['3/20 online · .Bedrock, Alex, Steve']))

    def test_empty_server_is_online(self):
        self.assertEqual(status.presence(self.snapshot(), now=100001),
                         ('online', ['0/20 online · No players online']))

    def test_offline_and_unknown_are_distinct_and_hide_old_names(self):
        data = self.snapshot(['OldPlayer'])
        data['availability'] = 'offline'
        self.assertEqual(status.presence(data, now=100001), ('dnd', ['Server offline']))
        data['availability'] = 'unavailable'
        self.assertEqual(status.presence(data, now=100001), status.UNAVAILABLE)

    def test_stale_future_missing_and_malformed_fail_closed(self):
        for data, now in [(self.snapshot(['OldPlayer']), 145001), (self.snapshot(), 99999),
                          ({}, 100001), (None, 100001),
                          ({**self.snapshot(), 'online': 2}, 100001),
                          (self.snapshot(['bad\nname']), 100001),
                          ({**self.snapshot(), 'capacity': None}, 100001)]:
            with self.subTest(data=data):
                self.assertEqual(status.presence(data, now=now), status.UNAVAILABLE)

    def test_long_roster_pages_cover_every_name_with_count(self):
        players = ['Player' + str(index).zfill(3) + 'x' * 40 for index in range(100)]
        state, pages = status.presence(self.snapshot(players), now=100001)
        self.assertEqual(state, 'online')
        self.assertGreater(len(pages), 1)
        for page in pages:
            self.assertLessEqual(len(page), 128)
            self.assertTrue(page.startswith('100/20 online · '))
        for name in players:
            self.assertEqual(sum(name in page for page in pages), 1)

    def test_https_origin_only(self):
        self.assertEqual(status.site_origin('https://wiki.mineandcraft.net/'), 'https://wiki.mineandcraft.net')
        for origin in ['http://example.com', 'https://a:b@example.com', 'https://example.com/path', 'https://example.com?q=1']:
            with self.assertRaises(ValueError):
                status.site_origin(origin)


if __name__ == '__main__':
    unittest.main()
