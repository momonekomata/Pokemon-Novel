// Character cards: links the first mention of each public character in a chapter to a small card
// (name, species, one-line summary, portrait) drawn from the reader-tier wiki.

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Names a character can be found by: the page title ("Inumaru Runa"), and for two-word titles the
// given name ("Runa"), plus any aliases from site.config.json. A short name shared by two characters
// is dropped from both, so it never links to the wrong person.
export function buildNameIndex(entries, { aliases = {}, ignoreNames = [] } = {}) {
  const ignore = new Set(ignoreNames.map((n) => n.toLowerCase()));
  const owners = new Map(); // name -> Set of ids
  for (const e of entries) {
    const words = e.name.split(/\s+/);
    const names = [e.name, ...(words.length === 2 ? [words[1]] : []), ...(aliases[e.id] || [])];
    for (const n of names) {
      if (n.length < 2 || ignore.has(n.toLowerCase())) continue;
      if (!owners.has(n)) owners.set(n, new Set());
      owners.get(n).add(e.id);
    }
  }
  const index = new Map(); // name -> id
  for (const [name, ids] of owners) if (ids.size === 1) index.set(name, [...ids][0]);
  return index;
}

// Wraps the first mention of each character in chapter HTML. Skips text inside links, code,
// headings and captions.
export function linkCharacters(html, index, urlFor) {
  if (!index.size) return html;
  const names = [...index.keys()].sort((a, b) => b.length - a.length);
  const re = new RegExp(`(?<![\\p{L}\\p{N}])(?:${names.map(escapeRe).join("|")})(?![\\p{L}\\p{N}])`, "gu");
  const linked = new Set();
  let skip = 0;
  return html
    .split(/(<[^>]+>)/)
    .map((part) => {
      if (part.startsWith("<")) {
        if (/^<(a|code|pre|h[1-6]|figcaption)\b/i.test(part)) skip++;
        else if (/^<\/(a|code|pre|h[1-6]|figcaption)>/i.test(part)) skip = Math.max(0, skip - 1);
        return part;
      }
      if (skip || !part) return part;
      return part.replace(re, (name) => {
        const id = index.get(name);
        if (linked.has(id)) return name;
        linked.add(id);
        return `<a class="char" href="${urlFor(id)}" data-char="${id}">${name}</a>`;
      });
    })
    .join("");
}
