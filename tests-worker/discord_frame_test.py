from io import BytesIO
from pathlib import Path
import sys
from types import SimpleNamespace
import unittest
from unittest.mock import AsyncMock

from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
from discord_frame import FrameCommand, FrameError, allowed_media_url, media_source, render_image


def png(color=(30, 70, 120, 255), size=(120, 100)):
    image = Image.new('RGBA', size, color)
    out = BytesIO()
    image.save(out, format='PNG')
    return out.getvalue()


def gif():
    frames = [Image.new('RGB', (120, 120), color) for color in ('red', 'green', 'blue')]
    out = BytesIO()
    frames[0].save(out, format='GIF', save_all=True, append_images=frames[1:],
                   duration=[100, 150, 200], loop=0)
    return out.getvalue()


class FrameRenderTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        # Use synthetic cutout matching the frame's dimensions; no network in tests.
        base = Image.new('RGBA', (1474, 1939), '#e9bd68')
        base.paste((0, 0, 0, 0), (158, 311, 1282, 1692))
        out = BytesIO()
        base.save(out, format='PNG')
        cls.frame = out.getvalue()

    def test_host_allowlist_disallows_ssrf_and_insecure_urls(self):
        self.assertTrue(allowed_media_url('https://cdn.discordapp.com/attachments/123/photo.png'))
        self.assertTrue(allowed_media_url('https://media1.tenor.com/m/abc/tenor.mp4'))
        for url in ['http://cdn.discordapp.com/pic.png', 'https://localhost/private',
                    'https://127.0.0.1/private', 'https://cdn.discordapp.com.attacker.test/a',
                    'https://user:pass@cdn.discordapp.com/a']:
            self.assertFalse(allowed_media_url(url))

    def test_reply_attachment_and_gif_embed(self):
        attachment = SimpleNamespace(url='https://cdn.discordapp.com/attachments/1/image.png',
                                     content_type='image/png')
        message = SimpleNamespace(attachments=[attachment], embeds=[])
        self.assertEqual(media_source(message), attachment.url)
        video = SimpleNamespace(url='https://media1.tenor.com/m/abc/tenor.mp4', proxy_url=None)
        message = SimpleNamespace(attachments=[], embeds=[SimpleNamespace(video=video,image=None,thumbnail=None)])
        self.assertEqual(media_source(message), video.url)

    def test_png_keeps_cutout_and_frame(self):
        name, data = render_image(png(), self.frame)
        self.assertEqual(name, 'framed.png')
        with Image.open(BytesIO(data)) as image:
            self.assertEqual(image.size, (1474, 1939))
            self.assertEqual(image.getpixel((500, 600)), (30, 70, 120, 255))
            self.assertEqual(image.getpixel((100, 100)), (233, 189, 104, 255))

    def test_gif_remains_animated_and_preserves_timing(self):
        name, data = render_image(gif(), self.frame)
        self.assertEqual(name, 'framed.gif')
        with Image.open(BytesIO(data)) as image:
            self.assertEqual(image.n_frames, 3)
            self.assertEqual(image.size[0], 540)
            self.assertEqual([image.seek(i) or image.info['duration'] for i in range(3)], [100, 150, 200])

    def test_reject_oversized_image(self):
        self.assertRaises(FrameError, render_image, png(size=(6000, 6000)), self.frame)


class FrameCommandTests(unittest.IsolatedAsyncioTestCase):
    async def test_consumes_command_even_without_reply_and_restricts_guild(self):
        handler = FrameCommand(123)
        message = SimpleNamespace(guild=SimpleNamespace(id=123), author=SimpleNamespace(bot=False, id=1),
                                  webhook_id=None, content='-frame', reference=None, reply=AsyncMock())
        self.assertTrue(await handler.handle(message))
        message.reply.assert_awaited_once()
        self.assertFalse(await handler.handle(SimpleNamespace(**{**vars(message), 'guild':SimpleNamespace(id=999)})))


if __name__ == '__main__':
    unittest.main()
