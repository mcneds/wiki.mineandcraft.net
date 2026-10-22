import MarkdownIt from 'markdown-it';
import { video } from '../shared/video.mjs';

export const escape = value => String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
const markdown = new MarkdownIt({ html: false, linkify: false });
// Image links can reference an uploaded file or an HTTPS image, never executable URLs.
const validateLink = markdown.validateLink.bind(markdown);
markdown.validateLink = url => validateLink(url) && !/^data:/i.test(url);

export function mediaReferences(source) {
  const ids = new Set();
  // Use parsed destinations so escaped slashes, reference links, and entities
  // cannot evade the database's reference/deletion interlock.
  for (const token of markdown.parse(source, {})) for (const child of token.children || []) {
    const destination = child.type === 'image' ? child.attrGet('src') : child.type === 'link_open' ? child.attrGet('href') : null;
    if (!destination) continue;
    try {
      const match = new URL(destination, 'https://wiki.mineandcraft.net').pathname.match(/^\/media\/([a-f0-9-]{36})$/);
      if (match) ids.add(match[1]);
    } catch { /* Not a URL. */ }
  }
  return [...ids];
}

function headingText(tokens) {
  return tokens.map(token => {
    if (token.children) return headingText(token.children);
    if (token.type === 'text' || token.type === 'code_inline') return token.content;
    if (token.type === 'softbreak' || token.type === 'hardbreak') return ' ';
    return '';
  }).join('');
}

export function render(source) {
  const tokens = markdown.parse(source, {});
  for (let i = 0; i < tokens.length - 2; i++) {
    const children = tokens[i + 1].children;
    if (tokens[i].type !== 'paragraph_open' || tokens[i + 2].type !== 'paragraph_close' || children?.length !== 3 || children[0].type !== 'link_open' || children[1].type !== 'text' || children[1].content !== 'Video' || children[2].type !== 'link_close') continue;
    const clip = video(children[0].attrGet('href'));
    if (!clip) continue;
    tokens[i].type = 'html_block';
    tokens[i].content = `<div class="video-embed"><iframe src="${escape(clip.embed)}" title="${clip.provider} video" loading="lazy" allow="accelerometer; encrypted-media; gyroscope; picture-in-picture; fullscreen" allowfullscreen referrerpolicy="strict-origin-when-cross-origin"></iframe></div>\n`;
    tokens.splice(i + 1, 2);
  }
  const headings = [];
  const used = new Set();
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i].type !== 'heading_open') continue;
    const inline = tokens[i + 1];
    // Keep existing anchors; contents labels use decoded, unformatted text.
    const base = inline.content.toLowerCase().replace(/[^\p{L}\p{N}\s-]/gu, '').trim().replace(/\s+/g, '-') || 'section';
    let id = base;
    let suffix = 1;
    while (used.has(id)) id = `${base}-${suffix++}`;
    used.add(id);
    tokens[i].attrSet('id', id);
    if (Number(tokens[i].tag.slice(1)) <= 3) headings.push({ id, text: headingText(inline.children || []) });
  }
  return { html: markdown.renderer.render(tokens, markdown.options, {}), headings };
}

export const playerUrl = player => `/wiki/players/${player.slug}/`;
export const description = player => `${player.name}'s player page on mineandcraft.net.`;
export const card = player => `<a class="player-card" href="${playerUrl(player)}"><img src="${escape(player.image)}" alt="${escape(player.name)}'s Minecraft head" width="110" height="110" loading="lazy"><strong>${escape(player.name)}</strong><small>Read player page →</small></a>`;
export const tile = player => `<a class="profile-tile" href="${playerUrl(player)}" title="${escape(player.name)}"><img src="${escape(player.image)}" width="56" height="56" alt="${escape(player.name)}'s Minecraft head" loading="lazy"><span>${escape(player.name)}</span></a>`;

export function article(player) {
  const body = render(player.markdown);
  return `<article data-pagefind-body><div class="page-kicker"><a href="/">Main page</a> / <a href="/category/players/">Players</a></div>
    <header class="page-heading"><h1>${escape(player.name)}</h1></header>
    <div class="article-layout"><div class="article-body">${body.html}</div><aside class="article-rail">
    <section class="infobox"><h2>${escape(player.name)}</h2><img class="player-head" src="${escape(player.image)}" alt="${escape(player.name)}'s Minecraft head" width="200" height="200"></section>
    ${body.headings.length ? `<nav class="contents" aria-label="Article contents"><h2>CONTENTS</h2><ol>${body.headings.map(heading => `<li><a href="#${heading.id}">${escape(heading.text)}</a></li>`).join('')}</ol></nav>` : ''}
    <p class="article-meta">Last updated<br><time datetime="${escape(player.updated)}">${escape(player.updated.slice(0, 10))}</time></p>
    </aside></div><div class="category-footer"><span>Category:</span><a href="/category/players/">Players</a></div></article>`;
}
