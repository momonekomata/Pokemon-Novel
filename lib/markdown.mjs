// Markdown → HTML for prose and wiki pages, with book typography and link rewriting.
import { Marked } from "marked";

export const escapeHtml = (s) =>
  String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

// Called for every link; returns a new href, or null to render the link text unlinked.
let resolveLink = (href) => href;
// Called for every image; returns { src, full, width, height }, or null to drop the image.
let resolveImage = () => null;

// Alt text and tooltips can't hold formatting, so *emphasis* markers are dropped there.
const plain = (s) => (s || "").replace(/(\*\*|__|\*|_|`|~~)(.+?)\1/g, "$2");

function imageTag({ href, title, text }) {
  const img = resolveImage(href);
  if (!img) return "";
  const size = img.width ? ` width="${img.width}" height="${img.height}"` : "";
  return `<img src="${escapeHtml(img.src)}" data-full="${escapeHtml(img.full)}" alt="${escapeHtml(plain(text))}"${size} loading="lazy" decoding="async"${title ? ` title="${escapeHtml(plain(title))}"` : ""}>`;
}

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
    image(token) {
      return imageTag(token);
    },
    // A paragraph holding only images becomes full-width illustration plates, light-novel style.
    paragraph({ tokens }) {
      const parts = tokens.filter((t) => !(t.type === "text" && !t.text.trim()) && t.type !== "br");
      if (!parts.length || !parts.every((t) => t.type === "image")) return false;
      return parts
        .map((t) => {
          const tag = imageTag(t);
          if (!tag) return "";
          const full = tag.match(/data-full="([^"]*)"/)[1];
          return `<figure class="illust"><a class="illust-link" href="${full}">${tag}</a>${t.title ? `<figcaption>${marked.parseInline(t.title)}</figcaption>` : ""}</figure>\n`;
        })
        .join("");
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

// Obsidian embeds: ![[file.png]], and ![[file.png|Caption]] which shows the text as a caption under
// the picture (and as its description for screen readers). A bare number after | is a width; ignored.
const obsidianEmbeds = (src) =>
  src.replace(/!\[\[([^\]|]+?)(?:\|([^\]]*))?\]\]/g, (_, file, extra) => {
    const caption = extra && !/^\d+(x\d+)?$/.test(extra.trim()) ? extra.trim().replace(/[[\]]/g, "") : "";
    return caption ? `![${caption}](<${file.trim()}> "${caption.replace(/(["\\])/g, "\\$1")}")` : `![](<${file.trim()}>)`;
  });

export function renderMarkdown(src, { link = (href) => href, image = () => null } = {}) {
  resolveLink = link;
  resolveImage = image;
  try {
    return typeset(marked.parse(obsidianEmbeds(src)))
      .replace(/<table>/g, '<div class="table-wrap"><table>')
      .replace(/<\/table>/g, "</table></div>");
  } finally {
    resolveLink = (href) => href;
    resolveImage = () => null;
  }
}

export function plainText(src) {
  return typeset(escapeHtml(src));
}
