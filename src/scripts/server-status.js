const container = document.getElementById('server-status');
const button = document.getElementById('server-status-button');
const panel = document.getElementById('server-status-panel');
if (container && button && panel) {
  const open = value => { panel.hidden = !value; button.setAttribute('aria-expanded', String(value)); };
  let dismissed = false, expires = 0, wasOpen = false;
  button.addEventListener('pointerdown', () => { wasOpen = !panel.hidden; });
  button.addEventListener('click', event => { dismissed = false; open(event.detail ? !wasOpen : panel.hidden); });
  button.addEventListener('focus', () => { if (!dismissed) open(true); });
  container.addEventListener('pointerenter', event => { if (event.pointerType === 'mouse') { dismissed = false; open(true); } });
  container.addEventListener('pointerleave', () => { if (!container.contains(document.activeElement)) open(false); });
  container.addEventListener('focusout', event => { if (!container.contains(event.relatedTarget)) { dismissed = false; open(false); } });
  document.addEventListener('pointerdown', event => { if (!container.contains(event.target)) { dismissed = false; open(false); } });
  document.addEventListener('keydown', event => { if (event.key === 'Escape') { dismissed = true; open(false); } });
  function render(data) {
    button.textContent = data.availability === 'online' ? `${data.online}/${data.capacity} online` : data.availability === 'offline' ? 'Offline' : 'Status unavailable';
    const heading = document.createElement('strong'); heading.textContent = data.availability === 'online' ? 'Players online · all worlds' : button.textContent;
    const list = document.createElement('ul');
    for (const name of data.players || []) { const item = document.createElement('li'); item.textContent = name; list.append(item); }
    const empty = document.createElement('p'); empty.textContent = data.availability === 'online' ? 'No players online.' : data.availability === 'offline' ? 'The Minecraft server is offline.' : 'Live player information is temporarily unavailable.';
    panel.replaceChildren(heading, data.players?.length ? list : empty);
  }
  async function refresh() {
    if (document.hidden) return;
    try {
      const response = await fetch('/api/server-status/', { cache: 'no-store', signal: AbortSignal.timeout(10000) });
      if (!response.ok) throw new Error();
      const data = await response.json(); expires = data.updated ? data.updated + 45000 : 0; render(data);
    } catch { expires = 0; render({ availability: 'unavailable' }); }
  }
  setInterval(() => { if (expires && Date.now() > expires) { expires = 0; render({ availability: 'unavailable' }); } }, 1000);
  setInterval(refresh, 15000); document.addEventListener('visibilitychange', refresh); refresh();
}
