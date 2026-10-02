// Markdown → HTML for prose and wiki pages, with book typography and link rewriting.
import { Marked } from "marked";

export const escapeHtml = (s) =>
  String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

// Called for every link; returns a new href, or null to render the link text unlinked.
let resolveLink = (href) => href;

const marked = new Marked({
  gfm: true,
  renderer: {
    link({ href, title, tokens }) {
      const text = this.parser.parseInline(tokens);
      const target = resolveLink(href);
      if (target == null) return text;
      const external = /^https?:/i.test(target);
      return `<a href="${escapeHtml(target)}"${title ? ` title="${escapeHtml(title)}"` : ""}${external ? ' rel="noopener"' : ""}>${text}</a>`;
    },
    // Raw HTML in the source is shown as text; comments are dropped.
    html({ text }) {
      return /^\s*<!--[\s\S]*-->\s*$/.test(text) ? "" : escapeHtml(text);
    },
  },
});

// Curly quotes, dashes and ellipses applied to text between tags, never inside <code>/<pre>.
// Quote direction looks at the previous character even across tags, so "*word*" pairs correctly.
function typeset(html) {
  let prev = " ";
  let codeDepth = 0;
  return html
    .split(/(<[^>]+>)/)
    .map((part) => {
      if (part.startsWith("<")) {
        if (/^<(code|pre)\b/i.test(part)) codeDepth++;
        else if (/^<\/(code|pre)>/i.test(part)) codeDepth--;
        else if (/^<(p|li|h\d|td|th|blockquote|br)\b/i.test(part)) prev = " ";
        return part;
      }
      if (codeDepth > 0 || !part) return part;
      let out = "";
      const text = part.replace(/&quot;/g, '"').replace(/&#39;/g, "'");
      for (let i = 0; i < text.length; i++) {
        const c = text[i];
        if (c === '"' || c === "'") {
          const opening = /[\s([{—–\-“‘/]/.test(prev);
          out += c === '"' ? (opening ? "“" : "”") : (opening ? "‘" : "’");
        } else out += c;
        prev = c;
      }
      return out.replace(/(^|[^-])---?(?!-)/g, "$1—").replace(/\.\.\./g, "…");
    })
    .join("");
}

export function renderMarkdown(src, { link = (href) => href } = {}) {
  resolveLink = link;
  try {
    return typeset(marked.parse(src))
      .replace(/<table>/g, '<div class="table-wrap"><table>')
      .replace(/<\/table>/g, "</table></div>");
  } finally {
    resolveLink = (href) => href;
  }
}

export function plainText(src) {
  return typeset(escapeHtml(src));
}
