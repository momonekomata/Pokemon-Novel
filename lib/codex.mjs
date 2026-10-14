// The codex: every named thing a reader can look up, not just characters. Characters come from the
// character pages (as before); this adds the public world pages (lore, places, organizations) and the
// entries of "registry" pages that list many named things under headings (the locations page, the
// campus organizations page). Each entry gets the names it can be found by in the prose.

const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
export const kebab = (s) =>
  s.toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

// A one-word name is only used when it can't be an ordinary word: non-ASCII letters, dots or hyphens
// (Myōjinzawa, F.E.T.C.H., Tsukuyomi-kō), or when the whole title is that one word.
const distinctive = (w) => /[^\x00-\x7f]|[.\-]/.test(w);

// Names a page title can be found by: "The Flower Almanac" → also "Flower Almanac" and "the Flower
// Almanac"; "Tsukuyomi-kō (月詠講)" → "Tsukuyomi-kō"; "L.E.A.P.: League of …" → both halves.
export function namesFromTitle(title, { allowOneWord = false } = {}) {
  const out = new Set();
  const add = (n) => {
    n = n.replace(/\s+/g, " ").trim().replace(/[,;:]$/, "");
    if (!n || n.length < 3 || !/^[\p{Lu}0-9]/u.test(n)) return;
    if (!n.includes(" ") && !allowOneWord && !distinctive(n)) return;
    out.add(n);
  };
  const base = title.replace(/\s*\([^)]*\)\s*/g, " ").trim();
  for (const part of [base, ...base.split(/:\s+/)]) {
    add(part);
    const noThe = part.replace(/^The\s+/i, "");
    if (noThe !== part) {
      // "The alley" is a description, not a name: only "The Flower Almanac"-style names count.
      if (!/^[\p{Lu}0-9]/u.test(noThe)) { out.delete(part.trim()); continue; }
      add(noThe);
      if (noThe.includes(" ") || distinctive(noThe)) out.add(`the ${noThe}`);
    }
  }
  // "Myōjinzawa and the Hoshimiya Operation" → "Myōjinzawa" (only a distinctive first part).
  const first = base.split(/\s+and\s+/)[0];
  if (first !== base && !/,/.test(first) && distinctive(first)) add(first);
  return [...out];
}

const aliasLine = (src) => {
  const m = src.match(/^-\s*(?:\*\*)?Aliases?:(?:\*\*)?\s*(.+)$/im);
  return m ? m[1].split(/[,;]\s*/).map((a) => a.replace(/[*_`"“”]/g, "").trim()).filter(Boolean) : [];
};

const SKIP_HEADING = /^(the state of play|other\b|open\b|spoilers?|implications|related|sources?|how to use|named places|summary|notes?|see also)/i;

// Entries from one registry page: one per heading at `level` (2 or 3), named by it.
function registryEntries(page, src, { level, kind }, summarize) {
  const hashes = "#".repeat(level);
  const blocks = src.split(new RegExp(`^(?=${hashes} )`, "m")).slice(1);
  const out = [];
  for (const block of blocks) {
    const h = block.match(new RegExp(`^${hashes} +(.+)$`, "m"));
    if (!h) continue;
    const heading = h[1].replace(/\[([^\]]+)\]\([^)]*\)/g, "$1").replace(/[*_`]/g, "").trim();
    if (SKIP_HEADING.test(heading)) continue;
    // A heading listing several ("The alley, the pork bun stand, Ward Office No. 3") gives one each.
    const parts = /,/.test(heading.replace(/\([^)]*\)/g, "")) ? heading.split(/,\s+(?:and\s+)?/) : [heading];
    const body = block.slice(h[0].length).split(new RegExp(`^#{1,${level}} `, "m"))[0];
    for (const part of parts) {
      const names = namesFromTitle(part);
      if (!names.length) continue;
      const name = part.replace(/\s*\([^)]*\)\s*/g, " ").trim();
      out.push({ id: `${kind[0].toLowerCase()}-${kebab(name)}`, name, kind, names, summary: summarize(body), page, block: body });
    }
  }
  return out;
}

// All codex entries other than characters.
//   pages: public world pages; strip(src) removes author material; summarize(md) gives a one-liner.
export function codexEntries(pages, { kinds = {}, registries = [], skip = [], strip, summarize, urlFor }) {
  const out = [];
  const registryPages = new Map(registries.map((r) => [r.page, r]));
  for (const page of pages) {
    if (skip.includes(page.rel) || /(^|\/)index\.md$/.test(page.rel)) continue;
    const src = strip(page.src);
    const reg = registryPages.get(page.rel);
    if (reg) {
      for (const e of registryEntries(page, src, reg, summarize)) out.push({ ...e, url: urlFor(page) });
      if (!reg.alsoPage) continue;
    }
    const names = [...namesFromTitle(page.title, { allowOneWord: !page.title.trim().includes(" ") }), ...aliasLine(page.src)];
    if (!names.length) continue;
    out.push({
      id: `w-${page.slug}`,
      name: page.title.replace(/\s*\([^)]*\)\s*$/, "").trim(),
      kind: kinds[page.rel] || "Lore",
      names,
      summary: page.readerSummary || page.summary,
      page,
      url: urlFor(page),
    });
  }
  // A registry entry that a page of its own already covers (Man'yō University) gives way to the page.
  const pageNames = new Set(out.filter((e) => e.id.startsWith("w-")).flatMap((e) => e.names));
  return out.filter((e) => e.id.startsWith("w-") || !e.names.some((n) => pageNames.has(n)));
}

