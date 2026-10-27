// A missing remote image retains the plain disc underneath it.
document.addEventListener('error', event => {
  if (event.target instanceof HTMLImageElement && event.target.closest('.music-disc')) event.target.hidden = true;
}, true);

document.addEventListener('click', async event => {
  const target = event.target.closest('[data-music-claim]');
  if (!target) return;
  const command = `/trigger mac_music set ${target.dataset.musicClaim}`;
  try { await navigator.clipboard.writeText(command); target.textContent = 'Command copied'; }
  catch { target.textContent = 'Copy the command shown above'; }
});
