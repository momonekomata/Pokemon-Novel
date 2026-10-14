// Builds the site into _site/ from content/ (mirrored from Google Drive by sync-drive.mjs).
//   Reader tier: chapters, side stories, latest updates, and the character/world wiki.
//   Author tier: the full wiki and reference files, encrypted with AUTHOR_PASSWORD.
import { copyFileSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, posix } from "node:path";
import { loadContent, isReaderPage, stripAuthorNotes, sha256 } from "../lib/content.mjs";
import { escapeHtml as esc, renderMarkdown } from "../lib/markdown.mjs";
import { deriveKey, encrypt, KDF_ITERATIONS } from "../lib/vault.mjs";
import { buildNameIndex, linkCharacters } from "../lib/characters.mjs";
import { codexEntries, combinedIndex, countMentions, progressionItems } from "../lib/codex.mjs";
import { chapterDiff } from "../lib/diff.mjs";
import { parseTidyReport, parseAmbiguities } from "../lib/tidy.mjs";
import { parseQuizLines, lineInChapter, mineLines, pageGender } from "../lib/quiz.mjs";

const OUT = process.env.OUT_DIR || "_site";
const CONTENT = process.env.CONTENT_DIR || "content";
const UPDATES = process.env.UPDATES_FILE || "data/updates.json";
// Last published text of each chapter, and the latest revision's diff ("What changed" pages).
// Kept on the NAS next to updates.json; never committed (they hold chapter text).
const SNAPSHOTS = process.env.SNAPSHOT_DIR || join(dirname(UPDATES), "snapshots");
const CHANGES = join(dirname(SNAPSHOTS), "changes");
const config = JSON.parse(readFileSync("site.config.json", "utf8"));
const extrasCfg = config.extras || {};

if (!existsSync(CONTENT)) {
  console.error(`No ${CONTENT}/ folder. Run "npm run sync" (needs Drive credentials) or set CONTENT_DIR.`);
  process.exit(1);
}

const { main, extras, wiki, reference } = loadContent(CONTENT, config);

// ---------- Side story groups ----------
// From Side_Stories.md at the top of the Drive folder: "## Group" headings, each followed by a list of
// side stories in reading order (title, file name or link). Side stories it doesn't list come last,
// under "More side stories", in interlude-index order.
const sideFile = reference.find((r) => /^side[_ -]?stories\.md$/i.test(r.path));
const sideKey = (s) => s.toLowerCase().normalize("NFKD").replace(/^interlude[_ -]+-[_ -]+/, "").replace(/\.md$/, "").replace(/[^a-z0-9]/g, "").replace(/^the/, "");
const sideGroups = [];
const sideUnmatched = [];
if (sideFile) {
  const byKey = new Map();
  for (const c of extras) for (const k of [c.title, c.path, c.path.split("_-_").pop()]) if (!byKey.has(sideKey(k))) byKey.set(sideKey(k), c);
  const placed = new Set();
  let group = null;
  for (const line of sideFile.src.split("\n")) {
    const h = line.match(/^#{2,3}\s+(.+?)\s*$/);
    if (h) { group = { title: h[1], note: "", list: [] }; sideGroups.push(group); continue; }
    const item = line.match(/^\s*(?:[-*]|\d+[.)])\s+(.+?)\s*$/);
    if (!item) {
      if (group && !group.list.length && line.trim() && !/^#/.test(line)) group.note += (group.note ? " " : "") + line.trim();
      continue;
    }
    const raw = item[1].replace(/\s+[\u2014\u2013]\s.*$|\s+--?\s.*$/, "");
    const link = raw.match(/\[\[([^\]|]+)(?:\|[^\]]*)?\]\]|\[([^\]]+)\]\(([^)]+)\)/);
    const keys = link ? [link[1], link[2], link[3] && decodeURIComponent(link[3]).split("/").pop()].filter(Boolean) : [raw.replace(/[*_]/g, "")];
    const c = keys.map((k) => byKey.get(sideKey(k))).find(Boolean);
    if (!c) { sideUnmatched.push(raw); continue; }
    if (placed.has(c)) continue;
    placed.add(c);
    if (!group) { group = { title: "Side stories", note: "", list: [] }; sideGroups.push(group); }
    group.list.push(c);
  }
  const rest = extras.filter((c) => !placed.has(c));
  if (rest.length) sideGroups.push({ title: "More side stories", note: "", list: rest, rest: true });
  for (let i = sideGroups.length - 1; i >= 0; i--) if (!sideGroups[i].list.length) sideGroups.splice(i, 1);
  extras.splice(0, extras.length, ...sideGroups.flatMap((g) => g.list));
  for (const g of sideGroups) if (!g.rest) for (const c of g.list) c.group = g.title;
}

const chapters = [...main, ...extras];
const chapterByFile = new Map(chapters.map((c) => [c.path, c]));
const wikiByPath = new Map(wiki.map((p) => [p.path, p]));
const referenceByPath = new Map(reference.map((r) => [r.path, r]));
// A character page hidden by its status (CANDIDATE, PLANNED) still goes public once she is named in a
// published chapter or side story: she's on the page, so readers need her card. (The spoiler shield
// keeps her hidden from anyone who hasn't opened that story yet.)
const cardConfig = config.characterCards || {};
// "**Species:** Frosmoth" or "**Species and basics:** Frosmoth. 21, third-year …" (then the first sentence).
const SPECIES_RE = /\*\*Species([^*:\n]*):\*\*\s*([^\n]+)/;
const speciesOf = (src) => {
  const m = src.match(SPECIES_RE);
  if (!m) return "";
  return m[1].trim() ? m[2].split(/(?<=[^A-Z.])\.\s|;\s/)[0] : m[2];
};
const characterPool = wiki.filter((p) => p.section === "characters" && config.wiki.readerSections.includes("characters") && SPECIES_RE.test(p.src) && !(config.wiki.readerExclude || []).includes(p.rel));
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
  if (missingImages.size) console.warn(`${missingImages.size} picture(s) not found: see the build report in the author area.`);
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

