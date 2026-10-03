// Builds the site into _site/ from content/ (mirrored from Google Drive by sync-drive.mjs).
//   Reader tier: chapters, side stories, latest updates, and the character/world wiki.
//   Author tier: the full wiki and reference files, encrypted with AUTHOR_PASSWORD.
import { copyFileSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, posix } from "node:path";
import { loadContent, isReaderPage, stripAuthorNotes, sha256 } from "../lib/content.mjs";
import { escapeHtml as esc, renderMarkdown } from "../lib/markdown.mjs";
import { deriveKey, encrypt, KDF_ITERATIONS } from "../lib/vault.mjs";
import { buildNameIndex, linkCharacters } from "../lib/characters.mjs";
import { chapterDiff } from "../lib/diff.mjs";

const OUT = process.env.OUT_DIR || "_site";
const CONTENT = process.env.CONTENT_DIR || "content";
const UPDATES = process.env.UPDATES_FILE || "data/updates.json";
// Last published text of each chapter, and the latest revision's diff ("What changed" pages).
// Kept on the NAS next to updates.json; never committed (they hold chapter text).
const SNAPSHOTS = process.env.SNAPSHOT_DIR || join(dirname(UPDATES), "snapshots");
const CHANGES = join(dirname(SNAPSHOTS), "changes");
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
// A character page hidden by its status (CANDIDATE, PLANNED) still goes public once she is named in a
// published chapter or side story: she's on the page, so readers need her card. (The spoiler shield
// keeps her hidden from anyone who hasn't opened that story yet.)
const cardConfig = config.characterCards || {};
const characterPool = wiki.filter((p) => p.section === "characters" && config.wiki.readerSections.includes("characters") && /\*\*Species:\*\*/.test(p.src) && !(config.wiki.readerExclude || []).includes(p.rel));
const mentionedOnPage = new Set();
{
  const poolIndex = buildNameIndex(characterPool.map((p) => ({ id: p.slug, name: p.title })), cardConfig);
  for (const c of chapters) linkCharacters(c.src, poolIndex, () => "", mentionedOnPage);
}
const readerWiki = wiki.filter((p) => isReaderPage(p, config) || (characterPool.includes(p) && mentionedOnPage.has(p.slug)));
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

mkdirSync(SNAPSHOTS, { recursive: true });
mkdirSync(CHANGES, { recursive: true });
const changes = new Map(); // slug -> { from, to, html, changed }
for (const c of chapters) {
  const snap = join(SNAPSHOTS, `${c.slug}.md`);
  const changeFile = join(CHANGES, `${c.slug}.json`);
  const before = existsSync(snap) ? readFileSync(snap, "utf8") : null;
  if (before !== null && sha256(before.replace(/\s+/g, " ")) !== c.hash) {
    const diff = chapterDiff(before, c.src);
    if (diff.changed) {
      const prev = previous?.[c.slug];
      writeFileSync(changeFile, JSON.stringify({ hash: c.hash, from: prev?.updated || prev?.published || null, to: updates[c.slug].updated, ...diff }));
    }
  }
  writeFileSync(snap, c.src);
  if (existsSync(changeFile)) {
    const ch = JSON.parse(readFileSync(changeFile, "utf8"));
    if (ch.hash === c.hash) changes.set(c.slug, ch); // only the diff that led to the current text
  }
}

const feed = chapters
  .map((c) => {
    const u = updates[c.slug];
    const revised = u.updated && u.updated > u.published;
    return { c, kind: revised ? "Revised" : "New", date: revised ? u.updated : u.published };
  })
  .sort((a, b) => b.date.localeCompare(a.date))
  .slice(0, config.updates?.show ?? 8);

