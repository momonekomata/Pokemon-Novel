// Reads the mirrored Drive folder (content/) into chapters and wiki pages.
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, posix } from "node:path";

const norm = (s) => s.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]/g, "");
const kebab = (s) => s.toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
export const sha256 = (s) => createHash("sha256").update(s).digest("hex");

function listMarkdown(dir, prefix = "") {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
    const rel = prefix ? `${prefix}/${d.name}` : d.name;
    if (d.isDirectory()) return listMarkdown(join(dir, d.name), rel);
    return d.name.toLowerCase().endsWith(".md") ? [rel] : [];
  });
}

export function loadContent(root, config) {
  const metaFile = join(root, ".drive-meta.json");
  const driveMeta = existsSync(metaFile) ? JSON.parse(readFileSync(metaFile, "utf8")) : {};
  const files = listMarkdown(root);
  const read = (path) => readFileSync(join(root, path), "utf8").replace(/\r\n/g, "\n");
  const times = (path) => {
    const m = driveMeta[path];
    if (m) return { created: m.createdTime, modified: m.modifiedTime };
    const st = statSync(join(root, path));
    return { created: st.birthtime.toISOString(), modified: st.mtime.toISOString() };
  };

  const wikiPrefix = config.drive.wikiFolder + "/";
  const wikiFiles = files.filter((f) => f.startsWith(wikiPrefix));
  const rootFiles = files.filter((f) => !f.includes("/"));

  // ---------- Wiki ----------
  const wiki = wikiFiles.map((path) => {
    const rel = path.slice(wikiPrefix.length);
    const src = read(path);
    const h1 = src.match(/^#\s+(.+)$/m);
    const summary = src.match(/^>\s+(.+)$/m);
    const status = src.match(/\*\*Status:\*\*\s*([^\n]*)/);
    const file = src.match(/^-\s*File:\s*\[[^\]]*\]\(([^)]+)\)/m);
    const section = rel.includes("/") ? rel.split("/")[0] : "";
    return {
      path, // e.g. wiki/characters/akagi-ruri.md
      rel, // e.g. characters/akagi-ruri.md
      section,
      slug: kebab(posix.basename(rel, ".md")),
      title: h1 ? h1[1].trim() : posix.basename(rel, ".md").replace(/-/g, " "),
      summary: summary ? summary[1].trim() : "",
      status: status ? status[1].trim() : "",
      manuscriptFile: file ? posix.normalize(posix.join(posix.dirname(path), file[1].split("#")[0])) : null,
      src,
      ...times(path),
    };
  });
  const wikiByPath = new Map(wiki.map((p) => [p.path, p]));

  // ---------- Reading order from the interlude index ----------
  const m = config.manuscript;
  const slotByFile = new Map(); // root filename -> [slot, row]
  const slotByTitle = new Map();
  const mentionOrder = new Map(); // root filename or normalized title -> first mention position
  const indexPage = wikiByPath.get(m.interludeIndex);
  if (indexPage) {
    const toRootFile = (href) => {
      const target = wikiByPath.get(posix.normalize(posix.join(posix.dirname(indexPage.path), href.split("#")[0])));
      return target && target.manuscriptFile;
    };
    const slotted = indexPage.src.split(/^## /m).find((s) => /^Slotted interludes/i.test(s)) || "";
    let row = 0;
    for (const line of slotted.split("\n")) {
      const cells = line.split("|").map((c) => c.trim());
      const link = cells[1] && cells[1].match(/^\[~?([\d.]+)[^\]]*\]\(([^)]+)\)/);
      if (!link) continue;
      const slot = [parseFloat(link[1]), row++];
      const file = toRootFile(link[2]);
      if (file) slotByFile.set(file, slot);
      if (cells[2]) slotByTitle.set(norm(cells[2]), slot);
    }
    let pos = 0;
    for (const [, text, href] of indexPage.src.matchAll(/\[([^\]]+)\]\(([^)]*manuscript\/[^)]+)\)/g)) {
      const file = toRootFile(href);
      for (const key of [file, norm(text)]) if (key && !mentionOrder.has(key)) mentionOrder.set(key, pos);
      pos++;
    }
  }

  // ---------- Chapters and interludes ----------
  const chapterRe = new RegExp(m.chapterPattern);
  const interludeRe = new RegExp(m.interludePattern);
  const excluded = new Set(m.exclude || []);
  const manuscript = rootFiles
    .filter((f) => !excluded.has(f) && (chapterRe.test(f) || interludeRe.test(f)))
    .map((path) => {
      let src = read(path);
      const h1 = src.match(/^#\s+(.+)$/m);
      const fallbackTitle = path.replace(/\.md$/, "").split("_-_").pop().replace(/_/g, " ");
      let title = h1 ? h1[1].trim() : fallbackTitle;
      for (let i = 0; i < 2; i++) title = title.replace(/^(chapter\s+[\d.]+|interlude)\s*[:—–-]?\s*/i, "");
      title = title || fallbackTitle;
      if (h1) src = src.replace(h1[0], "");
      src = src.trim();
      if (m.hideLeadingAuthorNote) src = src.replace(/^[*_]\([\s\S]*?\)[*_]\s*(\n\n|$)/, "").trim();

      const num = path.match(chapterRe);
      const isInterlude = interludeRe.test(path) || /Interlude/i.test(path);
      let slot = null;
      if (num) slot = [parseFloat(num[2] ? `${num[1]}.${num[2]}` : num[1]), 0];
      else slot = slotByFile.get(path) || slotByTitle.get(norm(title)) || slotByTitle.get(norm(fallbackTitle)) || null;
      if (num && num[2] && slotByFile.has(path)) slot = slotByFile.get(path);

      const words = src.split(/\s+/).filter(Boolean).length;
      const slotLabel = slot ? String(slot[0]) : "";
      return {
        path,
        src,
        title,
        slot,
        isInterlude,
        extra: !slot,
        slug: num && !isInterlude ? `ch-${slotLabel.replace(".", "-")}` : `interlude-${kebab(title)}`,
        label: !slot ? "Side story" : isInterlude ? `Interlude ${slotLabel}` : `Chapter ${slotLabel}`,
        order: mentionOrder.get(path) ?? mentionOrder.get(norm(title)) ?? Infinity,
        words,
        minutes: Math.max(1, Math.round(words / 230)),
        hash: sha256(src.replace(/\s+/g, " ")),
        ...times(path),
      };
    });

  const main = manuscript.filter((c) => !c.extra).sort((a, b) => a.slot[0] - b.slot[0] || a.slot[1] - b.slot[1] || a.title.localeCompare(b.title));
  const extras = manuscript.filter((c) => c.extra).sort((a, b) => a.order - b.order || a.title.localeCompare(b.title));

  // Same slug twice (e.g. two files with one title) gets a numeric suffix.
  const seen = new Map();
  for (const c of [...main, ...extras]) {
    const n = seen.get(c.slug) || 0;
    seen.set(c.slug, n + 1);
    if (n) c.slug += `-${n + 1}`;
  }

  const manuscriptFiles = new Set(manuscript.map((c) => c.path));
  const reference = rootFiles
    .filter((f) => !manuscriptFiles.has(f))
    .map((path) => {
      const src = read(path);
      const h1 = src.match(/^#\s+(.+)$/m);
      return { path, src, title: h1 ? h1[1].trim() : path.replace(/\.md$/, "").replace(/_/g, " "), ...times(path) };
    })
    .sort((a, b) => a.path.localeCompare(b.path));

  return { main, extras, wiki, reference };
}

// ---------- Reader-tier wiki filtering ----------

export function isReaderPage(page, config) {
  const w = config.wiki;
  if (!w.readerSections.includes(page.section)) return false;
  if ((w.readerExclude || []).includes(page.rel)) return false;
  const status = page.status.toUpperCase();
  return !(w.readerHideStatus || []).some((s) => status.startsWith(s.toUpperCase()));
}

// Removes author-facing material: status lines, source citations, rulings and notes sections.
export function stripAuthorNotes(src, config) {
  const strip = (config.wiki.readerStripHeadings || []).map((h) => h.toLowerCase());
  const sections = src.split(/^(?=## )/m).filter((sec) => {
    const heading = sec.match(/^## +(.+)/);
    return !heading || !strip.some((h) => heading[1].trim().toLowerCase().startsWith(h));
  });
  return sections
    .join("")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/^\*\*Type:\*\*.*\n?/gm, "")
    .replace(/\s?\((?:\s*\[[^\]]*\]\([^)]*\)[^()[\]]*?)+\)/g, (m) => (/^\s?\(\s*\[/.test(m) ? "" : m))
    .replace(/\s?\((?:author-ruled|ruled|added|pinned|converted|resolved|found|corrected)\b[^()]*\)/gi, "")
    .replace(/\n{3,}/g, "\n\n");
}
