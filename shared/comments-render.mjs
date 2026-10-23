const escape = value => String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);

export function commentHtml(comment) {
  return `<li class="profile-comment" id="comment-${escape(comment.id)}" data-comment-id="${escape(comment.id)}"><header><a href="/wiki/players/${escape(comment.poster.slug)}/">${escape(comment.poster.name)}</a> <time datetime="${escape(comment.created)}">${escape(comment.created.slice(0, 16).replace('T', ' '))} UTC</time></header><p>${escape(comment.body)}</p>${comment.canDelete ? '<button type="button" class="delete-comment">Delete comment</button>' : ''}</li>`;
}

export function commentsSection(slug, result) {
  return `<section class="profile-comments" data-profile="${escape(slug)}" aria-labelledby="comments-heading" data-pagefind-ignore>
    <h2 id="comments-heading">Comments</h2>
    <p id="comments-empty"${result.comments.length ? ' hidden' : ''}>No comments yet.</p>
    <ol id="comments-list">${result.comments.map(commentHtml).join('')}</ol>
    <button id="comments-more" type="button"${result.hasMore ? '' : ' hidden'}>Older comments</button>
    <p id="comments-account"></p>
    <a id="comments-login" href="/auth/login/?returnTo=${encodeURIComponent(`/wiki/players/${slug}/`)}">Sign in with Discord to comment</a>
    <button id="comments-refresh" type="button" hidden>Check comment access</button>
    <form id="comments-form" hidden>
      <label for="comment-poster">Comment as</label><select id="comment-poster" name="posterSlug" required></select>
      <label for="comment-body">Comment</label><textarea id="comment-body" name="body" rows="4" maxlength="2000" required></textarea>
      <button type="submit">Post comment</button>
    </form>
    <p id="comments-status" role="status" aria-live="polite"></p>
    <noscript><p>Posting comments requires JavaScript.</p></noscript>
  </section>`;
}