// One name index for characters and codex entries. Characters keep their names when a codex entry
// claims the same one; a name two codex entries share is dropped (it would link the wrong one).
export function combinedIndex(characterIndex, entries) {
  const owners = new Map();
  for (const e of entries) for (const n of e.names) {
    if (characterIndex.has(n)) continue;
    if (!owners.has(n)) owners.set(n, new Set());
    owners.get(n).add(e.id);
  }
  const index = new Map(characterIndex);
  for (const [n, ids] of owners) if (ids.size === 1) index.set(n, [...ids][0]);
  return index;
}

// How many times each entry is named in a text (for the author's mention tracker).
export function countMentions(text, index) {
  const counts = new Map();
  if (!index.size) return counts;
  const names = [...index.keys()].sort((a, b) => b.length - a.length);
  const re = new RegExp(`(?<![\\p{L}\\p{N}])(?:${names.map(escRe).join("|")})(?![\\p{L}\\p{N}])`, "gu");
  for (const m of text.matchAll(re)) {
    const id = index.get(m[0]);
    counts.set(id, (counts.get(id) || 0) + 1);
  }
  return counts;
}

// Progressions: the details a page ties to a particular chapter, so an author can see how an entry
// changes over the story. Every bullet or sentence that links a chapter (through its wiki manuscript
// page) becomes one item; a "## Progression" section's "- Ch. 30: …" lines count too.
//   chapterFor(href) → chapter or null; chapterByNumber(n) → chapter or null.
export function progressionItems(src, { chapterFor, chapterByNumber }) {
  const items = [];
  const seen = new Set();
  const clean = (t) =>
    t
      .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
      .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
      .replace(/\s*\((?:this chapter|ibid\.?)\)/gi, "")
      .replace(/[*_`]/g, "")
      .replace(/\s+/g, " ")
      .trim();
  const push = (chapter, text) => {
    text = clean(text);
    if (!chapter || text.length < 12) return;
    if (text.length > 320) text = text.slice(0, 317).replace(/\s+\S*$/, "") + "…";
    const key = `${chapter.slug}\u0000${text}`;
    if (seen.has(key)) return;
    seen.add(key);
    items.push({ chapter, text });
  };
  // Explicit progression lines.
  const prog = src.split(/^(?=## )/m).find((s) => /^## +Progressions?\b/i.test(s)) || "";
  for (const [, ref, text] of prog.matchAll(/^\s*[-*]\s+(?:\*\*)?(?:Ch(?:apter)?\.?\s*([\d.]+))(?:\*\*)?\s*[:—–-]\s*(.+)$/gim)) push(chapterByNumber(parseFloat(ref)), text);
  // Everything else that cites a chapter.
  const body = src
    .replace(prog, "")
    .split(/^(?=## )/m)
    .filter((sec) => !/^## +(Sources?|Related|Appears in|Appearances|See also)\b/i.test(sec))
    .join("")
    .replace(/<!--[\s\S]*?-->/g, "");
  for (const block of body.split(/\n(?=\s*[-*]\s)|\n\s*\n/)) {
    if (/^\s*#/.test(block)) continue;
    const text = block.replace(/^\s*[-*]\s+/, "");
    for (const sentence of text.split(/(?<=[.!?])\s+(?=[A-Z*“"(])/)) {
      // A bare link list or a citation ("(Characters › Yuu; Ch. 21)") isn't a detail.
      const words = sentence.replace(/\[[^\]]*\]\([^)]*\)/g, " ").replace(/\([^)]*\)/g, " ").replace(/[^\p{L}\s]/gu, " ").trim().split(/\s+/).filter(Boolean);
      if (words.length < 5) continue;
      let refs = [...sentence.matchAll(/\]\(([^)]*manuscript\/[^)#]+)/g)].map((m) => chapterFor(m[1])).filter(Boolean);
      // No link: a plain "Ch. 43" / "Chapter 43" / "Chs. 31–32" (the first number) names the chapter.
      if (!refs.length) refs = [...sentence.matchAll(/\bCh(?:apter|s)?\.?\s*(\d+(?:\.\d+)?)/g)].map((m) => chapterByNumber(parseFloat(m[1]))).filter(Boolean);
      for (const ch of new Set(refs)) push(ch, sentence);
    }
  }
  return items;
}