// ---------- Arcs ----------
// From Arcs.md at the top of the Drive folder, one line per arc giving the chapter it starts at:
//   - Chapter 1: The Overwrite
//   - Chapter 10: Campus Qualifiers
// (site.config.json "arcs" is the fallback.) Interludes belong to the arc their slot falls in.
const arcsFile = reference.find((r) => /^arcs\.md$/i.test(r.path));
const arcs = (arcsFile
  ? [...arcsFile.src.matchAll(/^\s*[-*]\s*(?:chapter|ch\.?)?\s*([\d.]+)\s*[:\u2014\u2013-]\s*(.+?)\s*$/gim)].map((m) => ({ from: parseFloat(m[1]), title: m[2] }))
  : config.arcs || []
).sort((a, b) => a.from - b.from);
const arcFor = (c) => (c.slot ? [...arcs].reverse().find((a) => c.slot[0] >= a.from) : null);

// ---------- Helpers ----------

const fmtDate = (iso) => new Date(iso).toLocaleDateString("en", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
const sectionTitle = (s) => config.wiki.sectionTitles?.[s] || (s ? s[0].toUpperCase() + s.slice(1).replace(/-/g, " ") : "General");
const authorId = (path) => sha256(`${config.authorTier.salt}:${path}`).slice(0, 16);
const readerWikiUrl = (p) => `wiki/${p.section}/${p.slug}.html`;

// ---------- Character cards ----------
// Public character pages that describe a person (they have a "Species:" line), with what the card shows.
const characters = cardConfig.enabled === false ? [] : readerWiki
  .filter((p) => p.section === "characters" && /\*\*Species:\*\*/.test(p.src))
  .map((p) => {
    const src = stripAuthorNotes(p.src, config);
    const species = (src.match(/\*\*Species:\*\*\s*([^\n]+)/) || [])[1] || "";
    const portrait = (src.match(/!\[\[[^\]]+\]\]|!\[[^\]]*\]\([^)]+\)/) || [])[0];
    let image = null;
    if (portrait) {
      const href = portrait.startsWith("![[") ? portrait.slice(3, -2).split("|")[0] : portrait.match(/\]\((<?)([^)>\s]+)/)[2];
      image = imageResolver(p.path, "", "reader")(href)?.src || null;
    }
    const inline = (md) => renderMarkdown(md, { link: () => null, image: () => null }).replace(/^<p>|<\/p>\s*$/g, "").trim();
    const summary = p.readerSummary || p.summary;
    return { id: p.slug, page: p, name: p.title, species: species ? inline(species.replace(/\.\s*$/, "")) : "", summary: summary ? inline(stripAuthorNotes(summary, config)) : "", image, url: readerWikiUrl(p) };
  });
const nameIndex = buildNameIndex(characters, cardConfig);
// Spoiler shield: the chapters (in reading order) where each character is mentioned, filled in as
// chapter pages are rendered. A reader who hasn't opened any of them yet hasn't met her.
const appearances = new Map(); // character id -> [chapter slugs]
const appearsAttr = (p) => {
  const slugs = p.section === "characters" && appearances.get(p.slug);
  return slugs?.length ? ` data-appears="${slugs.join(" ")}"` : "";
};

const ICONS = {
  type: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7V5h16v2M9 19h6M12 5v14"/></svg>',
  list: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01"/></svg>',
  left: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 18l-6-6 6-6"/></svg>',
  right: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 18l6-6-6-6"/></svg>',
  lock: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>',
  search: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/></svg>',
};

// Links to Markdown files that don't exist anywhere in the synced folder (for the build report).
const brokenLinks = new Map();

