document.addEventListener('click', async event => {
  const button = event.target.closest('[data-head-claim]');
  if (!button) return;
  try { await navigator.clipboard.writeText(button.dataset.headClaim); button.textContent = 'Copied'; }
  catch { button.textContent = 'Select and copy the command above'; }
});
