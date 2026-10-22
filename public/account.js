const $ = selector => document.querySelector(selector);
const accountStatus = $('#account-status');
let account, player, lookupResult, changed = false;
const message = text => { accountStatus.textContent = text; };
async function api(path, method = 'GET', body) {
  const response = await fetch(path, {
    method, credentials: 'same-origin',
    headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(method !== 'GET' ? { 'X-CSRF-Token': account?.user?.csrf || '' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (response.status === 204) return;
  const result = await response.json();
  if (!response.ok) {
    if (response.status === 401) $('#discord-login').hidden = false;
    throw new Error(result.error || 'The request could not be completed.');
  }
  return result;
}
async function run(button, action) {
  if (button) button.disabled = true;
  try { await action(); } catch (error) { message(error.message || 'Please try again shortly.'); }
  finally { if (button) button.disabled = false; }
}
function discardChanges() { return !changed || confirm('Discard your unsaved page changes?'); }
async function history() {
  const result = await api(`/api/players/${player.slug}/history/`);
  const list = $('#revision-list'); list.replaceChildren();
  for (const revision of result.revisions) {
    const li = document.createElement('li');
    const text = document.createElement('span');
    text.textContent = `Revision ${revision.version} · ${new Date(revision.created).toLocaleString()} `;
    li.append(text);
    if (revision.version !== player.version) {
      const button = document.createElement('button'); button.type = 'button'; button.textContent = 'Restore';
      button.addEventListener('click', () => run(button, async () => {
        if (!discardChanges()) return;
        await api(`/api/players/${player.slug}/restore/`, 'POST', { revision: revision.id, version: player.version });
        await loadPlayer(player.slug); message('Revision restored.');
      }));
      li.append(button);
    }
    list.append(li);
  }
}
async function loadPlayer(slug) {
  if (!slug) { $('#page-editor').hidden = true; $('#page-history').hidden = true; $('#owner-identity').hidden = true; player = null; return; }
  const result = await api(`/api/players/${slug}/`);
  player = result; changed = false;
  $('#page-markdown').value = player.markdown;
  $('#view-player').href = player.url;
  $('#page-editor').hidden = false; $('#page-history').hidden = false; $('#page-preview').hidden = true;
  $('#owner-identity').hidden = !account.user.owner;
  $('#identity-name').value = player.name;
  $('#identity-edition').value = player.edition === 'bedrock' ? 'bedrock' : 'java';
  await history();
}
async function refresh(selected) {
  account = await api('/api/me/');
  $('#discord-login').hidden = Boolean(account.user) || !account.configured;
  $('#discord-logout').hidden = !account.user;
  $('#account-tools').hidden = !account.user || Boolean(account.user.denied);
  if (!account.user) { message(account.configured ? 'Sign in with Discord to edit your player page.' : 'Editing is not available yet.'); return; }
  if (account.user.denied) { message(account.error); return; }
  message(`Signed in as ${account.user.name}.`);
  const select = $('#player-select'); select.replaceChildren();
  const empty = document.createElement('option'); empty.value = ''; empty.textContent = 'Select a player'; select.append(empty);
  for (const page of account.players) { const option = document.createElement('option'); option.value = page.slug; option.textContent = page.name; select.append(option); }
  $('#no-pages').hidden = account.players.length > 0;
  $('#role-help').hidden = account.user.owner;
  const target = selected || new URL(location.href).searchParams.get('player') || (account.players.length === 1 ? account.players[0].slug : '');
  if (account.players.some(page => page.slug === target)) { select.value = target; await loadPlayer(target); }
}
$('#player-select').addEventListener('change', event => run(event.target, async () => {
  if (!discardChanges()) { event.target.value = player?.slug || ''; return; }
  await loadPlayer(event.target.value);
}));
$('#page-markdown').addEventListener('input', () => { changed = true; });
window.addEventListener('beforeunload', event => { if (changed) { event.preventDefault(); } });
$('#page-editor').addEventListener('submit', event => {
  event.preventDefault();
  run(event.submitter, async () => {
    const result = await api(`/api/players/${player.slug}/`, 'PUT', { markdown: $('#page-markdown').value, version: player.version });
    player.version = result.version; changed = false; message('Changes saved.'); await history();
  });
});
$('#preview-page').addEventListener('click', event => run(event.target, async () => {
  const preview = await api('/api/preview/', 'POST', { slug: player.slug, markdown: $('#page-markdown').value });
  // HTML comes from the server's Markdown parser with raw HTML and unsafe links disabled.
  $('#page-preview').innerHTML = preview.html; $('#page-preview').hidden = false;
}));
$('#discord-logout').addEventListener('click', event => run(event.target, async () => {
  if (!discardChanges()) return;
  await api('/auth/logout/', 'POST'); changed = false; location.reload();
}));
const newIdentity = () => ({ name: $('#new-name').value.trim(), edition: $('#new-edition').value });
for (const selector of ['#new-name', '#new-edition']) $(selector).addEventListener('input', () => { lookupResult = null; $('#new-player-preview').hidden = true; });
$('#lookup-player').addEventListener('click', event => run(event.target, async () => {
  lookupResult = await api('/api/lookup/', 'POST', newIdentity());
  $('#new-name').value = lookupResult.name;
  $('#new-player-head').src = lookupResult.preview;
  $('#new-player-name').textContent = lookupResult.name;
  $('#new-player-preview').hidden = false; message('Player found.');
}));
$('#add-player').addEventListener('submit', event => {
  event.preventDefault();
  run(event.submitter, async () => {
    if (!lookupResult || !discardChanges()) return;
    const result = await api('/api/players/', 'POST', newIdentity());
    changed = false; $('#new-player-preview').hidden = true; lookupResult = null;
    await refresh(result.slug); message('Player page created.');
  });
});
$('#identity-form').addEventListener('submit', event => {
  event.preventDefault();
  run(event.submitter, async () => {
    if (!discardChanges()) return;
    await api(`/api/players/${player.slug}/identity/`, 'POST', { name: $('#identity-name').value.trim(), edition: $('#identity-edition').value, version: player.version });
    await refresh(player.slug); message('Player name and head updated.');
  });
});
$('#head-upload').addEventListener('change', event => run(event.target, async () => {
  const file = event.target.files[0]; if (!file) return;
  if (file.size > 262144 || file.type !== 'image/png') throw new Error('Choose a PNG image smaller than 256 KB.');
  if (!discardChanges()) return;
  const data = await new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.onerror = reject; reader.readAsDataURL(file); });
  await api(`/api/players/${player.slug}/head/`, 'POST', { png: data.split(',')[1], version: player.version });
  await loadPlayer(player.slug); message('Head image updated.'); event.target.value = '';
}));
run(null, refresh);
