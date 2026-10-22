import { Editor, Node } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { Markdown } from '@tiptap/markdown';
import Image from '@tiptap/extension-image';
import { TableKit } from '@tiptap/extension-table';
import MarkdownIt from 'markdown-it';
import { video } from '../../shared/video.mjs';

const parser = new MarkdownIt({ html: false });
const htmlParser = new MarkdownIt({ html: true });
const imageMarkdown = node => {
  // The upstream image serializer does not escape labels or destinations.
  const alt = (node.attrs.alt || '').replace(/[\\[\]]/g, '\\$&').replace(/\r?\n/g, ' ');
  const src = node.attrs.src.replaceAll(' ', '%20').replaceAll('(', '%28').replaceAll(')', '%29');
  const title = node.attrs.title ? ` "${node.attrs.title.replace(/["\\]/g, '\\$&')}"` : '';
  return `![${alt}](${src}${title})`;
};
const SafeImage = Image.extend({ renderMarkdown: imageMarkdown });
const Video = Node.create({
  name: 'video', group: 'block', atom: true, priority: 1100,
  addAttributes() { return { url: { default: null } }; },
  parseHTML() { return [{ tag: 'div[data-video]', getAttrs: element => video(element.dataset.video) ? { url: video(element.dataset.video).url } : false }]; },
  renderHTML({ node }) {
    const clip = video(node.attrs.url);
    return clip ? ['div', { class: 'video-embed', 'data-video': clip.url }, ['iframe', { src: clip.embed, title: `${clip.provider} video`, loading: 'lazy', allow: 'encrypted-media; picture-in-picture; fullscreen', allowfullscreen: 'true', referrerpolicy: 'strict-origin-when-cross-origin' }]] : ['p', {}, 'Unsupported video'];
  },
  markdownTokenizer: {
    name: 'video', level: 'block', start: '[Video](',
    tokenize(source) {
      const match = source.match(/^\[Video\]\((https:\/\/[^\s)]+)\)[ \t]*(?:\n(?=\n|$)|$)/);
      return match && video(match[1]) ? { type: 'video', raw: match[0], url: match[1] } : undefined;
    },
  },
  parseMarkdown(token, helpers) { return helpers.createNode('video', { url: token.url }); },
  renderMarkdown(node) { return `[Video](${node.attrs.url})`; },
});

function safeSource(source) {
  const tokens = htmlParser.parse(source, {});
  return !tokens.some(token => token.type === 'html_block' || token.children?.some(child => child.type === 'html_inline'));
}
// Check using the reader's parser, rather than silently trusting a different
// Markdown parser. If meaning changes, retain the exact Markdown draft.
const canonical = source => parser.render(source).replace(/<p>(?:&nbsp;|\u00a0)<\/p>\n/g, '').trim();

export function createVisual(element, onChange, onFiles, onSelection) {
  const editor = new Editor({
    element,
    extensions: [StarterKit.configure({ underline: false, trailingNode: false, link: { openOnClick: false, autolink: false, defaultProtocol: 'https' } }), Markdown, SafeImage.configure({ allowBase64: false }), TableKit, Video],
    editorProps: {
      attributes: { role: 'textbox', 'aria-label': 'Page text (Visual)', 'aria-multiline': 'true', class: 'article-body' },
      handlePaste(_view, event) { const files = [...(event.clipboardData?.files || [])]; if (!files.length) return false; event.preventDefault(); onFiles(files); return true; },
      handleDrop(view, event) {
        const files = [...(event.dataTransfer?.files || [])]; if (!files.length) return false;
        event.preventDefault(); const position = view.posAtCoords({ left: event.clientX, top: event.clientY });
        if (position) editor.commands.setTextSelection(position.pos);
        onFiles(files); return true;
      },
    },
    onUpdate: () => onChange(),
    onSelectionUpdate: () => onSelection?.(),
  });
  return {
    editor,
    load(source) {
      if (!safeSource(source)) return false;
      try {
        const document = editor.markdown.parse(source);
        const output = editor.markdown.serialize(document);
        if (canonical(source) !== canonical(output)) return false;
        // Recreate the state so undo cannot restore another player's page.
        editor.commands.setContent(document, { emitUpdate: false });
        const state = editor.state;
        editor.view.updateState(state.constructor.create({ schema: state.schema, doc: state.doc, plugins: state.plugins }));
        return true;
      } catch { return false; }
    },
    source() {
      const source = editor.getMarkdown();
      if (!safeSource(source)) throw new Error('This formatting cannot be saved as Markdown. Undo the last change or simplify overlapping text styles.');
      return source;
    },
    image(attrs) { return editor.chain().focus().setImage(attrs).run(); },
    video(url) { return editor.chain().focus().insertContent({ type: 'video', attrs: { url } }).run(); },
  };
}
