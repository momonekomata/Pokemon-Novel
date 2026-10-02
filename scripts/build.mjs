// Builds the site into _site/ from content/ (mirrored from Google Drive by sync-drive.mjs).
//   Reader tier: chapters, side stories, latest updates, and the character/world wiki.
//   Author tier: the full wiki and reference files, encrypted with AUTHOR_PASSWORD.
import { copyFileSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, posix } from "node:path";
import { loadContent, isReaderPage, stripAuthorNotes, sha256 } from "../lib/content.mjs";
import { escapeHtml as esc, renderMarkdown } from "../lib/markdown.mjs";
import { deriveKey, encrypt, KDF_ITERATIONS } from "../lib/vault.mjs";

const OUT = process.env.OUT_DIR || "_site";
const CONTENT = process.env.CONTENT_DIR || "content";
const UPDATES = process.env.UPDATES_FILE || "data/updates.json";
const config = JSON.parse(readFileSync("site.config.json", "utf8"));

if (!existsSync(CONTENT)) {
  console.error(`No ${CONTENT}/ folder. Run "npm run sync" (needs Drive credentials) or set CONTENT_DIR.`);
  process.exit(1);
}

const { main, extras, wiki, reference } = loadContent(CONTENT, config);
const chapters = [...main, ...extras];
const chapterByFile = new Map(chapters.map((c) => [c.path, c]));
const wikiByPath = new Map(wiki.map((p) => [p.path, p]));
const referenceByPath = new Map(reference.map((r) => [r.path, r]));
const readerWiki = wiki.filter((p) => isReaderPage(p, config));
const readerWikiPaths = new Set(readerWiki.map((p) => p.path));

// ---------- Illustrations ----------
// Images are found in content/ (Drive's illustrations folder, or next to the Markdown that uses them).
// Only images actually used on a page are published; reader pages get them under images/, author-only
// pages under author/i/. Names are hashed so file names in Drive (which may hint at spoilers) don't leak.

let sharp = null;
try {
  sharp = (await import("sharp")).default;
} catch {
  console.warn("sharp not installed: illustrations are copied as-is, without resizing.");
}
const DISPLAY_WIDTH = 1400; // shown in the page (sharp on 2x phone screens at the text column width)
const FULL_WIDTH = 2400; // opened on tap

const IMAGE_RE = /\.(jpe?g|png|webp|gif|avif)$/i;
const listImages = (dir, prefix = "") =>
  readdirSync(join(CONTENT, dir), { withFileTypes: true }).flatMap((d) => {
    const rel = prefix ? `${prefix}/${d.name}` : d.name;
    if (d.isDirectory()) return listImages(join(dir, d.name), rel);
    return IMAGE_RE.test(d.name) ? [rel] : [];
  });
const images = listImages("");
const imageByName = new Map();
for (const path of images) {
  const key = posix.basename(path).toLowerCase();
  if (!imageByName.has(key)) imageByName.set(key, path);
}
const imageMeta = new Map();
if (sharp) {
  for (const path of images) {
    try {
      const m = await sharp(join(CONTENT, path)).metadata();
      const rotated = (m.orientation || 1) >= 5; // EXIF says the photo is turned sideways
      imageMeta.set(path, { width: rotated ? m.height : m.width, height: rotated ? m.width : m.height });
    } catch {
      console.warn(`Couldn't read image ${path}; it will be copied as-is.`);
    }
  }
}
const imageJobs = new Map(); // output name -> { path, ext }
const missingImages = new Set();

