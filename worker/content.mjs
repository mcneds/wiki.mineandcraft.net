import MarkdownIt from 'markdown-it';

export const escape = value => String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
const markdown = new MarkdownIt({ html: false, linkify: false });
// Image links can reference an uploaded file or an HTTPS image, never executable URLs.
const validateLink = markdown.validateLink.bind(markdown);
markdown.validateLink = url => validateLink(url) && !/^data:/i.test(url);

export function render(source) {
  const tokens = markdown.parse(source, {});
  const headings = [];
  const used = new Set();
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i].type !== 'heading_open') continue;
    const text = tokens[i + 1].content;
    const base = text.toLowerCase().replace(/[^\p{L}\p{N}\s-]/gu, '').trim().replace(/\s+/g, '-') || 'section';
    let id = base;
    let suffix = 1;
    while (used.has(id)) id = `${base}-${suffix++}`;
    used.add(id);
    tokens[i].attrSet('id', id);
    if (Number(tokens[i].tag.slice(1)) <= 3) headings.push({ id, text });
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
