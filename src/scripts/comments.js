import { createApi } from './api.js';
import { commentHtml } from '../../shared/comments-render.mjs';

const section = document.querySelector('.profile-comments');
if (section) {
  const $ = selector => section.querySelector(selector);
  const form = $('#comments-form'), text = $('#comment-body'), poster = $('#comment-poster');
  const login = $('#comments-login'), refresh = $('#comments-refresh'), more = $('#comments-more');
  const endpoint = `/api/players/${section.dataset.profile}/comments/`;
  let context, page = 1, busy = false;
  const status = message => { $('#comments-status').textContent = message; };
  const api = createApi({ csrf: () => context?.user?.csrf || '', onUnauthorized: () => {
    login.hidden = false; login.target = '_blank'; login.rel = 'noopener'; refresh.hidden = false;
  } });
  function display(result, append = false) {
    if (!append) $('#comments-list').replaceChildren();
    for (const comment of result.comments) {
      if (!document.getElementById(`comment-${comment.id}`)) $('#comments-list').insertAdjacentHTML('beforeend', commentHtml(comment));
    }
    page = result.page; more.hidden = !result.hasMore;
    $('#comments-empty').hidden = Boolean($('#comments-list').children.length);
  }
  async function load(next = 1, append = false) {
    const result = await api(`${endpoint}context/?page=${next}`);
    context = result;
    const selected = poster.value;
    if (result.postingPlayers.length) poster.replaceChildren(...result.postingPlayers.map(player => new Option(player.name, player.slug)));
    if (result.postingPlayers.some(player => player.slug === selected)) poster.value = selected;
    form.hidden = !result.postingPlayers.length && !text.value.trim();
    login.hidden = Boolean(result.user); refresh.hidden = !text.value.trim() || Boolean(result.postingPlayers.length);
    if (!result.user && text.value.trim()) { login.target = '_blank'; login.rel = 'noopener'; }
    $('#comments-account').replaceChildren();
    if (result.user && !result.postingPlayers.length) {
      $('#comments-account').textContent = 'A player page and matching Discord IGN role are required to comment. ';
      const link = document.createElement('a'); link.href = '/account/'; link.textContent = 'Manage your player page'; $('#comments-account').append(link);
    }
    display(result, append);
  }
  async function run(action) {
    if (busy) return;
    busy = true;
    section.querySelectorAll('button').forEach(button => { button.disabled = true; });
    text.readOnly = true; poster.disabled = true;
    try { await action(); }
    catch (error) { status(error.message); refresh.hidden = false; }
    finally {
      busy = false; text.readOnly = false; poster.disabled = false;
      section.querySelectorAll('button').forEach(button => { button.disabled = false; });
      form.querySelector('button[type="submit"]').disabled = !context?.postingPlayers.length;
    }
  }
  form.addEventListener('submit', event => {
    event.preventDefault();
    void run(async () => {
      const comment = await api(endpoint, 'POST', { posterSlug: poster.value, body: text.value });
      text.value = '';
      // Reflect a successful write even if refreshing permissions then fails.
      $('#comments-list').insertAdjacentHTML('afterbegin', commentHtml(comment)); $('#comments-empty').hidden = true;
      status('Comment posted.');
      try { await load(); } catch { status('Comment posted. Refresh comments to load the latest list.'); refresh.hidden = false; }
    });
  });
  section.addEventListener('click', event => {
    const button = event.target.closest('.delete-comment');
    if (!button || busy || !confirm('Delete this comment?')) return;
    void run(async () => {
      const item = button.closest('.profile-comment');
      await api(`${endpoint}${item.dataset.commentId}/`, 'DELETE');
      item.remove(); status('Comment deleted.');
      $('#comments-empty').hidden = Boolean($('#comments-list').children.length);
      try { await load(); } catch { status('Comment deleted. Refresh comments to load the latest list.'); refresh.hidden = false; }
    });
  });
  more.addEventListener('click', () => { void run(async () => { await load(page + 1, true); status(''); }); });
  refresh.addEventListener('click', () => { void run(async () => { await load(); status(''); }); });
  void run(async () => {
    try { await load(); }
    catch (error) {
      // Public comments remain readable if Discord is temporarily unavailable.
      status(error.message); refresh.hidden = false;
    }
  });
}