function imageResolver(fromPath, base, tier) {
  return (href) => {
    if (!href) return null;
    if (/^https?:/i.test(href)) return { src: href, full: href };
    const rel = decodeURIComponent(href.split("#")[0]);
    let path = posix.normalize(posix.join(posix.dirname(fromPath), rel));
    if (!images.includes(path)) path = images.includes(rel) ? rel : imageByName.get(posix.basename(rel).toLowerCase());
    if (!path) {
      missingImages.add(`${fromPath} → ${href}`);
      return null;
    }
    const resize = sharp && imageMeta.has(path) && !/\.gif$/i.test(path);
    const ext = resize ? ".webp" : posix.extname(path).toLowerCase();
    const name = `${tier === "author" ? "author/i" : "images"}/${sha256(`${config.authorTier.salt}:img:${path}`).slice(0, 16)}`;
    imageJobs.set(name, { path, ext, resize });
    const meta = imageMeta.get(path);
    const width = meta && Math.min(meta.width, DISPLAY_WIDTH);
    const height = meta && Math.round((meta.height * width) / meta.width);
    return { src: `${base}${name}${ext}`, full: `${base}${name}-full${ext}`, width, height };
  };
}

async function writeImages() {
  for (const [name, { path, ext, resize }] of imageJobs) {
    const src = join(CONTENT, path);
    mkdirSync(dirname(join(OUT, name)), { recursive: true });
    if (resize) {
      const out = (file, width, quality) =>
        sharp(src).rotate().resize({ width, withoutEnlargement: true }).webp({ quality }).toFile(join(OUT, file));
      await out(`${name}${ext}`, DISPLAY_WIDTH, 82);
      await out(`${name}-full${ext}`, FULL_WIDTH, 86);
    } else {
      copyFileSync(src, join(OUT, `${name}${ext}`));
      copyFileSync(src, join(OUT, `${name}-full${ext}`));
    }
  }
  for (const m of missingImages) console.warn(`Image not found: ${m}`);
  return imageJobs.size;
}

// ---------- Latest updates (new chapters, and prose revisions detected by content hash) ----------

const previous = existsSync(UPDATES) ? JSON.parse(readFileSync(UPDATES, "utf8")) : null;
const firstRun = !previous || !Object.keys(previous).length;
const HOUR = 3600e3;
const updates = {};
for (const c of chapters) {
  const rec = previous?.[c.slug];
  if (!rec) {
    const seeded = firstRun && new Date(c.modified) - new Date(c.created) > HOUR;
    updates[c.slug] = { title: c.title, hash: c.hash, published: firstRun ? c.created : c.modified, updated: seeded ? c.modified : null };
  } else {
    updates[c.slug] = { ...rec, title: c.title, hash: c.hash, updated: rec.hash === c.hash ? rec.updated : c.modified };
  }
}
mkdirSync(dirname(UPDATES), { recursive: true });
writeFileSync(UPDATES, JSON.stringify(updates, null, 2) + "\n");

const feed = chapters
  .map((c) => {
    const u = updates[c.slug];
    const revised = u.updated && u.updated > u.published;
    return { c, kind: revised ? "Revised" : "New", date: revised ? u.updated : u.published };
  })
  .sort((a, b) => b.date.localeCompare(a.date))
  .slice(0, config.updates?.show ?? 8);

// ---------- Helpers ----------

