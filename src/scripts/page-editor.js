import { video } from '../../shared/video.mjs';

export function createPageEditor({ api, context, dirty, message, refreshSession }) {
  const $ = selector => document.querySelector(selector);
  const textarea = $('#page-markdown');
  let visual, modulePromise, mode = 'markdown', visualChanged = false, generation = 0, uploading = false;
  let pendingUpload, retryTimer;
  const notice = text => { $('#editor-notice').textContent = text; $('#editor-notice').hidden = !text; };
  const getSource = () => {
    if (mode === 'visual' && visualChanged) textarea.value = visual.source();
    return textarea.value;
  };
  function setMode(next) {
    mode = next;
    for (const name of ['visual', 'markdown']) {
      const tab = $(`#mode-${name}`);
      tab.setAttribute('aria-selected', String(name === mode)); tab.tabIndex = name === mode ? 0 : -1;
      $(`#${name}-panel`).hidden = name !== mode;
    }
  }
  function selection() {
    if (!visual) return;
    const editor = visual.editor;
    for (const button of document.querySelectorAll('[data-command][aria-pressed]')) button.setAttribute('aria-pressed', String(editor.isActive(button.dataset.command)));
    const level = editor.getAttributes('heading').level;
    $('#block-format').value = level ? String(level) : 'paragraph';
    $('[data-command="undo"]').disabled = !editor.can().undo();
    $('[data-command="redo"]').disabled = !editor.can().redo();
  }
  async function activate(source, token) {
    try {
      modulePromise ||= import('./visual-editor.js');
      const { createVisual } = await modulePromise;
      if (token !== generation) return;
      visual ||= createVisual($('#visual-editor'), () => { visualChanged = true; dirty(); selection(); }, files => uploadFiles(files), selection);
      if (!visual.load(source)) {
        setMode('markdown'); notice('This draft uses formatting that Visual cannot preserve. Edit it in Markdown.'); return;
      }
      visualChanged = false; setMode('visual'); notice(''); selection();
    } catch {
      setMode('markdown'); notice('Visual could not load. You can keep editing in Markdown.');
    }
  }
  async function load(source) {
    pendingUpload = null; clearTimeout(retryTimer);
    $('#retry-upload').hidden = true; $('#media-sign-in').hidden = true;
    $('#image-upload').value = ''; $('#upload-status').textContent = '';
    const token = ++generation;
    textarea.value = source; visualChanged = false;
    setMode('markdown'); notice('Loading Visual editor…');
    await activate(source, token);
  }
  $('#mode-markdown').addEventListener('click', () => {
    try { ++generation; getSource(); setMode('markdown'); notice(''); }
    catch (error) { message(error.message); }
  });
  $('#mode-visual').addEventListener('click', () => {
    if (mode === 'visual') return;
    const token = ++generation; activate(textarea.value, token);
  });
  document.querySelector('.editor-modes').addEventListener('keydown', event => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault(); const next = event.key === 'Home' ? 'visual' : event.key === 'End' ? 'markdown' : mode === 'visual' ? 'markdown' : 'visual';
    $(`#mode-${next}`).click(); $(`#mode-${next}`).focus();
  });
  textarea.addEventListener('input', dirty);
  textarea.addEventListener('paste', event => {
    const files = [...(event.clipboardData?.files || [])]; if (files.length) { event.preventDefault(); uploadFiles(files); }
  });
  textarea.addEventListener('dragover', event => { if (event.dataTransfer?.types.includes('Files')) event.preventDefault(); });
  textarea.addEventListener('drop', event => { const files = [...(event.dataTransfer?.files || [])]; if (files.length) { event.preventDefault(); uploadFiles(files); } });
  for (const button of document.querySelectorAll('[data-command]')) {
    button.addEventListener('mousedown', event => event.preventDefault());
    button.addEventListener('click', () => {
      const command = button.dataset.command;
      const chain = visual.editor.chain().focus();
      const commands = { bold: 'toggleBold', italic: 'toggleItalic', strike: 'toggleStrike', bulletList: 'toggleBulletList', orderedList: 'toggleOrderedList', blockquote: 'toggleBlockquote', code: 'toggleCode', codeBlock: 'toggleCodeBlock', undo: 'undo', redo: 'redo' };
      chain[commands[command]]().run(); selection();
    });
  }
  $('#block-format').addEventListener('change', event => {
    const chain = visual.editor.chain().focus();
    if (event.target.value === 'paragraph') chain.setParagraph().run();
    else chain.setHeading({ level: Number(event.target.value) }).run();
    selection();
  });
  for (const button of document.querySelectorAll('[data-close]')) button.addEventListener('click', () => $(`#${button.dataset.close}`).close());
  $('#edit-link').addEventListener('click', () => {
    $('#link-url').value = visual.editor.getAttributes('link').href || '';
    $('#link-dialog').showModal();
  });
  $('#link-form').addEventListener('submit', event => {
    event.preventDefault(); const url = $('#link-url').value;
    if (!/^https?:\/\//i.test(url)) { $('#link-url').setCustomValidity('Use an http or https URL.'); $('#link-url').reportValidity(); return; }
    visual.editor.chain().focus().extendMarkRange('link').setLink({ href: url }).run(); $('#link-dialog').close();
  });
  $('#link-url').addEventListener('input', () => $('#link-url').setCustomValidity(''));
  $('#remove-link').addEventListener('click', () => { visual.editor.chain().focus().extendMarkRange('link').unsetLink().run(); $('#link-dialog').close(); });

  function insertSource(text) {
    textarea.setRangeText(text, textarea.selectionStart, textarea.selectionEnd, 'end'); dirty();
  }
  const safeImageUrl = value => /^https:\/\/[^\s<>]+$/i.test(value) || /^\/media\/[a-f0-9-]{36}$/.test(value);
  function insertImage(url, alt) {
    if (!safeImageUrl(url)) throw new Error('Use an HTTPS image URL.');
    if (mode === 'visual') {
      if (!visual.image({ src: url, alt })) throw new Error('Move the cursor outside the code block or table and retry inserting the image.');
    }
    else insertSource(`\n\n![${alt.replace(/[\\[\]]/g, '\\$&').replace(/\r?\n/g, ' ')}](${url.replaceAll('(', '%28').replaceAll(')', '%29')})\n\n`);
  }
  $('#edit-video').addEventListener('click', () => { $('#video-error').textContent = ''; $('#video-dialog').showModal(); });
  $('#video-form').addEventListener('submit', event => {
    event.preventDefault(); const clip = video($('#video-url').value.trim());
    if (!clip) { $('#video-error').textContent = 'Enter a YouTube or Vimeo video URL.'; return; }
    if (mode === 'visual') visual.video(clip.url);
    else insertSource(`\n\n[Video](${clip.url})\n\n`);
    $('#video-dialog').close(); $('#video-url').value = '';
  });
  function showUsage(usage) { $('#media-usage').textContent = `${(usage.used / 1048576).toFixed(1)} MB of 50 MB used`; }
  async function library() {
    const slug = context().player?.slug;
    if (!slug) return;
    const result = await api(`/api/players/${slug}/images/`);
    if (slug !== context().player?.slug) return;
    showUsage(result.usage);
    const list = $('#image-library'); list.replaceChildren();
    if (!result.images.length) { const item = document.createElement('li'); item.textContent = 'No uploads yet.'; list.append(item); }
    for (const image of result.images) {
      const item = document.createElement('li'), thumbnail = document.createElement('img'), name = document.createElement('span'), actions = document.createElement('div');
      thumbnail.src = image.url; thumbnail.alt = ''; thumbnail.loading = 'lazy';
      name.textContent = `${image.name} (${(image.size / 1048576).toFixed(2)} MB)`;
      actions.className = 'editor-actions';
      const insert = document.createElement('button'); insert.type = 'button'; insert.textContent = 'Insert';
      insert.addEventListener('click', () => { insertImage(image.url, $('#image-alt').value || image.name); $('#image-dialog').close(); });
      const remove = document.createElement('button'); remove.type = 'button'; remove.textContent = 'Delete';
      remove.addEventListener('click', async () => {
        if (getSource().includes(image.url)) { $('#media-status').textContent = 'Remove this image from your draft before deleting it.'; return; }
        if (!confirm('Delete this image permanently? Older revisions containing it will lose the image.')) return;
        remove.disabled = true;
        try { await api(`/api/players/${slug}/images/${image.id}/`, 'DELETE'); await library(); $('#media-status').textContent = 'Image deleted.'; }
        catch (error) { $('#media-status').textContent = error.message; }
        finally { remove.disabled = false; }
      });
      actions.append(insert, remove); item.append(thumbnail, name, actions); list.append(item);
    }
  }
  $('#edit-images').addEventListener('click', async () => {
    $('#media-status').textContent = ''; $('#media-usage').textContent = '';
    const selected = mode === 'visual' && visual.editor.isActive('image');
    $('#update-image').hidden = !selected;
    $('#image-alt').value = selected ? visual.editor.getAttributes('image').alt || '' : '';
    $('#image-dialog').showModal();
    try { await library(); } catch (error) { $('#media-status').textContent = error.message; }
  });
  $('#update-image').addEventListener('click', () => {
    visual.editor.chain().focus().updateAttributes('image', { alt: $('#image-alt').value }).run(); $('#image-dialog').close();
  });
  $('#image-url-form').addEventListener('submit', event => {
    event.preventDefault();
    try { insertImage($('#image-url').value.trim(), $('#image-alt').value); $('#image-url').value = ''; $('#image-dialog').close(); }
    catch (error) { $('#media-status').textContent = error.message; }
  });
  async function uploadFiles(files) {
    if (uploading) { message('Wait for the current upload to finish.'); return; }
    if (files && !files.length) return;
    const { player } = context();
    if (!player) return;
    if (files) pendingUpload = { slug: player.slug, files: files.map(file => ({ file })), needsSignIn: false };
    if (!pendingUpload?.files.length || pendingUpload.slug !== player.slug) return;
    clearTimeout(retryTimer); $('#retry-upload').hidden = true; $('#media-sign-in').hidden = true;
    uploading = true; $('#image-upload').disabled = true;
    const progress = $('#upload-progress'); progress.hidden = false; progress.removeAttribute('value');
    try {
      if (pendingUpload.needsSignIn) { await refreshSession(); pendingUpload.needsSignIn = false; }
      while (pendingUpload.files.length) {
        const entry = pendingUpload.files[0], { file } = entry;
        if (!['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(file.type) || file.size > 5242880 || !file.size) throw Object.assign(new Error('Choose a PNG, JPEG, WebP, or GIF image up to 5 MB.'), { status: 415 });
        $('#media-status').textContent = ''; $('#upload-status').textContent = `Uploading ${file.name}…`; message('Uploading image…');
        const body = new FormData(); body.append('file', file);
        // If storage succeeded but insertion failed, retry insertion without
        // storing another copy of an already confirmed upload.
        const result = entry.result ||= await api(`/api/players/${player.slug}/images/`, 'POST', body, { onProgress: (loaded, total) => {
          if (!total) return;
          const percent = Math.min(100, Math.round(loaded / total * 100)); progress.value = percent;
          $('#upload-status').textContent = percent === 100 ? `Saving ${file.name}…` : `Uploading ${file.name}: ${percent}%`;
        } });
        if (context().player?.slug !== player.slug) return;
        insertImage(result.image.url, $('#image-alt').value || file.name);
        pendingUpload.files.shift();
        showUsage(result.usage); message('Image uploaded. Save your page to publish the change.');
      }
      pendingUpload = null; $('#image-upload').value = '';
      $('#upload-status').textContent = 'Image uploaded.'; $('#media-status').textContent = ''; $('#image-dialog').close();
    } catch (error) {
      message(error.message); $('#upload-status').textContent = error.message;
      if (!$('#image-dialog').open) $('#image-dialog').showModal();
      pendingUpload.needsSignIn = error.status === 401 || pendingUpload.needsSignIn;
      $('#media-sign-in').hidden = !pendingUpload.needsSignIn;
      $('#retry-upload').hidden = [400, 413, 415].includes(error.status);
      $('#retry-upload').disabled = Boolean(error.retryAfter);
      if (error.retryAfter) retryTimer = setTimeout(() => { $('#retry-upload').disabled = false; }, Math.min(error.retryAfter, 86400) * 1000);
      // Keep validation feedback next to the picker as well as the upload
      // status. The selected File remains in memory for an explicit retry.
      $('#media-status').textContent = error.message;
    }
    finally { uploading = false; $('#image-upload').disabled = false; progress.hidden = true; }
  }
  $('#image-upload').addEventListener('change', event => uploadFiles([...event.target.files]));
  $('#retry-upload').addEventListener('click', () => uploadFiles());
  return { load, source: getSource, busy: () => uploading };
}
