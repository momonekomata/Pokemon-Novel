// More than one title on the site. The main title (site.config.json) lives at the top of the text
// repository; every other title is a top-level folder holding a Book.md, laid out the same way inside
// (chapters at the top of the folder, its own wiki/ beneath). Book.md names the title:
//
//   # The Title
//   - Subtitle: …
//   - Description: one or two sentences for the shelf
//   - Author: … (defaults to the site's author)
//   - Cover: picture.png (a picture in the illustrations folder)
//   - Order: 2 (place on the shelf; the main title is 1)
//   - Status: Ongoing / Complete / On hiatus (shown on the shelf)
//
// plus, optionally, a ```json block of site settings for this title only (same shape as
// site.config.json, e.g. {"manuscript": {"introBox": {"defaultPov": "Mika"}}}).
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const BOOK_FILE = "Book.md";

export const kebab = (s) =>
  s.toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

const field = (src, name) => {
  const m = src.match(new RegExp(`^\\s*[-*]\\s*(?:\\*\\*)?${name}:(?:\\*\\*)?\\s*(.+?)\\s*$`, "im"));
  return m ? m[1].replace(/\*\*/g, "").trim() : "";
};

export function parseBook(src, folder) {
  const h1 = src.match(/^#\s+(.+)$/m);
  const json = src.match(/```json\s*\n([\s\S]*?)```/);
  let settings = {};
  if (json) {
    try { settings = JSON.parse(json[1]); } catch (e) { console.warn(`${folder}/${BOOK_FILE}: the json block isn't valid JSON (${e.message}); ignored.`); }
  }
  const cover = field(src, "Cover").replace(/^!?\[\[|\]\]$/g, "").replace(/^!\[[^\]]*\]\(<?|>?\)$/g, "");
  return {
    id: kebab(folder) || "book",
    folder,
    title: h1 ? h1[1].trim() : folder.replace(/_/g, " "),
    subtitle: field(src, "Subtitle"),
    description: field(src, "Description"),
    author: field(src, "Author"),
    cover,
    status: field(src, "Status"),
    order: Number(field(src, "Order")) || 100,
    settings,
  };
}

// Top-level folders with a Book.md, in a checkout of the text repository (or its copy in content/).
export function findBooks(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && !/^[._]/.test(d.name) && existsSync(join(dir, d.name, BOOK_FILE)))
    .map((d) => parseBook(readFileSync(join(dir, d.name, BOOK_FILE), "utf8"), d.name))
    .sort((a, b) => a.order - b.order || a.title.localeCompare(b.title));
}

const isObj = (v) => v && typeof v === "object" && !Array.isArray(v);
export function deepMerge(a, b) {
  const out = { ...a };
  for (const [k, v] of Object.entries(b || {})) out[k] = isObj(v) && isObj(a?.[k]) ? deepMerge(a[k], v) : v;
  return out;
}

// Settings for another title: the site's shared settings, without everything that belongs to the
// main title (its names, its wiki's pages, its cast), then the title's own.
export function bookConfig(config, book) {
  const c = structuredClone(config);
  delete c.books;
  delete c.arcs;
  if (c.manuscript) {
    delete c.manuscript.interludeIndex;
    c.manuscript.exclude = [];
    if (c.manuscript.introBox) delete c.manuscript.introBox.defaultPov;
  }
  if (c.wiki) c.wiki.readerExclude = [];
  if (c.characterCards) { c.characterCards.aliases = {}; c.characterCards.ignoreNames = []; }
  if (c.codex) { c.codex.registries = []; c.codex.kinds = {}; c.codex.skip = []; }
  c.title = book.title;
  c.subtitle = book.subtitle;
  c.description = book.description || book.subtitle || "";
  if (book.author) c.author = book.author;
  return deepMerge(c, book.settings);
}
