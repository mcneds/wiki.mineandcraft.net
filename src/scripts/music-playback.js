// Media events do not bubble, so capture them for dynamically rendered rows.
// Keep playback state on the row/form so replacing cover artwork preserves it.
for (const type of ['playing', 'pause', 'ended', 'waiting', 'emptied', 'error']) {
  document.addEventListener(type, event => {
    if (!(event.target instanceof HTMLAudioElement)) return;
    const container = event.target.closest('.music-library-row, .music-track, #music-form');
    if (container) container.classList.toggle('music-playing', type === 'playing');
    if (container && type === 'playing') {
      for (const audio of document.querySelectorAll('.music-library-row audio, .music-track audio, #music-form audio')) {
        if (audio !== event.target && !audio.paused) audio.pause();
      }
    }
  }, true);
}