// Resolves a Markdown link inside a Drive file to a site URL for the given tier.
function linkResolver(fromPath, base, tier) {
  return (href) => {
    if (!href || /^(https?:|mailto:|#)/i.test(href)) return href;
    const [file, frag] = href.split("#");
    const target = posix.normalize(posix.join(posix.dirname(fromPath), decodeURIComponent(file)));
    const hash = frag ? `#${frag}` : "";
    const wikiPage = wikiByPath.get(target);
    const chapter = chapterByFile.get(target) || (wikiPage?.manuscriptFile && chapterByFile.get(wikiPage.manuscriptFile));
    if (/\.md$/i.test(target) && !wikiPage && !chapter && !referenceByPath.has(target)) brokenLinks.set(`${fromPath}\u0000${target}`, { from: fromPath, href: target });
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
      <button data-set="font" data-value="sans" class="font-sans">Sans</button>
      <button data-set="font" data-value="serif" class="font-serif">Serif</button>
    </div>
  </div>
  <div class="setting">
    <span class="setting-label">Spoiler shield</span>
    <div class="seg" role="group" aria-label="Spoiler shield">
      <button data-set="shield" data-value="on">On</button>
      <button data-set="shield" data-value="off">Off</button>
    </div>
  </div>
  <div class="setting">
    <span class="setting-label">Character cards</span>
    <div class="seg" role="group" aria-label="Character cards">
      <button data-set="cards" data-value="on">On</button>
      <button data-set="cards" data-value="off">Off</button>
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
      <a class="icon-btn" href="${base}search.html" aria-label="Search"${current === "search" ? ' aria-current="page"' : ""}>${ICONS.search}</a>
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
    if (p.font && p.v === 2) d.dataset.font = p.font;
    if (p.width) d.dataset.width = p.width;
    if (p.illust) d.dataset.illust = p.illust;
    if (p.cards) d.dataset.cards = p.cards;
    if (Number.isFinite(p.size)) d.style.setProperty("--scale", p.size / 100);
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

function groupByArc(list) {
  const groups = [];
  for (const c of list) {
    const arc = arcFor(c) || null;
    if (!groups.length || groups.at(-1).arc !== arc) groups.push({ arc, list: [] });
    groups.at(-1).list.push(c);
  }
  return groups;
}

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
      <li><a class="update-item" href="${kind === "Revised" && changes.has(c.slug) ? `changes/${c.slug}.html` : `${c.slug}.html`}">
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
    ${
      arcs.length
        ? groupByArc(main)
            .map(({ arc, list }) => `${arc ? `<h3 class="arc-head"><span>${esc(arc.title)}</span><span class="arc-meta">${list.length} ${list.length === 1 ? "entry" : "entries"}</span></h3>` : ""}${tocList(list)}`)
            .join("")
        : tocList(main)
    }
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

// ---------- "Before you read" box ----------
// Whose point of view the chapter is told from, who she is, and the characters it introduces.
// The narrator's name comes from the chapter's wiki manuscript page ("- POV: …"), else from the
// author note's opening ("Kirishima Mizore POV, first person. …"). The rest of the note is planning
// text and never shown: "who she is" comes from her public wiki page (species and summary), or from
// an "- Intro: …" line on the manuscript page if you want to write it yourself.
const introCfg = config.manuscript.introBox || {};
const manuscriptPageFor = new Map(wiki.filter((p) => p.manuscriptFile).map((p) => [p.manuscriptFile, p]));
const characterById = new Map(characters.map((ch) => [ch.id, ch]));
const plainInline = (md) => renderMarkdown(md, { link: () => null, image: () => null }).replace(/^<p>|<\/p>\s*$/g, "").replace(/<[^>]+>/g, "").trim();
const NARRATION = /^((?:first|second|third)[- ]person(?:[ ,]+(?:close|limited|omniscient|present|past)(?: tense)?)*)/i;

function povFor(c) {
  const page = manuscriptPageFor.get(c.path);
  const fromNote = c.note.match(/^(.+?)\s+POV\b[\s,;:.-]*([\s\S]*)$/i);
  const raw = page?.pov ? plainInline(stripAuthorNotes(page.pov, config)) : fromNote ? plainInline(fromNote[1]) : "";
  if (!raw) return null;
  const name = raw.split(/[,(;]/)[0].replace(/\s+POV$/i, "").trim();
  // Narration style: only a short "first person" / "third person, close" phrase, nothing else.
  const styleSource = page?.pov ? raw.slice(raw.split(/[,(;]/)[0].length).replace(/^[\s,(;]+/, "") : fromNote?.[2] || "";
  const style = (styleSource.match(NARRATION) || [])[1]?.replace(/[\s,]+$/, "") || "";
  const id = [...nameIndex.keys()].sort((a, b) => b.length - a.length).find((n) => new RegExp(`(?<![\\p{L}])${n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\p{L}])`, "u").test(name));
  return { name, style, intro: page?.intro ? plainInline(page.intro) : "", id: id ? nameIndex.get(id) : null };
}

function introBox(c, newIds, povInfo) {
  const showPov = povInfo && !(introCfg.defaultPov && povInfo.name.toLowerCase().startsWith(introCfg.defaultPov.toLowerCase()));
  const newcomers = [...newIds].map((id) => characterById.get(id)).filter((ch) => ch && ch.id !== povInfo?.id);
  if (!showPov && !newcomers.length) return "";
  const charLink = (ch, label) => `<a class="char" href="${ch.url}" data-char="${ch.id}">${esc(label)}</a>`;
  const povChar = povInfo?.id && characterById.get(povInfo.id);
  const about = povInfo?.intro || (povChar ? [povChar.species, povChar.summary].filter(Boolean).join(" · ") : "");
  const povHtml = showPov
    ? `<div class="intro-row">
      <p class="intro-label">Point of view</p>
      <p class="intro-pov">${povChar ? charLink(povChar, povInfo.name) : esc(povInfo.name)}${povInfo.style ? `<span class="intro-style"> · ${esc(povInfo.style)}</span>` : ""}</p>
      ${about ? `<p class="intro-about">${about}</p>` : ""}
    </div>`
    : "";
  const newHtml = newcomers.length
    ? `<div class="intro-row">
      <p class="intro-label">New in this chapter</p>
      <ul class="intro-new">${newcomers
        .slice(0, 8)
        .map((ch) => `<li>${charLink(ch, ch.name)}${ch.species ? ` <span class="intro-species">${ch.species}</span>` : ""}${ch.summary ? `<span class="intro-summary">${ch.summary}</span>` : ""}</li>`)
        .join("")}</ul>
    </div>`
    : "";
  return `<aside class="chapter-intro" aria-label="Before you read">${povHtml}${newHtml}</aside>`;
}

function chapterPage(c, prev, next) {
  const seen = new Set();
  const navLink = (ch, rel) =>
    ch
      ? `<a class="nav-link ${rel}" href="${ch.slug}.html" rel="${rel}">${rel === "prev" ? ICONS.left : ""}<span><small>${rel === "prev" ? "Previous" : "Next"}</small>${esc(ch.title)}</span>${rel === "next" ? ICONS.right : ""}</a>`
      : "";
  const end = `<a class="nav-link next" href="index.html#chapters"><span><small>The end — for now</small>Back to contents</span>${ICONS.list}</a>`;
  const proseHtml = linkCharacters(renderMarkdown(c.src, { link: linkResolver(c.path, "", "reader"), image: imageResolver(c.path, "", "reader") }), nameIndex, (id) => `wiki/characters/${id}.html`, seen);
  const povInfo = introCfg.enabled === false ? null : povFor(c);
  if (povInfo?.id) seen.add(povInfo.id); // told from her eyes counts as meeting her, even if her name never appears
  const newIds = [...seen].filter((id) => !appearances.has(id));
  const intro = introCfg.enabled === false ? "" : introBox(c, newIds, povInfo);
  const body = `
<main class="reader" data-slug="${c.slug}" data-title="${esc(c.title)}">
  <header class="chapter-head">
    <p class="chapter-label">${esc(c.label)}${arcFor(c) ? `<span class="chapter-arc"> · ${esc(arcFor(c).title)}</span>` : ""}</p>
    <h1 class="chapter-title">${esc(c.title)}</h1>
    <p class="chapter-meta">${c.minutes} min read${changes.has(c.slug) ? ` · Revised ${fmtDate(changes.get(c.slug).to)} · <a href="changes/${c.slug}.html">See what changed</a>` : ""}</p>
  </header>
  ${intro}
  <article class="prose">
${proseHtml}
  </article>
  <nav class="chapter-nav" aria-label="Chapter navigation">
    ${navLink(prev, "prev") || "<span></span>"}
    ${navLink(next, "next") || end}
  </nav>
</main>`;
  for (const id of seen) appearances.set(id, [...(appearances.get(id) || []), c.slug]);
  return layout({ title: `${c.title} · ${config.title}`, description: `${c.label}: ${c.title} — ${config.title}`, base: "", body, bodyClass: "page-chapter", current: "read" });
}

// ---------- Search ----------
// One JSON file with the readable text of every chapter and public wiki page; search.js loads it on
// the search page and searches it in the browser.
const htmlToText = (html) =>
  html
    .replace(/<(p|li|h\d|tr|blockquote|figure|div|section)\b[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&")
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*/g, "\n")
    .trim();

function searchIndex() {
  const none = { link: () => null, image: () => null };
  return [
    ...chapters.map((c) => ({ k: "chapter", t: c.title, l: c.label, u: `${c.slug}.html`, x: htmlToText(renderMarkdown(c.src, none)) })),
    ...readerWiki.map((p) => ({ k: "wiki", t: p.title, l: sectionTitle(p.section), u: readerWikiUrl(p), ...(p.section === "characters" && appearances.get(p.slug) ? { a: appearances.get(p.slug) } : {}), x: htmlToText(renderMarkdown(stripAuthorNotes(p.src, config).replace(/^#\s+.+\n?/m, ""), none)) })),
  ];
}

function searchPage() {
  const body = `
<main class="wiki search-page">
  <header class="wiki-head">
    <h1 class="wiki-title">Search</h1>
    <p class="wiki-lede">Every chapter and wiki page. Use "quotes" for an exact phrase.</p>
  </header>
  <form class="filter search-box" role="search" onsubmit="return false">${ICONS.search}<input type="search" id="search-input" placeholder="A name, a place, a line you remember…" autocomplete="off" aria-label="Search" autofocus></form>
  <p class="search-status" id="search-status" aria-live="polite"></p>
  <ol class="search-results" id="search-results"></ol>
</main>`;
  return layout({ title: `Search · ${config.title}`, base: "", body, bodyClass: "page-wiki", current: "search", scripts: ["reader.js", "search.js"] });
}

function changesPage(c) {
  const ch = changes.get(c.slug);
  const n = ch.changed;
  const body = `
<main class="wiki changes">
  <nav class="crumbs" aria-label="Breadcrumb"><a href="../index.html#chapters">Chapters</a><span aria-hidden="true">›</span><span>${esc(c.label)}</span></nav>
  <header class="wiki-head">
    <p class="chapter-label">What changed</p>
    <h1 class="wiki-title">${esc(c.title)}</h1>
    <p class="wiki-lede">Revised ${fmtDate(ch.to)}${ch.from ? `, since the version of ${fmtDate(ch.from)}` : ""} · ${n} passage${n === 1 ? "" : "s"} changed</p>
    <div class="changes-actions">
      <a class="btn btn-primary" href="../${c.slug}.html">Read the chapter</a>
      <span class="legend"><ins>added</ins> <del>removed</del></span>
    </div>
  </header>
  <article class="diff">${ch.html}</article>
</main>`;
  return layout({ title: `What changed: ${c.title} · ${config.title}`, base: "../", body, bodyClass: "page-wiki", current: "read" });
}

function wikiDirectory(pages, base, hrefFor, intro, shielded = false) {
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
      <li data-filter-text="${esc((p.title + " " + p.summary).toLowerCase())}"${shielded ? appearsAttr(p) : ""}><a class="wiki-card" href="${hrefFor(p)}">
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

function wikiBody(page, src, { link, image }, reader = false) {
  const body = src.replace(/^#\s+.+\n?/m, "").replace(/^>\s+.+\n?/m, "").replace(reader ? /^\*\*Reader summary:\*\*.*\n?/m : /(?!)/, "");
  if (reader && page.readerSummary) page = { ...page, summary: page.readerSummary };
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
<main class="wiki"${appearsAttr(page)}>
  <nav class="crumbs" aria-label="Breadcrumb"><a href="../index.html">Wiki</a><span aria-hidden="true">›</span><span>${esc(sectionTitle(page.section))}</span></nav>
  ${wikiBody(page, stripAuthorNotes(page.src, config), { link: linkResolver(page.path, base, "reader"), image: imageResolver(page.path, base, "reader") }, true)}
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
  <p class="shield-note" id="shield-note" hidden></p>
  ${wikiDirectory(readerWiki.map((p) => (p.readerSummary ? { ...p, summary: p.readerSummary } : p)), "../", (p) => `${p.section}/${p.slug}.html`, "", true)}
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

// ---------- Writing stats (author area) ----------
// A word-count history kept next to updates.json: one total per day. On the first run it's seeded
// from when each chapter file was created in Drive (an estimate: later edits aren't known).
const STATS = join(dirname(UPDATES), "stats.json");
const DAY = 86400e3;
const totalWords = chapters.reduce((n, c) => n + c.words, 0);
const today = new Date().toISOString().slice(0, 10);
const statsHistory = existsSync(STATS) ? JSON.parse(readFileSync(STATS, "utf8")) : (() => {
  const days = {};
  let sum = 0;
  for (const c of [...chapters].sort((a, b) => a.created.localeCompare(b.created))) days[c.created.slice(0, 10)] = sum += c.words;
  return { seededFromDrive: true, days };
})();
statsHistory.days[today] = totalWords;
writeFileSync(STATS, JSON.stringify(statsHistory, null, 2) + "\n");

function statsPage() {
  const series = Object.entries(statsHistory.days).sort(([a], [b]) => a.localeCompare(b));
  const totalAt = (iso) => {
    let v = 0;
    for (const [d, n] of series) if (d <= iso) v = n;
    return v;
  };
  const ago = (days) => new Date(Date.now() - days * DAY).toISOString().slice(0, 10);
  const week = totalWords - totalAt(ago(7));
  const month = totalWords - totalAt(ago(30));
  const fmt = (n) => n.toLocaleString("en");
  const signed = (n) => (n > 0 ? `+${fmt(n)}` : fmt(n));
  const longest = [...chapters].sort((a, b) => b.words - a.words)[0];
  const avg = main.length ? Math.round(main.reduce((n, c) => n + c.words, 0) / main.length) : 0;
  const tile = (label, value, note = "") => `<div class="stat"><span class="stat-label">${label}</span><span class="stat-value">${value}</span>${note ? `<span class="stat-note">${note}</span>` : ""}</div>`;
  const max = Math.max(1, ...chapters.map((c) => c.words));
  const rows = [...main, ...extras]
    .map((c) => `<tr><td class="num-col">${esc(c.label)}</td><td>${esc(c.title)}</td><td class="num">${fmt(c.words)}</td><td class="bar-cell"><span class="word-bar" style="width:${((c.words / max) * 100).toFixed(1)}%"></span></td></tr>`)
    .join("");
  const points = series.map(([d, n]) => [d, n]);
  return `
  <nav class="crumbs" aria-label="Breadcrumb"><a href="../index.html">Author area</a><span aria-hidden="true">›</span><span>Writing stats</span></nav>
  <header class="wiki-head">
    <h1 class="wiki-title">Writing stats</h1>
    <p class="wiki-lede">Published chapters, interludes and side stories, as of ${fmtDate(new Date().toISOString())}.</p>
  </header>
  <div class="stat-hero"><span class="stat-label">Total words</span><span class="stat-hero-value">${fmt(totalWords)}</span></div>
  <div class="stats-grid">
    ${tile("This week", signed(week), "words")}
    ${tile("Last 30 days", signed(month), "words")}
    ${tile("Chapters & interludes", fmt(main.length))}
    ${tile("Side stories", fmt(extras.length))}
    ${tile("Average chapter", fmt(avg), "words")}
    ${longest ? tile("Longest", fmt(longest.words), esc(longest.title)) : ""}
  </div>
  <article class="wiki-body">
    <h2>Total words over time</h2>
    <div class="line-chart" data-points='${esc(JSON.stringify(points))}' role="img" aria-label="Total words over time, from ${fmt(points[0]?.[1] || 0)} to ${fmt(totalWords)}"></div>
    ${statsHistory.seededFromDrive ? `<p class="chart-note">Days before the site started counting are estimated from when each chapter file was created in Drive.</p>` : ""}
    <details class="chart-table"><summary>Show as a table</summary><div class="table-wrap"><table><thead><tr><th>Date</th><th class="num">Total words</th></tr></thead><tbody>${[...points].reverse().map(([d, n]) => `<tr><td>${fmtDate(d + "T00:00:00Z")}</td><td class="num">${fmt(n)}</td></tr>`).join("")}</tbody></table></div></details>
    <h2>Words per chapter</h2>
    <div class="table-wrap"><table class="words-table"><thead><tr><th></th><th>Title</th><th class="num">Words</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>
  </article>`;
}

// ---------- Build report (author area) ----------
// Everything the build noticed that you might want to fix, gathered on one page.
function buildReport() {
  const li = (items) => (items.length ? `<ul>${items.map((i) => `<li>${i}</li>`).join("")}</ul>` : `<p class="report-ok">Nothing to fix.</p>`);
  const code = (s) => `<code>${esc(s)}</code>`;
  const sections = [];
  let issues = 0;
  const add = (title, intro, items, counts = true) => {
    if (counts) issues += items.length;
    sections.push(`<h2>${esc(title)}${items.length ? ` <span class="report-count">${items.length}</span>` : ""}</h2>${intro ? `<p>${intro}</p>` : ""}${li(items)}`);
  };

  const byTarget = new Map();
  for (const { from, href } of brokenLinks.values()) {
    if (!byTarget.has(href)) byTarget.set(href, new Set());
    byTarget.get(href).add(from);
  }
  add(
    "Links to missing files",
    "A page links to a file that isn't in the synced Drive folder (deleted, renamed, or in a folder the site doesn't read, like Sessions).",
    [...byTarget].sort().map(([href, from]) => `${code(href)} — from ${[...from].sort().map(code).join(", ")}`)
  );
  add("Pictures not found", "A chapter or wiki page shows a picture the illustrations folder doesn't have. Check the spelling.",
    [...missingImages].sort().map((m) => { const [from, href] = m.split(" → "); return `${code(href)} — in ${code(from)}`; }));

  const numbered = main.filter((c) => !c.isInterlude && Number.isInteger(c.slot[0])).map((c) => c.slot[0]);
  const gaps = [];
  for (let n = 1; n <= Math.max(0, ...numbered); n++) if (!numbered.includes(n)) gaps.push(n);
  add("Chapter numbers with no file", "Numbers between Chapter 1 and the last chapter that have no file. Fine if intentional.", gaps.length ? [gaps.join(", ")] : []);

  const seenNum = new Map();
  for (const c of main.filter((c) => !c.isInterlude)) seenNum.set(c.slot[0], [...(seenNum.get(c.slot[0]) || []), c.path]);
  add("Two files with the same chapter number", "", [...seenNum].filter(([, f]) => f.length > 1).map(([n, f]) => `Chapter ${n}: ${f.map(code).join(", ")}`));

  add("Interludes not yet in the reading order", "Shown to readers under Side stories. Give each a slot in the interlude index to place it between chapters.",
    extras.map((c) => `${esc(c.title)} — ${code(c.path)}`), false);

  const collisions = new Map();
  for (const ch of characters) {
    const w = ch.name.split(/\s+/);
    if (w.length === 2) collisions.set(w[1], [...(collisions.get(w[1]) || []), ch.name]);
  }
  add("Short names that won't get character cards", "Several characters share this given name, so it's never linked on its own (the full name still is). Add an alias in site.config.json under characterCards.aliases if you want one.",
    [...collisions].filter(([, n]) => n.length > 1).map(([g, n]) => `${esc(g)}: ${n.map(esc).join(", ")}`), false);

  const hidden = wiki.filter((p) => config.wiki.readerSections.includes(p.section) && !readerWikiPaths.has(p.path));
  add("Wiki pages held back from readers", "In a public section but hidden by their status or the exclude list.",
    hidden.map((p) => `${esc(p.title)} — ${p.status ? esc(p.status.split(";")[0]) : "excluded in site.config.json"}`), false);

  const looksLikeManuscript = reference.filter((r) => /^(chapter|interlude|ch\d)/i.test(r.path)).map((r) => code(r.path));
  add("Chapter-like files not published as chapters", "Their names don't match the chapter or interlude pattern, or they're excluded in site.config.json. They only appear in the author area.", looksLikeManuscript, false);

  const html = `
  <nav class="crumbs" aria-label="Breadcrumb"><a href="../index.html">Author area</a><span aria-hidden="true">›</span><span>Build report</span></nav>
  <header class="wiki-head">
    <h1 class="wiki-title">Build report</h1>
    <p class="wiki-lede">${issues ? `${issues} thing${issues === 1 ? "" : "s"} to look at` : "Nothing to fix"} · checked ${new Date().toLocaleString("en", { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" })} UTC</p>
  </header>
  <article class="wiki-body report">${sections.join("\n")}</article>`;
  return { html, issues, summary: `${byTarget.size} missing link targets, ${missingImages.size} missing pictures, ${gaps.length} chapter-number gaps` };
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

  for (const page of all) {
    const base = "../../";
    const crumbs = `<nav class="crumbs" aria-label="Breadcrumb"><a href="../index.html">Author area</a><span aria-hidden="true">›</span><span>${esc(sectionTitle(page.section === "reference" ? "Reference files" : page.section))}</span></nav>`;
    const html = crumbs + wikiBody(page, page.src, { link: linkResolver(page.path, base, "author"), image: imageResolver(page.path, base, "author") });
    write(`author/p/${authorId(page.path)}.html`, vaultShell(await seal(`${page.title} · Author`, html), base));
    count++;
  }

  // Written last: the report needs every page rendered first (that's when broken links are found).
  const report = buildReport();
  const reportId = authorId("\u0000build-report");
  const statsId = authorId("\u0000writing-stats");
  write(`author/p/${statsId}.html`, vaultShell(await seal(`Writing stats · Author`, statsPage()), "../../"));
  write(`author/p/${reportId}.html`, vaultShell(await seal(`Build report · Author`, report.html), "../../"));
  const directory = `
  <header class="wiki-head">
    <div class="wiki-head-row"><h1 class="wiki-title">Author area</h1><button class="btn btn-ghost btn-small" id="sign-out" type="button">Sign out</button></div>
    <p class="wiki-lede">Everything in the Drive wiki, unfiltered, plus the reference files at the folder root.</p>
  </header>
  <div class="author-banners">
    <a class="report-banner${report.issues ? " has-issues" : ""}" href="p/${reportId}.html">
      <span><strong>Build report</strong>${report.issues ? `${report.issues} thing${report.issues === 1 ? "" : "s"} to look at` : "Nothing to fix"}</span>${ICONS.right}
    </a>
    <a class="report-banner" href="p/${statsId}.html">
      <span><strong>Writing stats</strong>${totalWords.toLocaleString("en")} words</span>${ICONS.right}
    </a>
  </div>
  ${wikiDirectory(all, "../", (p) => `p/${authorId(p.path)}.html`)}`;
  write("author/index.html", vaultShell(await seal(`Author area · ${config.title}`, directory), "../"));
  console.log(`Build report: ${report.summary}.`);
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
chapters.filter((c) => changes.has(c.slug)).forEach((c) => write(`changes/${c.slug}.html`, changesPage(c)));
write("wiki/index.html", readerWikiIndex());
write("search.html", searchPage());
write("search-index.json", JSON.stringify(searchIndex()));
write("order.json", JSON.stringify({ main: main.map((c) => c.slug), extras: extras.map((c) => c.slug) }));
readerWiki.forEach((p) => write(readerWikiUrl(p), readerWikiPage(p)));
write("characters.json", JSON.stringify(Object.fromEntries(characters.map(({ id, name, species, summary, image, url }) => [id, { name, species, summary, image, url }]))));
const authorPages = await buildAuthorTier();
const imageCount = await writeImages();

console.log(
  `Built ${main.length} chapters/interludes, ${extras.length} side stories, ` +
    `${readerWiki.length} public wiki pages, ${authorPages} author pages, ${imageCount} illustrations into ${OUT}/` +
    (firstRun ? " (first run: update dates seeded from Drive)" : "")
);
