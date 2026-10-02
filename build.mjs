// Builds the reading site into _site/ from novel.json and chapters/*.md.
// Zero dependencies: run with `node build.mjs`.
import { readFileSync, readdirSync, mkdirSync, writeFileSync, cpSync, rmSync } from "node:fs";
import { join } from "node:path";

const OUT = "_site";
const novel = JSON.parse(readFileSync("novel.json", "utf8"));

// ---------- Markdown (prose subset) ----------

const escape = (s) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

// Curly quotes and dashes, so plain-typed prose reads like a printed book.
const smarten = (s) =>
  s
    .replace(/(^|[\s(\[{—–-])"/g, "$1“").replace(/"/g, "”")
    .replace(/(^|[\s(\[{—–-])'/g, "$1‘").replace(/'/g, "’")
    .replace(/---?/g, "—")
    .replace(/\.\.\./g, "…");

function inline(text) {
  // Keep `code` spans verbatim; format everything around them.
  return text
    .split(/(`[^`]+`)/)
    .map((part, i) => (i % 2 ? `<code>${escape(part.slice(1, -1))}</code>` : formatText(part)))
    .join("");
}

function formatText(text) {
  return escape(smarten(text))
    .replace(/\*\*\*(.+?)\*\*\*/g, "<strong><em>$1</em></strong>")
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[^\w*])\*(?!\s)(.+?)\*(?!\w)/g, "$1<em>$2</em>")
    .replace(/(^|[^\w])_(?!\s)(.+?)_(?!\w)/g, "$1<em>$2</em>")
    .replace(/ {2,}\n|\\\n/g, "<br>\n");
}

function markdown(src) {
  const blocks = src.replace(/\r\n/g, "\n").trim().split(/\n\s*\n/);
  return blocks
    .map((block) => {
      const b = block.trim();
      if (/^(\*\s*){3,}$|^(-\s*){3,}$|^#$/.test(b)) return '<hr class="scene-break">';
      const h = b.match(/^(#{2,4})\s+(.*)$/);
      if (h) return `<h${h[1].length}>${inline(h[2])}</h${h[1].length}>`;
      if (b.startsWith(">")) {
        const inner = b.split("\n").map((l) => l.replace(/^>\s?/, "")).join("\n");
        return `<blockquote>${markdown(inner)}</blockquote>`;
      }
      return `<p>${inline(b)}</p>`;
    })
    .join("\n");
}

function parseChapter(file) {
  const raw = readFileSync(join("chapters", file), "utf8");
  const m = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  const meta = {};
  if (m) for (const line of m[1].split("\n")) {
    const kv = line.match(/^(\w+):\s*(.*)$/);
    if (kv) meta[kv[1]] = kv[2].replace(/^["']|["']$/g, "");
  }
  const body = m ? m[2] : raw;
  const words = body.split(/\s+/).filter(Boolean).length;
  return {
    slug: file.replace(/\.md$/, ""),
    title: meta.title || file.replace(/\.md$/, ""),
    label: meta.label || (meta.number ? `Chapter ${meta.number}` : ""),
    html: markdown(body),
    words,
    minutes: Math.max(1, Math.round(words / 230)),
  };
}

// ---------- Templates ----------

const ICONS = {
  type: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7V5h16v2M9 19h6M12 5v14"/></svg>',
  list: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01"/></svg>',
  left: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 18l-6-6 6-6"/></svg>',
  right: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 18l6-6-6-6"/></svg>',
};

const settingsPanel = `
<div class="settings" id="settings" hidden>
  <div class="setting">
    <span class="setting-label">Theme</span>
    <div class="seg" role="group" aria-label="Theme">
      <button data-set="theme" data-value="light" class="swatch swatch-light" aria-label="Light"></button>
      <button data-set="theme" data-value="sepia" class="swatch swatch-sepia" aria-label="Sepia"></button>
      <button data-set="theme" data-value="dark" class="swatch swatch-dark" aria-label="Dark"></button>
      <button data-set="theme" data-value="auto" class="swatch swatch-auto" aria-label="Match system">A</button>
    </div>
  </div>
  <div class="setting">
    <span class="setting-label">Size</span>
    <div class="seg" role="group" aria-label="Text size">
      <button data-step="size" data-dir="-1" aria-label="Smaller text"><span class="aa-sm">A</span></button>
      <output id="size-out">100%</output>
      <button data-step="size" data-dir="1" aria-label="Larger text"><span class="aa-lg">A</span></button>
    </div>
  </div>
  <div class="setting">
    <span class="setting-label">Font</span>
    <div class="seg" role="group" aria-label="Font">
      <button data-set="font" data-value="serif" class="font-serif">Serif</button>
      <button data-set="font" data-value="sans" class="font-sans">Sans</button>
    </div>
  </div>
  <div class="setting">
    <span class="setting-label">Width</span>
    <div class="seg" role="group" aria-label="Line width">
      <button data-set="width" data-value="narrow">Narrow</button>
      <button data-set="width" data-value="normal">Normal</button>
      <button data-set="width" data-value="wide">Wide</button>
    </div>
  </div>
</div>`;

function layout({ title, description, body, bodyClass = "" }) {
  return `<!doctype html>
<html lang="${novel.lang || "en"}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escape(title)}</title>
<meta name="description" content="${escape(description)}">
<meta name="theme-color" content="#fbfaf7">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Literata:ital,opsz,wght@0,7..72,400;0,7..72,600;1,7..72,400&family=Inter:wght@400;500;600&display=swap">
<link rel="stylesheet" href="assets/style.css">
<script>
  // Apply saved reading preferences before first paint to avoid a flash.
  try { const p = JSON.parse(localStorage.getItem("reader-prefs") || "{}");
    const d = document.documentElement;
    if (p.theme && p.theme !== "auto") d.dataset.theme = p.theme;
    if (p.font) d.dataset.font = p.font;
    if (p.width) d.dataset.width = p.width;
    if (p.size) d.style.setProperty("--scale", p.size / 100);
  } catch (e) {}
</script>
</head>
<body class="${bodyClass}">
${body}
<script src="assets/reader.js" defer></script>
</body>
</html>
`;
}

function topbar(left) {
  return `
<header class="topbar" id="topbar">
  <div class="topbar-inner">
    ${left}
    <div class="topbar-actions">
      <button class="icon-btn" id="settings-toggle" aria-label="Reading settings" aria-expanded="false" aria-controls="settings">${ICONS.type}</button>
    </div>
  </div>
  ${settingsPanel}
  <div class="progress" aria-hidden="true"><div class="progress-bar" id="progress"></div></div>
</header>`;
}

function indexPage(chapters) {
  const totalWords = chapters.reduce((n, c) => n + c.words, 0);
  const list = chapters
    .map(
      (c) => `
      <li><a class="toc-item" href="${c.slug}.html" data-slug="${c.slug}">
        <span class="toc-label">${escape(c.label)}</span>
        <span class="toc-title">${escape(c.title)}</span>
        <span class="toc-meta">${c.minutes} min</span>
      </a></li>`
    )
    .join("");
  const body = `
${topbar(`<a class="brand" href="index.html">${escape(novel.title)}</a>`)}
<main class="home">
  <section class="hero">
    <h1 class="hero-title">${escape(novel.title)}</h1>
    ${novel.subtitle ? `<p class="hero-subtitle">${escape(novel.subtitle)}</p>` : ""}
    ${novel.author ? `<p class="hero-author">by ${escape(novel.author)}</p>` : ""}
    ${novel.description ? `<p class="hero-desc">${escape(novel.description)}</p>` : ""}
    <div class="hero-actions">
      ${chapters.length ? `<a class="btn btn-primary" href="${chapters[0].slug}.html">Start reading</a>` : ""}
      <a class="btn btn-ghost" id="resume" href="#" hidden>Continue <span id="resume-title"></span></a>
    </div>
  </section>
  <section class="toc" aria-labelledby="toc-heading">
    <div class="toc-head">
      <h2 id="toc-heading">Chapters</h2>
      <span class="toc-count">${chapters.length} ${chapters.length === 1 ? "chapter" : "chapters"} · ${totalWords.toLocaleString("en")} words</span>
    </div>
    <ol class="toc-list">${list}
    </ol>
  </section>
</main>
<footer class="site-footer">© ${new Date().getFullYear()} ${escape(novel.author || "")}</footer>`;
  return layout({ title: novel.title, description: novel.description || novel.title, body, bodyClass: "page-home" });
}

function chapterPage(c, prev, next) {
  const nav = `
  <nav class="chapter-nav" aria-label="Chapter navigation">
    ${prev ? `<a class="nav-link prev" href="${prev.slug}.html" rel="prev">${ICONS.left}<span><small>Previous</small>${escape(prev.title)}</span></a>` : "<span></span>"}
    ${next ? `<a class="nav-link next" href="${next.slug}.html" rel="next"><span><small>Next</small>${escape(next.title)}</span>${ICONS.right}</a>` : `<a class="nav-link next" href="index.html"><span><small>The end — for now</small>Back to contents</span>${ICONS.list}</a>`}
  </nav>`;
  const body = `
${topbar(`<a class="brand" href="index.html" aria-label="Contents">${ICONS.list}<span>${escape(novel.title)}</span></a>`)}
<main class="reader" data-slug="${c.slug}" data-title="${escape(c.title)}">
  <header class="chapter-head">
    ${c.label ? `<p class="chapter-label">${escape(c.label)}</p>` : ""}
    <h1 class="chapter-title">${escape(c.title)}</h1>
    <p class="chapter-meta">${c.minutes} min read</p>
  </header>
  <article class="prose">
${c.html}
  </article>
  ${nav}
</main>`;
  return layout({
    title: `${c.title} · ${novel.title}`,
    description: `${c.label ? c.label + ": " : ""}${c.title} — ${novel.title}`,
    body,
    bodyClass: "page-chapter",
  });
}

// ---------- Build ----------

const chapters = readdirSync("chapters").filter((f) => f.endsWith(".md")).sort().map(parseChapter);

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
cpSync("assets", join(OUT, "assets"), { recursive: true });
writeFileSync(join(OUT, ".nojekyll"), "");
writeFileSync(join(OUT, "index.html"), indexPage(chapters));
chapters.forEach((c, i) => writeFileSync(join(OUT, `${c.slug}.html`), chapterPage(c, chapters[i - 1], chapters[i + 1])));

console.log(`Built ${chapters.length} chapter(s) into ${OUT}/`);