const plainInlineEarly = (md) => renderMarkdown(md, { link: () => null, image: () => null }).replace(/^<p>|<\/p>\s*$/g, "").replace(/<[^>]+>/g, "").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&").trim();

// ---------- Character cards ----------
// Public character pages that describe a person (they have a "Species:" line), with what the card shows.
const characters = cardConfig.enabled === false ? [] : readerWiki
  .filter((p) => p.section === "characters" && SPECIES_RE.test(p.src))
  .map((p) => {
    const src = stripAuthorNotes(p.src, config);
    const species = speciesOf(src);
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

// ---------- Codex ----------
// Everything else a reader can look up: public world pages (lore, places, organizations) and the
// entries of registry pages (the locations page, the campus organizations page). First mentions in the
// prose get the same cards as characters; codex.html lists them all. See lib/codex.mjs.
const codexCfg = config.codex || {};
const codex = codexCfg.enabled === false ? [] : codexEntries(readerWiki.filter((p) => p.section !== "characters"), {
  kinds: codexCfg.kinds || {},
  registries: codexCfg.registries || [],
  skip: codexCfg.skip || [],
  strip: (src) => stripAuthorNotes(src, config),
  summarize: (md) => {
    const t = plainInlineEarly(stripAuthorNotes(md, config).split(/\n\s*\n|\n(?=\s*[-*] )/).map((x) => x.replace(/^\s*[-*]\s+/, "")).find((x) => /\p{L}{3}/u.test(x) && !/^\s*#/.test(x)) || "");
    const first = t.split(/(?<=[.!?])\s+/)[0];
    return first.length > 240 ? first.slice(0, 237).replace(/\s+\S*$/, "") + "…" : first;
  },
  urlFor: (p) => readerWikiUrl(p),
}).map((e) => ({ ...e, summary: e.summary ? plainInlineEarly(e.summary) : "" }));
const codexIndex = combinedIndex(nameIndex, codex);
const entryById = new Map([...characters.map((ch) => [ch.id, { ...ch, kind: "Character" }]), ...codex.map((e) => [e.id, e])]);

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
const unreadLinks = new Set(); // links into folders the site doesn't read (Sessions/ …)

// Resolves a Markdown link inside a Drive file to a site URL for the given tier.
function linkResolver(fromPath, base, tier) {
  return (href) => {
    if (!href || /^(https?:|mailto:|#)/i.test(href)) return href;
    const [file, frag] = href.split("#");
    const target = posix.normalize(posix.join(posix.dirname(fromPath), decodeURIComponent(file)));
    const hash = frag ? `#${frag}` : "";
    const wikiPage = wikiByPath.get(target);
    const chapter = chapterByFile.get(target) || (wikiPage?.manuscriptFile && chapterByFile.get(wikiPage.manuscriptFile));
    if (/\.md$/i.test(target) && !wikiPage && !chapter && !referenceByPath.has(target)) {
      // The site reads the top folder and wiki/ only, so a link into Sessions/ or another folder can't
      // resolve and isn't a mistake: counted, not listed.
      if (target.includes("/") && !target.startsWith(config.drive.wikiFolder + "/")) unreadLinks.add(`${fromPath}\u0000${target}`);
      else brokenLinks.set(`${fromPath}\u0000${target}`, { from: fromPath, href: target });
    }
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
    ...(codex.length ? [["codex", "Codex", "codex.html"]] : []),
    ...(extrasCfg.enabled ? [["extras", "Extras", "extras.html"]] : []),
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
      <span class="section-meta">${sideGroups.length ? `${extras.length} stories, in reading order` : "Not yet placed in the reading order"}</span>
    </div>
    ${
      sideGroups.length
        ? sideGroups
            .map(({ title, note, list }) => `<h3 class="arc-head"><span>${esc(title)}</span><span class="arc-meta">${list.length} ${list.length === 1 ? "story" : "stories"}</span></h3>${note ? `<p class="arc-note">${renderInlineSummary(note)}</p>` : ""}${tocList(list)}`)
            .join("")
        : tocList(extras)
    }
  </section>`
      : ""
  }
</main>`;
  return layout({ title: config.title, base: "", body, bodyClass: "page-home", current: "read" });
}

// ---------- "Before you read" box ----------
// Whose point of view the chapter is told from, who she is, and the characters it introduces.
// The narrator's name comes from the chapter's wiki manuscript page ("- POV: …"), else from the
// author note's opening ("Name POV, first person. …"). The rest of the note is planning
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
  return { name, style, id: id ? nameIndex.get(id) : null };
}

function introBox(c, newIds, povInfo) {
  const showPov = povInfo && !(introCfg.defaultPov && povInfo.name.toLowerCase().startsWith(introCfg.defaultPov.toLowerCase()));
  // The chapter's own one-liner: "- Intro: …" on its wiki manuscript page. Shown for interludes and side
  // stories (main chapters set themselves up in the prose).
  const page = manuscriptPageFor.get(c.path);
  const chapterIntro = (c.isInterlude || c.extra) && page?.intro ? renderInlineSummary(stripAuthorNotes(page.intro, config)) : "";
  // Main chapters introduce their characters in the prose; the list is for interludes and side stories,
  // where a reader may be meeting someone for the first time with no setup.
  const newcomers = c.isInterlude || c.extra ? [...newIds].map((id) => characterById.get(id)).filter((ch) => ch && ch.id !== povInfo?.id) : [];
  if (!showPov && !newcomers.length && !chapterIntro) return "";
  const charLink = (ch, label) => `<a class="char" href="${ch.url}" data-char="${ch.id}">${esc(label)}</a>`;
  const povChar = povInfo?.id && characterById.get(povInfo.id);
  const about = povChar ? [povChar.species, povChar.summary].filter(Boolean).join(" · ") : "";
  const storyHtml = chapterIntro ? `<p class="intro-story">${chapterIntro}</p>` : "";
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
  return `<aside class="chapter-intro" aria-label="Before you read">${storyHtml}${povHtml}${newHtml}</aside>`;
}

function chapterPage(c, prev, next) {
  const seen = new Set();
  const navLink = (ch, rel) =>
    ch
      ? `<a class="nav-link ${rel}" href="${ch.slug}.html" rel="${rel}">${rel === "prev" ? ICONS.left : ""}<span><small>${rel === "prev" ? "Previous" : "Next"}</small>${esc(ch.title)}</span>${rel === "next" ? ICONS.right : ""}</a>`
      : "";
  const end = `<a class="nav-link next" href="index.html#chapters"><span><small>The end — for now</small>Back to contents</span>${ICONS.list}</a>`;
  const proseHtml = linkCharacters(renderMarkdown(c.src, { link: linkResolver(c.path, "", "reader"), image: imageResolver(c.path, "", "reader") }), codexIndex, (id) => entryById.get(id)?.url || `wiki/characters/${id}.html`, seen);
  const povInfo = introCfg.enabled === false ? null : povFor(c);
  if (povInfo?.id) seen.add(povInfo.id); // told from her eyes counts as meeting her, even if her name never appears
  const newIds = [...seen].filter((id) => !appearances.has(id));
  const intro = introCfg.enabled === false ? "" : introBox(c, newIds, povInfo);
  const body = `
<main class="reader" data-slug="${c.slug}" data-title="${esc(c.title)}">
  <header class="chapter-head">
    <p class="chapter-label">${esc(c.label)}${arcFor(c) ? `<span class="chapter-arc"> · ${esc(arcFor(c).title)}</span>` : c.group ? `<span class="chapter-arc"> · ${esc(c.group)}</span>` : ""}</p>
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

// ---------- Extras (reader tier) ----------
// Two small games on extras.html, both behind the spoiler shield (extras.js asks it what the reader
// has opened): Who Said It?, from the lines in Quiz_Lines.md plus lines mined from every chapter, and
// Cast Shuffle, an interlude-prompt toy built from the public character pages, the places, moods and
// sparks in Cast_Shuffle.md, and more places from the wiki's locations page.
const plainText = (html) => html.replace(/<[^>]+>/g, "").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&").trim();
// Just the species ("Dachsbun, a pure Fairy. Box entry #927 …" → "Dachsbun"): the games show it small.
const shortSpecies = (html) => plainText(html).split(/[,.;(]|\s[—–-]\s/)[0].trim();
const quizProblems = []; // for the build report
let minedCount = 0;
const quizFile = extrasCfg.enabled ? reference.find((r) => r.path.toLowerCase() === (extrasCfg.quizFile || "Quiz_Lines.md").toLowerCase()) : null;
const quiz = (() => {
  if (!quizFile) return { lines: [], speakers: {} };
  const { lines, bad } = parseQuizLines(quizFile.src);
  for (const b of bad) quizProblems.push(`Couldn't read the line ${esc(b.slice(0, 80))}`);
  const speakers = {};
  const out = [];
  for (const q of lines) {
    const c = chapterByFile.get(q.file);
    const ch = characterById.get(q.slug);
    const where = `<code>${esc(q.file)}</code>`;
    if (!c) { quizProblems.push(`${where}: no published chapter or side story by that name — “${esc(q.text.slice(0, 60))}”`); continue; }
    if (!ch) { quizProblems.push(`${where}: <code>${esc(q.slug)}</code> has no public character page with a Species line — “${esc(q.text.slice(0, 60))}”`); continue; }
    if (!lineInChapter(q.text, c.src)) { quizProblems.push(`${where}: no longer in the chapter word for word — “${esc(q.text.slice(0, 80))}”`); continue; }
    const key = q.name ? `${q.slug}#${q.name}` : q.slug;
    // A page covering two people (the twins) has one species line for both, so a named speaker gets none.
    speakers[key] ||= { name: q.name || ch.name, page: ch.id, species: q.name ? "" : shortSpecies(ch.species), url: ch.url };
    out.push({ t: q.text, s: key, c: c.slug, l: c.label, n: c.title, h: q.hint });
  }
  // Then lines mined from every published chapter (lib/quiz.mjs, mineLines), so the quiz grows as the
  // story does. Every line counts the same: the game shuffles them all together.
  if (extrasCfg.autoQuiz !== false) {
    const fold = (t) => t.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
    const have = new Set(out.map((q) => fold(q.t)));
    const genders = Object.fromEntries(characters.map((ch) => [ch.id, pageGender(ch.page.src)]));
    for (const c of chapters) {
      const narrator = introCfg.enabled === false ? null : povFor(c)?.id || null;
      for (const m of mineLines(c.src, nameIndex, { narrator, genders })) {
        const ch = characterById.get(m.id);
        if (!ch || have.has(fold(m.text))) continue;
        have.add(fold(m.text));
        speakers[m.id] ||= { name: ch.name, page: ch.id, species: shortSpecies(ch.species), url: ch.url };
        out.push({ t: m.text, s: m.id, c: c.slug, l: c.label, n: c.title, h: m.hint });
        minedCount++;
      }
    }
  }
  return { lines: out, speakers };
})();

// Cast Shuffle's places, moods and sparks: Cast_Shuffle.md at the top of the vault, one list item per
// entry under "## Places", "## Moods" and "## Sparks" (kept out of this public repository).
const shuffleFile = extrasCfg.enabled ? reference.find((r) => r.path.toLowerCase() === (extrasCfg.castShuffleFile || "Cast_Shuffle.md").toLowerCase()) : null;
function readShuffle() {
  const lists = { places: [], moods: [], sparks: [] };
  let key = null;
  for (const line of (shuffleFile?.src || "").split("\n")) {
    const h = line.match(/^##\s+(.+?)\s*$/);
    if (h) { key = Object.keys(lists).find((k) => h[1].toLowerCase().startsWith(k.slice(0, -1))) || null; continue; }
    const li = key && line.match(/^\s*[-*]\s+(.+?)\s*$/);
    if (li) lists[key].push(li[1]);
  }
  return lists;
}

// More places for Cast Shuffle, from the public locations page (extras.placesPage): each "### Name"
// heading (a heading listing several, "The alley, the pork bun stand, …", gives one each) and each
// "- **Name:**" item. Only names, never the page's notes, and only places whose entry links a published
// chapter: the place then unlocks for readers who have opened that chapter. Places in Cast_Shuffle.md
// come first and keep their notes.
function wikiPlaces() {
  const page = wiki.find((p) => p.rel === (extrasCfg.placesPage || "world/locations.md"));
  if (!page || !readerWiki.includes(page)) return [];
  const chapterOf = (body) => {
    for (const [, href] of body.matchAll(/\]\(([^)]*manuscript\/[^)#]+)/g)) {
      const target = wikiByPath.get(posix.normalize(posix.join(posix.dirname(page.path), href)));
      const c = target?.manuscriptFile && chapterByFile.get(target.manuscriptFile);
      if (c) return c.slug;
    }
    return null;
  };
  const clean = (n) => n.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1").replace(/\s*\([^)]*\)/g, "").replace(/[*_`]/g, "").trim();
  const cap = (n) => n.charAt(0).toUpperCase() + n.slice(1);
  const out = [];
  const add = (names, body) => {
    const slug = chapterOf(body);
    if (!slug) return;
    for (const n of names) if (n && n.length <= 60 && !/^(how to|named places|see also|related|sources)/i.test(n)) out.push({ name: cap(n), note: "", a: [slug] });
  };
  // "### " blocks give their heading (the bullets inside are notes about that place); sections with no
  // "### " give their "- **Name:**" items, as in a list of places.
  for (const block of page.src.split(/^(?=##? )/m)) {
    const subs = block.split(/^(?=### )/m);
    for (const sub of subs) {
      const h = sub.match(/^### +(.+)$/m);
      if (h) add(clean(h[1]).split(/,\s+(?:and\s+)?/), sub);
      else if (subs.length === 1) for (const [, name, rest] of sub.matchAll(/^- \*\*([^*:]+):?\*\*:?(.*)$/gm)) add([clean(name)], rest);
    }
  }
  return out;
}

function extrasData() {
  const shuffle = readShuffle();
  return {
    characters: characters.map((ch) => ({ id: ch.id, name: ch.name, species: shortSpecies(ch.species), intro: plainText(ch.summary), url: ch.url, a: appearances.get(ch.id) || [] })),
    speakers: quiz.speakers,
    quiz: quiz.lines,
    places: (() => {
      const curated = (shuffle.places || []).map((p) => { const [name, note = ""] = p.split(/\s+[—–]\s+/); return { name, note }; });
      const key = (n) => n.toLowerCase().replace(/^the\s+/, "").replace(/[^\p{L}\p{N}]+/gu, "");
      const seen = new Set(curated.map((p) => key(p.name)));
      const extra = extrasCfg.wikiPlaces === false ? [] : wikiPlaces().filter((p) => !seen.has(key(p.name)) && seen.add(key(p.name)));
      return [...curated, ...extra];
    })(),
    moods: shuffle.moods || [],
    sparks: shuffle.sparks || [],
  };
}

function extrasPage() {
  const body = `
<main class="wiki extras">
  <header class="wiki-head">
    <h1 class="wiki-title">Extras</h1>
    <p class="wiki-lede">Two small games built from the story so far. Only characters and lines from chapters you've opened appear, unless the spoiler shield is off.</p>
  </header>
  <div class="x-tabs" role="tablist" aria-label="Extras">
    <button class="x-tab" role="tab" id="tab-quiz" aria-controls="quiz" data-x-tab="quiz">Who Said It?</button>
    <button class="x-tab" role="tab" id="tab-shuffle" aria-controls="shuffle" data-x-tab="shuffle">Cast Shuffle</button>
  </div>
  <section class="x-panel" id="quiz" role="tabpanel" aria-labelledby="tab-quiz">
    <p class="x-intro">A line of dialogue, four names. Who said it? Keys <kbd>1</kbd>–<kbd>4</kbd> answer, <kbd>Enter</kbd> moves on.</p>
    <div id="quiz-app" class="x-app"><p class="x-loading">Loading…</p></div>
  </section>
  <section class="x-panel" id="shuffle" role="tabpanel" aria-labelledby="tab-shuffle" hidden>
    <p class="x-intro">Two or three characters, a place, a mood and a spark: an interlude that hasn't been written. Lock what you like and shuffle the rest.</p>
    <div id="shuffle-app" class="x-app"><p class="x-loading">Loading…</p></div>
  </section>
  <noscript><p class="vault-status">The games need JavaScript.</p></noscript>
</main>`;
  return layout({ title: `Extras · ${config.title}`, description: `Games built from ${config.title}.`, base: "", body, bodyClass: "page-wiki page-extras", current: "extras", scripts: ["reader.js", "extras.js"] });
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
  let body = src.replace(/^#\s+.+\n?/m, "").replace(/^>\s+.+\n?/m, "");
  if (reader) body = body.replace(/^\*\*Reader summary:\*\*.*\n?/m, "").replace(/^-\s*(?:Reader\s+)?Intro:.*\n?/im, "");
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

// ---------- Codex page ----------
// Every entry a reader can look up, by kind, with a filter box. Entries the reader hasn't met are
// shielded like wiki cards (data-appears). Written after the chapter pages, which fill `appearances`.
const KIND_ORDER = ["Character", "Place", "Organization", "Lore"];
const chapterBySlug = new Map(chapters.map((c) => [c.slug, c]));
function codexPage() {
  const entries = [...entryById.values()];
  const kinds = [...new Set(entries.map((e) => e.kind))].sort((a, b) => ((KIND_ORDER.indexOf(a) + 1 || 99) - (KIND_ORDER.indexOf(b) + 1 || 99)) || a.localeCompare(b));
  const plural = (k) => (k === "Lore" ? "Lore" : `${k}s`);
  const card = (e) => {
    const a = appearances.get(e.id) || [];
    const first = a.length && chapterBySlug.get(a[0]);
    const also = (e.names || []).filter((n) => n !== e.name && !/^the /.test(n) && n.toLowerCase() !== e.name.toLowerCase().replace(/^the /, ""));
    const summary = e.kind === "Character" ? [e.species, e.summary].filter(Boolean).join(" · ") : esc(e.summary || "");
    const text = [e.name, e.kind, ...(e.names || []), plainText(summary)].join(" ").toLowerCase();
    return `
      <li data-filter-text="${esc(text)}"${a.length ? ` data-appears="${a.join(" ")}"` : ""}><a class="wiki-card codex-card" href="${e.url}">
        <span class="wiki-card-title">${esc(e.name)}</span>
        ${summary ? `<span class="wiki-card-summary">${summary}</span>` : ""}
        ${also.length ? `<span class="codex-also">Also: ${esc(also.join(", "))}</span>` : ""}
        ${first ? `<span class="codex-meta">First in ${esc(first.label)} · ${a.length} ${a.length === 1 ? "story" : "stories"}</span>` : ""}
      </a></li>`;
  };
  const body = `
<main class="wiki wiki-index codex">
  <header class="wiki-head">
    <h1 class="wiki-title">Codex</h1>
    <p class="wiki-lede">Every character, place, group and piece of lore, in one place. Names in the chapters open the same cards.</p>
  </header>
  <p class="shield-note" id="shield-note" hidden></p>
  <label class="filter">${ICONS.search}<input type="search" id="wiki-filter" placeholder="Filter the codex" autocomplete="off" aria-label="Filter the codex"></label>
  ${kinds
    .map((k) => {
      const list = entries.filter((e) => e.kind === k).sort((a, b) => a.name.localeCompare(b.name));
      return `
  <section class="wiki-section" data-filter-group>
    <div class="section-head"><h2>${esc(plural(k))}</h2><span class="section-meta">${list.length}</span></div>
    <ul class="wiki-grid">${list.map(card).join("")}</ul>
  </section>`;
    })
    .join("")}
  <p class="filter-empty" id="filter-empty" hidden>Nothing matches.</p>
</main>`;
  return layout({ title: `Codex · ${config.title}`, description: `Characters, places, groups and lore in ${config.title}.`, base: "", body, bodyClass: "page-wiki", current: "codex" });
}

// ---------- Continuity (author area) ----------
// For every character page (public or not) and codex entry: how often it's named in each story, when
// it was last seen, who has gone quiet, and its progression: the details its wiki page ties to a
// particular chapter, in reading order.
function continuityPage(linkFor) {
  const authorChars = wiki.filter((p) => p.section === "characters" && SPECIES_RE.test(p.src)).map((p) => ({ id: p.slug, name: p.title, page: p, kind: "Character", url: null }));
  const index = combinedIndex(buildNameIndex(authorChars, cardConfig), codex);
  const entries = [...authorChars, ...codex];
  const order = [...main, ...extras];
  const pos = new Map(order.map((c, i) => [c.slug, i]));
  const counts = new Map(); // id -> Map(slug -> n)
  for (const c of order) for (const [id, n] of countMentions(c.src.replace(/<!--[\s\S]*?-->/g, ""), index)) {
    if (!counts.has(id)) counts.set(id, new Map());
    counts.get(id).set(c.slug, n);
  }
  const lastMain = main.length - 1;
  const chapterLink = (c) => `<a href="../../${c.slug}.html">${esc(c.extra ? c.title : c.label)}</a>`;
  const byNumber = (n) => main.find((c) => !c.isInterlude && c.slot && c.slot[0] === n) || main.find((c) => c.slot && c.slot[0] === n) || null;
  const rows = entries.map((e) => {
    const m = counts.get(e.id) || new Map();
    const mainIdx = main.map((c, i) => (m.get(c.slug) ? i : -1)).filter((i) => i >= 0);
    const total = [...m.values()].reduce((a, b) => a + b, 0);
    const stories = [...m.keys()].sort((a, b) => pos.get(a) - pos.get(b));
    const silent = mainIdx.length ? lastMain - mainIdx[mainIdx.length - 1] : null;
    const page = e.page;
    const src = e.block ?? page.src;
    const chapterFor = (href) => {
      const target = wikiByPath.get(posix.normalize(posix.join(posix.dirname(page.path), decodeURIComponent(href))));
      return (target?.manuscriptFile && chapterByFile.get(target.manuscriptFile)) || null;
    };
    const prog = progressionItems(src, { chapterFor, chapterByNumber: byNumber }).sort((a, b) => pos.get(a.chapter.slug) - pos.get(b.chapter.slug));
    return { e, m, total, stories, mainIdx, silent, prog };
  });
  const strip = (r) => `<span class="cx-strip" aria-hidden="true">${main
    .map((c) => {
      const n = r.m.get(c.slug) || 0;
      return `<i class="cx-${n === 0 ? 0 : n < 3 ? 1 : n < 10 ? 2 : 3}" title="${esc(c.label)}: ${n}"></i>`;
    })
    .join("")}</span>`;
  const quiet = rows
    .filter((r) => r.e.kind === "Character" && r.mainIdx.length >= 3 && r.silent >= (config.continuity?.quietAfter ?? 8))
    .sort((a, b) => b.silent - a.silent);
  const entryHtml = (r) => {
    const first = r.stories[0] && chapterBySlug.get(r.stories[0]);
    const last = r.stories.at(-1) && chapterBySlug.get(r.stories.at(-1));
    const grouped = [];
    for (const it of r.prog) {
      if (grouped.at(-1)?.chapter !== it.chapter) grouped.push({ chapter: it.chapter, texts: [] });
      grouped.at(-1).texts.push(it.text);
    }
    const text = [r.e.name, r.e.kind, ...(r.e.names || [])].join(" ").toLowerCase();
    return `
    <details class="cx-entry" data-filter-text="${esc(text)}">
      <summary>
        <span class="cx-name">${esc(r.e.name)}</span>
        <span class="cx-stats">${r.total ? `${r.total} mention${r.total === 1 ? "" : "s"} in ${r.stories.length} ${r.stories.length === 1 ? "story" : "stories"}` : "Not named in the prose yet"}${r.silent ? ` · quiet for ${r.silent} chapter${r.silent === 1 ? "" : "s"}` : ""}</span>
        ${r.total ? strip(r) : ""}
      </summary>
      <div class="cx-body">
        ${first ? `<p class="cx-span">First ${chapterLink(first)} · last ${chapterLink(last)} · <a href="${linkFor(r.e.page.path)}">wiki page</a></p>` : `<p class="cx-span"><a href="${linkFor(r.e.page.path)}">wiki page</a></p>`}
        ${grouped.length
          ? `<ol class="cx-prog">${grouped.map((g) => `<li><p class="cx-when">${chapterLink(g.chapter)}${g.chapter.extra ? ` <span>Side story</span>` : ` <span>${esc(g.chapter.title)}</span>`}</p><ul>${g.texts.map((t) => `<li>${esc(t)}</li>`).join("")}</ul></li>`).join("")}</ol>`
          : `<p class="report-ok">No chapter-linked details on the wiki page yet.</p>`}
      </div>
    </details>`;
  };
  const sorted = (kind) => rows.filter((r) => r.e.kind === kind).sort((a, b) => b.total - a.total || a.e.name.localeCompare(b.e.name));
  const kinds = [...new Set(rows.map((r) => r.e.kind))].sort((a, b) => ((KIND_ORDER.indexOf(a) + 1 || 99) - (KIND_ORDER.indexOf(b) + 1 || 99)));
  const html = `
  <nav class="crumbs" aria-label="Breadcrumb"><a href="../index.html">Author area</a><span aria-hidden="true">›</span><span>Continuity</span></nav>
  <header class="wiki-head">
    <h1 class="wiki-title">Continuity</h1>
    <p class="wiki-lede">Where each character, place and piece of lore is named across the main chapters (one square per chapter, darker for more mentions), how long it has been quiet, and its progression: the details its wiki page ties to a chapter, in reading order. Add a <code>## Progression</code> section with <code>- Ch. 30: …</code> lines to a page for details the wiki doesn't cite yet.</p>
  </header>
  <label class="filter">${ICONS.search}<input type="search" id="wiki-filter" placeholder="Filter" autocomplete="off" aria-label="Filter"></label>
  ${quiet.length ? `<section class="wiki-section cx-quiet"><div class="section-head"><h2>Gone quiet</h2><span class="section-meta">${quiet.length}</span></div>
    <p>Characters named in at least three main chapters who haven't been named in the last ${config.continuity?.quietAfter ?? 8} or more.</p>
    <ul>${quiet.map((r) => `<li><strong>${esc(r.e.name)}</strong> · last in ${chapterLink(main[r.mainIdx.at(-1)])} · quiet for ${r.silent} chapters</li>`).join("")}</ul></section>` : ""}
  ${kinds.map((k) => `
  <section class="wiki-section" data-filter-group>
    <div class="section-head"><h2>${esc(k === "Lore" ? "Lore" : k + "s")}</h2><span class="section-meta">${sorted(k).length}</span></div>
    <div class="cx-list">${sorted(k).map(entryHtml).join("")}</div>
  </section>`).join("")}
  <p class="filter-empty" id="filter-empty" hidden>Nothing matches.</p>`;
  return { html, quiet: quiet.length, entries: rows.length };
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
    `A page links to a file that doesn't exist: deleted, renamed, or misspelled.${unreadLinks.size ? ` (${unreadLinks.size} link${unreadLinks.size === 1 ? "" : "s"} into folders the site doesn't read, like Sessions, ${unreadLinks.size === 1 ? "is" : "are"} left out.)` : ""}`,
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

  if (sideFile) {
    add("Side stories missing from Side_Stories.md", "Shown at the end, under More side stories. Add each to a group in Side_Stories.md.",
      (sideGroups.find((g) => g.rest)?.list || []).map((c) => `${esc(c.title)} — ${code(c.path)}`));
    add("Lines in Side_Stories.md that match no side story", "Check the spelling, or the story may now have a slot (then it's under Chapters) or not exist yet.", sideUnmatched.map(esc));
  }

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

  add("Characters without an Intro line", "Public character pages with no \"- Intro:\" line. Their card and introduction box use the summary at the top of the wiki page instead, which may say more than readers should know yet.",
    characters.filter((ch) => !ch.page.readerSummary).map((ch) => `${esc(ch.name)} — ${code(ch.page.rel)}`), false);

  if (extrasCfg.enabled && !(shuffleFile && readShuffle().places.length && readShuffle().sparks.length))
    add("Cast Shuffle has nothing to deal", `${code(extrasCfg.castShuffleFile || "Cast_Shuffle.md")} is missing at the top of the vault, or has no places or sparks. Give it "## Places", "## Moods" and "## Sparks" headings with one list item per entry.`, ["The game stays hidden until it does."]);
  if (quizFile) {
    add("Quiz lines left out", `Lines in ${code(quizFile.path)} the Who Said It? game can't use: the chapter was revised, the file or page was renamed, or the speaker has no public page. ${quiz.lines.length} line${quiz.lines.length === 1 ? "" : "s"} are in the game.`, quizProblems);
  }

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

// ---------- Tidy board (author area) ----------
// The wiki's punch list (wiki/tidy-report.md) and its ambiguities file as cards: Open items first,
// with how long ago each CHECK was last verified; then decisions, ambiguities and the resolved record.
// reader.js adds the tabs, the filter box and the file chips once the page is unlocked.
const tidyFile = wikiByPath.get(`${config.drive.wikiFolder}/tidy-report.md`);
const ambiguitiesFile = wikiByPath.get(`${config.drive.wikiFolder}/ambiguities.md`);
const tidy = tidyFile ? parseTidyReport(tidyFile.src) : null;
if (tidy && ambiguitiesFile) tidy.items.push(...parseAmbiguities(ambiguitiesFile.src));

function tidyBoard(linkFor) {
  const { items, notes, updated, passes } = tidy;
  const count = (k) => items.filter((i) => i.kind === k).length;
  const open = items.filter((i) => i.kind === "open");
  const inline = (md) => renderMarkdown(md, { link: linkFor, image: () => null }).replace(/^<p>|<\/p>\s*$/g, "");
  const tabs = [
    ["open", "Open", "Defects waiting on a ruling. Each carries a CHECK the nightly run re-tests."],
    ["decision", "Decisions", "Nothing broken: the story hasn't reached these yet."],
    ["ambiguity", "Ambiguities", "Missing details and wording to reconcile, from ambiguities.md."],
    ["resolved", "Resolved", "The record, newest pass first."],
  ];
  const card = (it) => {
    const badges = [];
    if (it.noCheck) badges.push(`<span class="t-badge t-bad">No CHECK line</span>`);
    if (it.unverified) badges.push(`<span class="t-badge t-warn">Unverified this run</span>`);
    if (it.judgement) badges.push(`<span class="t-badge">Judgement</span>`);
    if (it.kind === "open" && it.verified) badges.push(`<span class="t-badge" data-verified="${it.verified}">Verified ${it.verified}</span>`);
    const text = `${it.title} ${it.body} ${it.check || ""} ${it.group}`.toLowerCase();
    return `<li class="t-item t-${it.kind}" data-kind="${it.kind}" data-files="${esc(it.files.join("|"))}" data-text="${esc(text)}">
      <p class="t-title">${it.num ? `<span class="t-num">${esc(it.num)}.</span>` : ""}${inline(it.title)}</p>
      ${badges.length ? `<p class="t-badges">${badges.join("")}</p>` : ""}
      ${it.body ? `<div class="t-body">${inline(it.body)}</div>` : ""}
      ${it.check ? `<p class="t-check"><span>CHECK</span> ${inline(it.check)}</p>` : ""}
      ${it.files.length ? `<p class="t-files">${it.files.map((f) => `<code>${esc(f)}</code>`).join("")}</p>` : ""}
    </li>`;
  };
  const panel = ([kind, label, about]) => {
    const list = items.filter((i) => i.kind === kind);
    let html = "";
    let group;
    for (const it of list) {
      if (kind !== "open" && kind !== "decision" && it.group !== group) {
        html += `${group !== undefined ? "</ol>" : ""}<h3 class="t-group">${inline(it.group || "Ungrouped")}</h3><ol class="t-list">`;
        group = it.group;
      }
      html += card(it);
    }
    if (group !== undefined) html += "</ol>";
    else if (list.length) html = `<ol class="t-list">${html}</ol>`;
    const empty = notes[kind] ? inline(notes[kind]) : `Nothing here.`;
    return `<section class="t-panel" data-tidy-panel="${kind}"${kind === "open" ? "" : " hidden"} aria-label="${label}">
      <p class="t-about">${about}</p>
      ${list.length ? html : `<p class="t-empty">${empty}</p>`}
    </section>`;
  };
  const stale = open.filter((i) => i.noCheck || i.unverified).length;
  const html = `
  <nav class="crumbs" aria-label="Breadcrumb"><a href="../index.html">Author area</a><span aria-hidden="true">›</span><span>Tidy board</span></nav>
  <header class="wiki-head">
    <h1 class="wiki-title">Tidy board</h1>
    <p class="wiki-lede">The wiki's punch list${updated ? `, last updated ${esc(updated)}` : ""}${passes ? ` · ${passes} fix passes` : ""}. <a href="${linkFor("tidy-report.md")}">Open the full report</a>.</p>
  </header>
  <div class="stats-grid tidy-stats">
    <div class="stat${open.length ? " stat-alert" : ""}"><span class="stat-label">Open</span><span class="stat-value">${open.length}</span><span class="stat-note">${open.length ? "needs a ruling" : "nothing waiting"}</span></div>
    <div class="stat${stale ? " stat-alert" : ""}"><span class="stat-label">Unchecked</span><span class="stat-value" id="tidy-stale">${stale}</span><span class="stat-note">no CHECK, or not verified</span></div>
    <div class="stat"><span class="stat-label">Decisions</span><span class="stat-value">${count("decision")}</span><span class="stat-note">waiting on the draft</span></div>
    <div class="stat"><span class="stat-label">Resolved</span><span class="stat-value">${count("resolved")}</span><span class="stat-note">on record</span></div>
  </div>
  <div class="tidy">
    <div class="x-tabs" role="tablist" aria-label="Tidy board">${tabs.map(([k, l], i) => `<button class="x-tab" role="tab" data-tidy-tab="${k}" aria-selected="${i === 0}">${l} <span class="t-count">${count(k)}</span></button>`).join("")}</div>
    <label class="filter">${ICONS.search}<input type="search" id="tidy-filter" placeholder="Filter by words or a file name" autocomplete="off" aria-label="Filter items"></label>
    <p class="t-chips" id="tidy-chips"></p>
    ${tabs.map(panel).join("")}
    <p class="t-empty" id="tidy-none" hidden>No items match.</p>
  </div>`;
  return { html, open: open.length, stale };
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
  const continuityId = authorId("\u0000continuity");
  const continuity = continuityPage((path) => `${authorId(path)}.html`);
  write(`author/p/${continuityId}.html`, vaultShell(await seal(`Continuity · Author`, continuity.html), "../../"));
  const tidyId = authorId("\u0000tidy-board");
  const board = tidy && tidyBoard(linkResolver(tidyFile.path, "../../", "author"));
  if (board) write(`author/p/${tidyId}.html`, vaultShell(await seal(`Tidy board · Author`, board.html), "../../"));
  const directory = `
  <header class="wiki-head">
    <div class="wiki-head-row"><h1 class="wiki-title">Author area</h1><button class="btn btn-ghost btn-small" id="sign-out" type="button">Sign out</button></div>
    <p class="wiki-lede">Everything in the Drive wiki, unfiltered, plus the reference files at the folder root.</p>
  </header>
  <div class="author-banners">
    <a class="report-banner${report.issues ? " has-issues" : ""}" href="p/${reportId}.html">
      <span><strong>Build report</strong>${report.issues ? `${report.issues} thing${report.issues === 1 ? "" : "s"} to look at` : "Nothing to fix"}</span>${ICONS.right}
    </a>
    ${board ? `<a class="report-banner${board.open ? " has-issues" : ""}" href="p/${tidyId}.html">
      <span><strong>Tidy board</strong>${board.open ? `${board.open} open item${board.open === 1 ? "" : "s"} in the wiki's punch list` : "The wiki's punch list is clear"}</span>${ICONS.right}
    </a>` : ""}
    <a class="report-banner${continuity.quiet ? " has-issues" : ""}" href="p/${continuityId}.html">
      <span><strong>Continuity</strong>${continuity.entries} entries${continuity.quiet ? ` · ${continuity.quiet} gone quiet` : ""}</span>${ICONS.right}
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
// After the chapter pages: extras.json carries where each character appears, for the spoiler shield.
if (extrasCfg.enabled) {
  write("extras.html", extrasPage());
  write("extras.json", JSON.stringify(extrasData()));
}
write("characters.json", JSON.stringify(Object.fromEntries([
  ...characters.map(({ id, name, species, summary, image, url }) => [id, { name, species, summary, image, url }]),
  ...codex.map(({ id, name, kind, summary, url }) => [id, { name, species: kind, summary: esc(summary), url }]),
])));
if (codex.length) write("codex.html", codexPage());
const authorPages = await buildAuthorTier();
const imageCount = await writeImages();

console.log(
  `Built ${main.length} chapters/interludes, ${extras.length} side stories, ` +
    `${readerWiki.length} public wiki pages, ${authorPages} author pages, ${imageCount} illustrations into ${OUT}/` +
    (firstRun ? " (first run: update dates seeded from Drive)" : "")
);
