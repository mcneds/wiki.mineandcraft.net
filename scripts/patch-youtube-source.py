#!/usr/bin/env python3
"""Patch the pinned youtube-source snapshot's missing format-18 content length.

YouTube can omit contentLength and the URL's clen for this fallback format.
Without that length the HTTP range reader mistakes its first chunk for the
complete file. Unknown-length streams use a full response, letting HTTP supply
the total length. Run on the VPS with Lavalink stopped; no credentials are
read. The original jar is retained outside the plugin directory.
"""
import argparse
from pathlib import Path
import shutil
import subprocess
import urllib.request
import zipfile

REVISION = '2be8e542d3f6f178e048dca565892684c2e40177'
CLASS = 'dev/lavalink/youtube/track/format/StreamFormat'
STREAM_CLASS = 'dev/lavalink/youtube/track/YoutubePersistentHttpStream'
REST_CLASS = 'dev/lavalink/youtube/plugin/YoutubeRestHandler'
METHOD = '''  public long getContentLength() {
    return contentLength;
  }'''
PATCHED = '''  public long getContentLength() {
    if (contentLength >= 0 && contentLength != Long.MAX_VALUE) return contentLength;
    String query = getUrl().getRawQuery();
    if (query != null) {
      for (String parameter : query.split("&")) {
        if (parameter.startsWith("clen=")) {
          try {
            long length = Long.parseLong(parameter.substring(5));
            if (length > 0) return length;
          } catch (NumberFormatException ignored) { }
        }
      }
    }
    return contentLength;
  }'''


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--directory', type=Path, required=True)
    args = parser.parse_args()
    root = args.directory.resolve()
    plugin = root / 'plugins' / f'youtube-plugin-{REVISION}.jar'
    original = root.parent / f'youtube-plugin-{REVISION}.original.jar'
    if not original.exists():
        shutil.copy2(plugin, original)
    build = root.parent / 'youtube-source-patch'
    source = build / 'src' / (CLASS + '.java')
    source.parent.mkdir(parents=True, exist_ok=True)
    url = f'https://raw.githubusercontent.com/lavalink-devs/youtube-source/{REVISION}/common/src/main/java/{CLASS}.java'
    text = urllib.request.urlopen(url, timeout=30).read().decode()
    if text.count(METHOD) != 1:
        raise RuntimeError('Upstream source differs from the pinned patch target.')
    source.write_text(text.replace(METHOD, PATCHED))
    stream_source = build / 'src' / (STREAM_CLASS + '.java')
    stream_text = urllib.request.urlopen(f'https://raw.githubusercontent.com/lavalink-devs/youtube-source/{REVISION}/common/src/main/java/{STREAM_CLASS}.java', timeout=30).read().decode()
    stream_method = '    private URI getNextRangeUrl() {'
    if stream_text.count(stream_method) != 1:
        raise RuntimeError('Upstream stream source differs from pinned patch target.')
    stream_source.write_text(stream_text.replace(stream_method, stream_method + '''
        if (contentLength == Long.MAX_VALUE || contentLength < 0) {
            rangeEnd = Long.MAX_VALUE;
            return contentUrl;
        }
'''))
    rest_source = build / 'src' / (REST_CLASS + '.java')
    rest_source.parent.mkdir(parents=True, exist_ok=True)
    rest_text = urllib.request.urlopen(f'https://raw.githubusercontent.com/lavalink-devs/youtube-source/{REVISION}/plugin/src/main/java/{REST_CLASS}.java', timeout=30).read().decode()
    rest_length = '.contentLength(selectedFormat.getContentLength())'
    if rest_text.count(rest_length) != 1:
        raise RuntimeError('Upstream REST source differs from pinned patch target.')
    rest_source.write_text(rest_text.replace(rest_length, '.contentLength(httpStream.getContentLength())'))
    libs = build / 'libs'; libs.mkdir(exist_ok=True)
    with zipfile.ZipFile(root / 'Lavalink.jar') as archive:
        for name in archive.namelist():
            if name.startswith('BOOT-INF/lib/') and name.endswith('.jar'):
                (libs / Path(name).name).write_bytes(archive.read(name))
    classes = build / 'classes'; classes.mkdir(exist_ok=True)
    classpath = str(original) + ':' + str(libs / '*')
    subprocess.run(['javac', '--release', '17', '-cp', classpath, '-d', str(classes), str(source), str(stream_source), str(rest_source)], check=True)
    check = build / 'LengthCheck.java'
    check.write_text('''import dev.lavalink.youtube.track.format.StreamFormat;
import org.apache.http.entity.ContentType;
public class LengthCheck {
  static class Stream extends dev.lavalink.youtube.track.YoutubePersistentHttpStream {
    Stream(long length) { super(null, java.net.URI.create("https://example.com/media?itag=18"), length); }
    String url() { return getConnectUrl().toString(); }
  }
  static long value(long length, String query) {
    return new StreamFormat(ContentType.parse("video/mp4; codecs=\\"avc1.42001E, mp4a.40.2\\""),
      18, 1, length, 2, "https://example.com/media?" + query, null, null, null, true, false).getContentLength();
  }
  public static void main(String[] args) {
    if (value(-1, "itag=18&clen=16000000&x=1") != 16000000) throw new AssertionError("missing length");
    if (value(42, "clen=16000000") != 42) throw new AssertionError("known length");
    if (value(Long.MAX_VALUE, "clen=16000000") != 16000000) throw new AssertionError("unknown sentinel");
    for (String query : new String[]{"x=1", "clen=bad", "clen=-1", "clen=0", "clen=999999999999999999999"})
      if (value(-1, query) != -1) throw new AssertionError("invalid length");
    for (long length : new long[]{-1, Long.MAX_VALUE})
      if (new Stream(length).url().contains("range=")) throw new AssertionError("unknown-length stream must request full content");
    if (!new Stream(16000000).url().contains("range=0-11862014")) throw new AssertionError("known-length stream retains bounded ranges");
    System.out.println("Content-length regression checks passed.");
  }
}''')
    testpath = str(classes) + ':' + classpath
    subprocess.run(['javac', '--release', '17', '-cp', testpath, '-d', str(classes), str(check)], check=True)
    subprocess.run(['java', '-cp', testpath, 'LengthCheck'], check=True)
    pending = plugin.with_suffix('.pending')
    with zipfile.ZipFile(original) as old, zipfile.ZipFile(pending, 'w') as new:
        for info in old.infolist():
            data = (classes / info.filename).read_bytes() if info.filename in tuple(name + '.class' for name in (CLASS, STREAM_CLASS, REST_CLASS)) else old.read(info.filename)
            new.writestr(info, data)
    pending.replace(plugin)
    print('Patched pinned plugin; original retained at', original)


if __name__ == '__main__':
    main()
