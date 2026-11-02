"""Discord reply-only -frame command for still images and animated GIFs.

Uses the gold frame hosted in the owner's public portfolio repository. The
frame overlay is cached in memory, and image processing runs off the event loop.
"""
import asyncio
from io import BytesIO
import logging
import os
from pathlib import Path
import re
import subprocess
import tempfile
import time
from urllib.parse import urlparse

import aiohttp
from PIL import Image, ImageOps, ImageSequence, UnidentifiedImageError

LOG = logging.getLogger('mineandcraft.discord-frame')
FRAME_URL = ('https://raw.githubusercontent.com/mcneds/kuemmerle.dev/'
             'main/assets/images/frame_transparent_straightened.png')
FRAME_SIZE = (1474, 1939)
OPENING = (158, 311, 1124, 1381)
MAX_DOWNLOAD = 20 * 1024 * 1024
MAX_PIXELS = 24_000_000
MAX_FRAMES = 120
MAX_DURATION_MS = 12_000
MAX_OUTPUT_BYTES = 8 * 1024 * 1024
GIF_WIDTH = 540
COOLDOWN_SECONDS = 7
ALLOWED_HOSTS = {'cdn.discordapp.com', 'media.discordapp.net',
                 'cdn.discordapp.net', 'i.imgur.com', 'media.tenor.com',
                 'c.tenor.com', 'media.giphy.com'}


class FrameError(Exception):
    """An expected user-facing failure (do not expose internal exceptions)."""


def allowed_media_url(url):
    if not isinstance(url, str):
        return False
    try:
        parsed = urlparse(url)
    except ValueError:
        return False
    if parsed.scheme != 'https' or parsed.username or parsed.password:
        return False
    host = (parsed.hostname or '').lower()
    return (host in ALLOWED_HOSTS or
            bool(re.fullmatch(r'images-ext-\d+\.discordapp\.net', host)) or
            bool(re.fullmatch(r'media\d*\.tenor\.com', host)) or
            bool(re.fullmatch(r'\d+\.media\.tenor\.com', host)) or
            bool(re.fullmatch(r'media\d*\.giphy\.com', host)))


def media_source(message):
    """Pick actual media from the replied-to Discord message only."""
    for item in getattr(message, 'attachments', ()):
        if allowed_media_url(item.url):
            mime = (getattr(item, 'content_type', None) or '').split(';')[0].lower()
            extension = urlparse(item.url).path.lower()
            if mime.startswith('image/') or extension.endswith(('.png', '.jpg', '.jpeg', '.webp', '.gif')):
                return item.url
    for embed in getattr(message, 'embeds', ()):
        # Discord GIF embeds usually expose a video URL (MP4/WebM), not a GIF file.
        for slot in ('video', 'image', 'thumbnail'):
            part = getattr(embed, slot, None)
            if not part:
                continue
            for attr in ('proxy_url', 'url'):
                url = getattr(part, attr, None)
                if allowed_media_url(url):
                    return url
    return None


async def download(session, url, *, trusted=False):
    if not trusted and not allowed_media_url(url):
        raise FrameError('That media host is not supported.')
    try:
        async with session.get(url, allow_redirects=False) as response:
            if response.status != 200:
                raise FrameError('Could not download the image. Reupload it and try again.')
            if response.content_length is not None and response.content_length > MAX_DOWNLOAD:
                raise FrameError('Image is too large (20 MB limit).')
            content = bytearray()
            async for chunk in response.content.iter_chunked(65536):
                content.extend(chunk)
                if len(content) > MAX_DOWNLOAD:
                    raise FrameError('Image is too large (20 MB limit).')
            return bytes(content)
    except (aiohttp.ClientError, asyncio.TimeoutError) as exc:
        raise FrameError('Could not download the image. Please try again.') from exc


def _fit_image(image, target_size):
    return ImageOps.fit(image.convert('RGBA'), target_size, Image.Resampling.LANCZOS,
                        centering=(0.5, 0.5))


def _compose_picture(source_frame, overlay, *, animated=False):
    if animated:
        width = GIF_WIDTH
        height = round(overlay.height * width / overlay.width)
        frame = overlay.resize((width, height), Image.Resampling.LANCZOS)
        x, y, w, h = OPENING
        x, y = round(x * width / overlay.width), round(y * height / overlay.height)
        w, h = round(w * width / overlay.width), round(h * height / overlay.height)
    else:
        frame = overlay
        x, y, w, h = OPENING
    canvas = Image.new('RGBA', frame.size, (0, 0, 0, 0))
    canvas.alpha_composite(_fit_image(source_frame, (w, h)), (x, y))
    canvas.alpha_composite(frame)
    return canvas


def _gif_palette(canvas):
    # Reserve palette entry 255 for transparent pixels outside the carved frame.
    output = canvas.convert('RGB').quantize(colors=255, method=Image.Quantize.MEDIANCUT)
    palette = output.getpalette() or []
    output.putpalette((palette + [0] * (768 - len(palette)))[:768])
    mask = canvas.getchannel('A').point(lambda alpha: 255 if alpha < 128 else 0)
    output.paste(255, (0, 0), mask)
    output.info['transparency'] = 255
    return output