const fmtDate = (iso) => new Date(iso).toLocaleDateString("en", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
const sectionTitle = (s) => config.wiki.sectionTitles?.[s] || (s ? s[0].toUpperCase() + s.slice(1).replace(/-/g, " ") : "General");
const authorId = (path) => sha256(`${config.authorTier.salt}:${path}`).slice(0, 16);
const readerWikiUrl = (p) => `wiki/${p.section}/${p.slug}.html`;

const ICONS = {
  type: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7V5h16v2M9 19h6M12 5v14"/></svg>',
  list: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01"/></svg>',
  left: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 18l-6-6 6-6"/></svg>',
  right: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 18l6-6-6-6"/></svg>',
  lock: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>',
  search: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/></svg>',
};

// Resolves a Markdown link inside a Drive file to a site URL for the given tier.
function linkResolver(fromPath, base, tier) {
  return (href) => {
    if (!href || /^(https?:|mailto:|#)/i.test(href)) return href;
    const [file, frag] = href.split("#");
    const target = posix.normalize(posix.join(posix.dirname(fromPath), decodeURIComponent(file)));
    const hash = frag ? `#${frag}` : "";
    const wikiPage = wikiByPath.get(target);
    const chapter = chapterByFile.get(target) || (wikiPage?.manuscriptFile && chapterByFile.get(wikiPage.manuscriptFile));
    if (tier === "author") {
      if (wikiPage || referenceByPath.has(target)) return `${base}author/p/${authorId(target)}.html${hash}`;
      if (chapter) return `${base}${chapter.slug}.html`;
      return null;
    }
    if (wikiPage && readerWikiPaths.has(target)) return `${base}${readerWikiUrl(wikiPage)}${hash}`;
    if (chapter) return `${base}${chapter.slug}.html`;
    return null;
  };
}

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
    <span class="setting-label">Illustrations</span>
    <div class="seg" role="group" aria-label="Illustrations">
      <button data-set="illust" data-value="show">Show</button>
      <button data-set="illust" data-value="hide">Hide</button>
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

function topbar(base, current) {
  const nav = [
    ["read", "Read", "index.html#chapters"],
    ["wiki", "Wiki", "wiki/index.html"],
  ]
    .map(([key, label, href]) => `<a href="${base}${href}"${current === key ? ' aria-current="page"' : ""}>${label}</a>`)
    .join("");
  return `
<header class="topbar" id="topbar">
  <div class="topbar-inner">
    <a class="brand" href="${base}index.html">${esc(config.title)}</a>
    <nav class="topnav" aria-label="Site">${nav}</nav>
    <div class="topbar-actions">
      <button class="icon-btn" id="settings-toggle" aria-label="Reading settings" aria-expanded="false" aria-controls="settings">${ICONS.type}</button>
    </div>
  </div>
  ${settingsPanel}
  <div class="progress" aria-hidden="true"><div class="progress-bar" id="progress"></div></div>
</header>`;
}

function layout({ title, description = config.description, base, body, bodyClass = "", current, scripts = ["reader.js"], robots }) {
  return `<!doctype html>
<html lang="${config.lang || "en"}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}">
${robots ? `<meta name="robots" content="${robots}">\n` : ""}<meta name="theme-color" content="#fbfaf7">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Literata:ital,opsz,wght@0,7..72,400;0,7..72,600;1,7..72,400&family=Inter:wght@400;500;600&display=swap">
<link rel="stylesheet" href="${base}assets/style.css">
<script>
  // Apply saved reading preferences before first paint to avoid a flash.
  try { const p = JSON.parse(localStorage.getItem("reader-prefs") || "{}");
    const d = document.documentElement;
    if (p.theme && p.theme !== "auto") d.dataset.theme = p.theme;
    if (p.font) d.dataset.font = p.font;
    if (p.width) d.dataset.width = p.width;
    if (p.illust) d.dataset.illust = p.illust;
    if (p.size) d.style.setProperty("--scale", p.size / 100);
  } catch (e) {}
</script>
</head>
<body class="${bodyClass}">
${topbar(base, current)}
${body}
<footer class="site-footer">
  <span>© ${new Date().getFullYear()} ${esc(config.author || "")}</span>
  <a href="${base}author/index.html" class="footer-link">${ICONS.lock}Author</a>
</footer>
${scripts.map((s) => `<script src="${base}assets/${s}" defer></script>`).join("\n")}
</body>
</html>
`;
}

function write(path, html) {
  const dest = join(OUT, path);
  mkdirSync(dirname(dest), { recursive: true });
  writeFileSync(dest, html);
}

// ---------- Reader tier ----------

function tocList(list) {
  return `<ol class="toc-list">${list
    .map(
      (c) => `
      <li><a class="toc-item" href="${c.slug}.html" data-slug="${c.slug}">
        <span class="toc-label">${esc(c.label)}</span>
        <span class="toc-title">${esc(c.title)}</span>
        <span class="toc-meta">${c.minutes} min</span>
      </a></li>`
    )
    .join("")}
    </ol>`;
}

function indexPage() {
  const totalWords = chapters.reduce((n, c) => n + c.words, 0);
  const updatesHtml = feed.length
    ? `
  <section class="updates" aria-labelledby="updates-heading">
    <div class="section-head"><h2 id="updates-heading">Latest updates</h2></div>
    <ul class="update-list">${feed
      .map(
        ({ c, kind, date }) => `
      <li><a class="update-item" href="${c.slug}.html">
        <span class="badge badge-${kind.toLowerCase()}">${kind}</span>
        <span class="update-title"><span class="update-label">${esc(c.label)}</span>${esc(c.title)}</span>
        <time datetime="${date}">${fmtDate(date)}</time>
      </a></li>`
      )
      .join("")}
    </ul>
  </section>`
    : "";
  const body = `
<main class="home">
  <section class="hero">
    <h1 class="hero-title">${esc(config.title)}</h1>
    ${config.subtitle ? `<p class="hero-subtitle">${esc(config.subtitle)}</p>` : ""}
    ${config.author ? `<p class="hero-author">by ${esc(config.author)}</p>` : ""}
    ${config.description ? `<p class="hero-desc">${esc(config.description)}</p>` : ""}
    <div class="hero-actions">
      ${main.length ? `<a class="btn btn-primary" href="${main[0].slug}.html">Start reading</a>` : ""}
      <a class="btn btn-ghost" id="resume" href="#" hidden>Continue <span id="resume-title"></span></a>
    </div>
  </section>
  ${updatesHtml}
  <section class="toc" id="chapters" aria-labelledby="toc-heading">
    <div class="section-head">
      <h2 id="toc-heading">Chapters</h2>
      <span class="section-meta">${main.length} entries · ${totalWords.toLocaleString("en")} words in all</span>
    </div>
    ${tocList(main)}
  </section>
  ${
    extras.length
      ? `<section class="toc" id="side-stories" aria-labelledby="extras-heading">
    <div class="section-head">
      <h2 id="extras-heading">Side stories</h2>
      <span class="section-meta">Not yet placed in the reading order</span>
    </div>
    ${tocList(extras)}
  </section>`
      : ""
  }
</main>`;
  return layout({ title: config.title, base: "", body, bodyClass: "page-home", current: "read" });
}

function chapterPage(c, prev, next) {
  const navLink = (ch, rel) =>
    ch
      ? `<a class="nav-link ${rel}" href="${ch.slug}.html" rel="${rel}">${rel === "prev" ? ICONS.left : ""}<span><small>${rel === "prev" ? "Previous" : "Next"}</small>${esc(ch.title)}</span>${rel === "next" ? ICONS.right : ""}</a>`
      : "";
  const end = `<a class="nav-link next" href="index.html#chapters"><span><small>The end — for now</small>Back to contents</span>${ICONS.list}</a>`;
  const body = `
<main class="reader" data-slug="${c.slug}" data-title="${esc(c.title)}">
  <header class="chapter-head">
    <p class="chapter-label">${esc(c.label)}</p>
    <h1 class="chapter-title">${esc(c.title)}</h1>
    <p class="chapter-meta">${c.minutes} min read</p>
  </header>
  <article class="prose">
${renderMarkdown(c.src, { link: linkResolver(c.path, "", "reader"), image: imageResolver(c.path, "", "reader") })}
  </article>
  <nav class="chapter-nav" aria-label="Chapter navigation">
    ${navLink(prev, "prev") || "<span></span>"}
    ${navLink(next, "next") || end}
  </nav>
</main>`;
  return layout({ title: `${c.title} · ${config.title}`, description: `${c.label}: ${c.title} — ${config.title}`, base: "", body, bodyClass: "page-chapter", current: "read" });
}

function wikiDirectory(pages, base, hrefFor, intro) {
  const bySection = new Map();
  for (const p of pages) {
    if (!bySection.has(p.section)) bySection.set(p.section, []);
    bySection.get(p.section).push(p);
  }
  const order = Object.keys(config.wiki.sectionTitles || {});
  const sections = [...bySection.keys()].sort((a, b) => ((order.indexOf(a) + 1 || 99) - (order.indexOf(b) + 1 || 99)) || a.localeCompare(b));
  return `
  <label class="filter">${ICONS.search}<input type="search" id="wiki-filter" placeholder="Filter pages" autocomplete="off" aria-label="Filter pages"></label>
  ${intro || ""}
  ${sections
    .map(
      (s) => `
  <section class="wiki-section" data-filter-group>
    <div class="section-head"><h2>${esc(sectionTitle(s))}</h2><span class="section-meta">${bySection.get(s).length}</span></div>
    <ul class="wiki-grid">${bySection
      .get(s)
      .sort((a, b) => a.title.localeCompare(b.title))
      .map(
        (p) => `
      <li data-filter-text="${esc((p.title + " " + p.summary).toLowerCase())}"><a class="wiki-card" href="${hrefFor(p)}">
        <span class="wiki-card-title">${esc(p.title)}</span>
        ${p.summary ? `<span class="wiki-card-summary">${renderInlineSummary(p.summary)}</span>` : ""}
      </a></li>`
      )
      .join("")}
    </ul>
  </section>`
    )
    .join("")}
  <p class="filter-empty" id="filter-empty" hidden>No pages match.</p>`;
}

// Summaries are plain text on cards (links inside them would nest anchors).
const renderInlineSummary = (s) => renderMarkdown(s, { link: () => null }).replace(/^<p>|<\/p>\s*$/g, "");

function wikiBody(page, src, { link, image }) {
  const body = src.replace(/^#\s+.+\n?/m, "").replace(/^>\s+.+\n?/m, "");
  return `
  <header class="wiki-head">
    <h1 class="wiki-title">${esc(page.title)}</h1>
    ${page.summary ? `<p class="wiki-lede">${renderMarkdown(page.summary, { link }).replace(/^<p>|<\/p>\s*$/g, "")}</p>` : ""}
  </header>
  <article class="wiki-body">
${renderMarkdown(body, { link, image })}
  </article>
  <p class="wiki-updated">Last updated ${fmtDate(page.modified)}</p>`;
}

function readerWikiPage(page) {
  const base = "../../";
  const body = `
<main class="wiki">
  <nav class="crumbs" aria-label="Breadcrumb"><a href="../index.html">Wiki</a><span aria-hidden="true">›</span><span>${esc(sectionTitle(page.section))}</span></nav>
  ${wikiBody(page, stripAuthorNotes(page.src, config), { link: linkResolver(page.path, base, "reader"), image: imageResolver(page.path, base, "reader") })}
</main>`;
  return layout({ title: `${page.title} · ${config.title} wiki`, description: page.summary || page.title, base, body, bodyClass: "page-wiki", current: "wiki" });
}

function readerWikiIndex() {
  const body = `
<main class="wiki wiki-index">
  <header class="wiki-head">
    <h1 class="wiki-title">Wiki</h1>
    <p class="wiki-lede">Who's who and how the world works.</p>
  </header>
  ${wikiDirectory(readerWiki, "../", (p) => `${p.section}/${p.slug}.html`)}
</main>`;
  return layout({ title: `Wiki · ${config.title}`, base: "../", body, bodyClass: "page-wiki", current: "wiki" });
}

// ---------- Author tier ----------

function vaultShell(payload, base) {
  const body = `
<main class="wiki vault" data-vault="${payload}" data-login="${base}author/login.html">
  <p class="vault-status" id="vault-status">${ICONS.lock} Unlocking…</p>
  <noscript><p class="vault-status">The author area needs JavaScript.</p></noscript>
</main>`;
  return layout({ title: `Author · ${config.title}`, base, body, bodyClass: "page-wiki page-author", current: "wiki", scripts: ["reader.js", "author.js"], robots: "noindex, nofollow" });
}

function loginPage(check) {
  const body = `
<main class="login">
  <form class="login-card" id="login-form" data-check="${check || ""}" data-salt="${esc(config.authorTier.salt)}" data-iterations="${KDF_ITERATIONS}">
    <span class="login-icon">${ICONS.lock}</span>
    <h1>Author area</h1>
    <p class="login-lede">The full wiki, plot notes and reference files.</p>
    ${
      check
        ? `<label class="field"><span>Password</span><input type="password" id="password" autocomplete="current-password" required autofocus></label>
    <label class="check"><input type="checkbox" id="remember" checked> Keep me signed in on this device</label>
    <button class="btn btn-primary" type="submit" id="login-submit">Sign in</button>
    <p class="login-error" id="login-error" role="alert" hidden>That password didn't work.</p>`
        : `<p class="login-error">The author area isn't set up yet: set AUTHOR_PASSWORD (a GitHub secret, or the .env file on the NAS).</p>`
    }
  </form>
</main>`;
  return layout({ title: `Sign in · ${config.title}`, base: "../", body, bodyClass: "page-login", current: "", scripts: ["reader.js", "author.js"], robots: "noindex, nofollow" });
}

async function buildAuthorTier() {
  const password = process.env.AUTHOR_PASSWORD;
  if (!password) {
    console.warn("AUTHOR_PASSWORD not set: author area will show a setup message.");
    write("author/login.html", loginPage(null));
    write("author/index.html", loginPage(null));
    return 0;
  }
  const key = await deriveKey(password, config.authorTier.salt);
  const seal = async (title, html) => encrypt(key, JSON.stringify({ title, html }));
  let count = 0;

  write("author/login.html", loginPage(await encrypt(key, "ok")));

  const all = [...wiki, ...reference.map((r) => ({ ...r, section: "reference", summary: "", rel: r.path }))];
  const directory = `
  <header class="wiki-head">
    <div class="wiki-head-row"><h1 class="wiki-title">Author area</h1><button class="btn btn-ghost btn-small" id="sign-out" type="button">Sign out</button></div>
    <p class="wiki-lede">Everything in the Drive wiki, unfiltered, plus the reference files at the folder root.</p>
  </header>
  ${wikiDirectory(all, "../", (p) => `p/${authorId(p.path)}.html`)}`;
  write("author/index.html", vaultShell(await seal(`Author area · ${config.title}`, directory), "../"));

  for (const page of all) {
    const base = "../../";
    const crumbs = `<nav class="crumbs" aria-label="Breadcrumb"><a href="../index.html">Author area</a><span aria-hidden="true">›</span><span>${esc(sectionTitle(page.section === "reference" ? "Reference files" : page.section))}</span></nav>`;
    const html = crumbs + wikiBody(page, page.src, { link: linkResolver(page.path, base, "author"), image: imageResolver(page.path, base, "author") });
    write(`author/p/${authorId(page.path)}.html`, vaultShell(await seal(`${page.title} · Author`, html), base));
    count++;
  }
  return count;
}

// ---------- Build ----------

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
cpSync("assets", join(OUT, "assets"), { recursive: true });
writeFileSync(join(OUT, ".nojekyll"), "");

write("index.html", indexPage());
main.forEach((c, i) => write(`${c.slug}.html`, chapterPage(c, main[i - 1], main[i + 1])));
extras.forEach((c, i) => write(`${c.slug}.html`, chapterPage(c, extras[i - 1], extras[i + 1])));
write("wiki/index.html", readerWikiIndex());
readerWiki.forEach((p) => write(readerWikiUrl(p), readerWikiPage(p)));
const authorPages = await buildAuthorTier();
const imageCount = await writeImages();

console.log(
  `Built ${main.length} chapters/interludes, ${extras.length} side stories, ` +
    `${readerWiki.length} public wiki pages, ${authorPages} author pages, ${imageCount} illustrations into ${OUT}/` +
    (firstRun ? " (first run: update dates seeded from Drive)" : "")
);