def render_image(media, frame_png):
    """Return (filename, bytes), preserving GIF animation and input timing."""
    try:
        with Image.open(BytesIO(frame_png)) as base:
            overlay = base.convert('RGBA')
        if overlay.size != FRAME_SIZE:
            raise FrameError('The configured gold frame has unexpected dimensions.')
        with Image.open(BytesIO(media)) as image:
            if image.width * image.height > MAX_PIXELS:
                raise FrameError('Image dimensions are too large.')
            if getattr(image, 'is_animated', False) and getattr(image, 'n_frames', 1) > 1:
                frames = []
                durations = []
                for index, source in enumerate(ImageSequence.Iterator(image)):
                    if index >= MAX_FRAMES:
                        raise FrameError('GIF has too many frames (120 max).')
                    duration = max(20, int(source.info.get('duration', image.info.get('duration', 100)) or 100))
                    if sum(durations) + duration > MAX_DURATION_MS:
                        raise FrameError('GIF is too long (12 seconds max).')
                    canvas = _compose_picture(source, overlay, animated=True)
                    frames.append(_gif_palette(canvas))
                    durations.append(duration)
                output = BytesIO()
                frames[0].save(output, format='GIF', save_all=True, append_images=frames[1:],
                               duration=durations, loop=image.info.get('loop', 0),
                               disposal=2, transparency=255, optimize=False)
                name = 'framed.gif'
            else:
                output = BytesIO()
                _compose_picture(image, overlay).save(output, format='PNG', optimize=True)
                name = 'framed.png'
        result = output.getvalue()
        if len(result) > MAX_OUTPUT_BYTES:
            raise FrameError('The framed image exceeds 8 MB. Try a shorter or smaller GIF.')
        return name, result
    except (UnidentifiedImageError, OSError, ValueError, Image.DecompressionBombError) as exc:
        raise FrameError('That file is not a supported image or GIF.') from exc


def video_to_gif(media):
    """Convert Discord's animated GIF embed previews (MP4/WebM) to GIF."""
    with tempfile.TemporaryDirectory(prefix='macnet-frame-') as directory:
        source = Path(directory) / 'input'
        target = Path(directory) / 'output.gif'
        source.write_bytes(media)
        try:
            subprocess.run(['ffmpeg', '-hide_banner', '-loglevel', 'error', '-nostdin',
                            '-y', '-i', str(source), '-t', '12', '-vf',
                            'fps=10,scale=540:-2:flags=lanczos',
                            '-loop', '0', str(target)],
                           stdout=subprocess.DEVNULL, stderr=subprocess.PIPE,
                           timeout=20, check=True)
        except (subprocess.SubprocessError, OSError) as exc:
            raise FrameError('Could not decode that animated GIF embed.') from exc
        if not target.exists() or target.stat().st_size > MAX_DOWNLOAD:
            raise FrameError('Animated GIF embed is too large.')
        return target.read_bytes()


class FrameCommand:
    def __init__(self, guild_id):
        self.guild_id = guild_id
        self._frame = None
        self._frame_lock = asyncio.Lock()
        self._active = asyncio.Semaphore(2)
        self._recent = {}

    async def get_frame(self, session):
        if self._frame is None:
            async with self._frame_lock:
                if self._frame is None:
                    local = os.environ.get('FRAME_ASSET')
                    if local:
                        self._frame = await asyncio.to_thread(Path(local).read_bytes)
                    else:
                        self._frame = await download(session, FRAME_URL, trusted=True)
        return self._frame

    async def handle(self, message):
        """True means this command message was consumed (never relay to Minecraft)."""
        if not message.guild or message.guild.id != self.guild_id:
            return False
        if message.author.bot or message.webhook_id or message.content.strip().lower() != '-frame':
            return False
        now = time.monotonic()
        self._recent = {user: value for user, value in self._recent.items() if value > now - COOLDOWN_SECONDS}
        if now - self._recent.get(message.author.id, 0) < COOLDOWN_SECONDS:
            await message.reply('Please wait a few seconds before using -frame again.', mention_author=False)
            return True
        self._recent[message.author.id] = now
        reference = message.reference
        if not reference or not reference.message_id:
            await message.reply('Reply to a message containing an image or GIF with -frame.', mention_author=False)
            return True
        try:
            target = reference.resolved
            if not hasattr(target, 'attachments'):
                target = await message.channel.fetch_message(reference.message_id)
            source_url = media_source(target)
            if not source_url:
                raise FrameError('The replied-to message has no supported image or GIF.')
            async with self._active:
                async with message.channel.typing():
                    timeout = aiohttp.ClientTimeout(total=15)
                    async with aiohttp.ClientSession(timeout=timeout) as session:
                        frame, media = await asyncio.gather(self.get_frame(session), download(session, source_url))
                    # Discord/Tenor GIF embeds may resolve to MP4 or WebM previews.
                    if media[4:8] == b'ftyp' or media.startswith(b'\x1a\x45\xdf\xa3'):
                        media = await asyncio.to_thread(video_to_gif, media)
                    name, result = await asyncio.to_thread(render_image, media, frame)
                    import discord
                    await message.reply(file=discord.File(BytesIO(result), filename=name),
                                        mention_author=False)
        except FrameError as exc:
            await message.reply(str(exc), mention_author=False)
        except Exception:
            LOG.exception('Unexpected frame command failure')
            await message.reply('Frame processing failed. Please try another image.', mention_author=False)
        return True
