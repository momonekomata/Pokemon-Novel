// Reads Quiz_Lines.md (top of the vault) for the Who Said It? game on the Extras page.
//   ## [[Chapter_12_-_Chapter_Title]]
//   - [[family-given]]: "the line" · hint: a few words of context
//   - [[family-twins|Family Given]]: "…"     (one page covering two people: name the speaker)

const fold = (s) =>
  s.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

export function parseQuizLines(src) {
  const lines = [];
  const bad = [];
  let file = null;
  for (const raw of src.split("\n")) {
    const h = raw.match(/^##\s+(.+?)\s*$/);
    if (h) {
      const target = (h[1].match(/\[\[([^\]|#]+)/)?.[1] || h[1].match(/\]\(([^)]+)\)/)?.[1] || h[1]).trim();
      file = decodeURIComponent(target).split("/").pop().replace(/\.md$/i, "") + ".md";
      continue;
    }
    const li = raw.match(/^\s*[-*]\s+(.+)$/);
    if (!li || !file) continue;
    const m = li[1].match(/^\[\[([^\]|]+)(?:\|([^\]]+))?\]\]\s*:\s*(.+)$/);
    if (!m) {
      if (/\[\[/.test(li[1])) bad.push(li[1]);
      continue;
    }
    let rest = m[3];
    let hint = "";
    const hi = rest.search(/\s·\s*hint:/i);
    if (hi >= 0) {
      hint = rest.slice(hi).replace(/^\s·\s*hint:\s*/i, "").trim();
      rest = rest.slice(0, hi);
    }
    const text = rest.trim().replace(/^["“](.*)["”]$/s, "$1").trim();
    if (!text) continue;
    lines.push({ file, slug: m[1].trim().split("/").pop().replace(/\.md$/i, ""), name: m[2]?.trim() || "", text, hint });
  }
  return { lines, bad };
}

// True when every sentence of the line still appears in the chapter, ignoring punctuation and case
// (a speech tag can split a line in the prose: "He does this," she murmured. "Every term …").
export function lineInChapter(text, chapterSrc) {
  const hay = ` ${fold(chapterSrc)} `;
  const parts = text
    .split(/[.!?;:,…—–]+|\.\.\./)
    .map((p) => fold(p))
    .filter((p) => p.split(" ").length >= 2);
  return parts.length > 0 && parts.every((p) => hay.includes(` ${p} `));
}

// Lines to mine from the prose for Who Said It?, so the quiz grows with every chapter: a quotation
// with a speech tag right beside it that names a character outright —
//   "That's not eating, Mizore," Sakura said.      "…?" asked Reina.      Reina said, "…"
// Pronoun tags ("she said") and first-person narration are skipped, since the speaker can't be told
// for sure. `index` is the character name index (name -> page id); only unambiguous names are in it.
const SPEECH = "said|says|asked|asks|replied|replies|answered|added|called|shouted|yelled|whispered|murmured|muttered|snapped|sighed|laughed|grumbled|hissed|breathed|announced|declared|insisted|admitted|offered|continued|repeated|demanded|cried|growled|purred|chirped|barked|huffed|groaned|protested|corrected|agreed|warned|promised";
const NAME = "[A-Z][\\p{L}'’-]+(?: [A-Z][\\p{L}'’-]+)?";
const tagAfter = new RegExp(`^[ \\t]*(?:(${NAME})[ \\t]+(?:${SPEECH})\\b|(?:${SPEECH})[ \\t]+(${NAME})\\b)`, "u");
const tagBefore = new RegExp(`(?:^|[.!?…”"]\\s+)(${NAME})[ \\t]+(?:${SPEECH})(?:[ \\t]+\\p{L}+ly)?[,:][ \\t]*$`, "u");

export function mineLines(src, index, { minWords = 5, maxWords = 28 } = {}) {
  const out = [];
  for (const para of src.split(/\n\s*\n/)) {
    if (/^\s*(#|>|!\[|\||[-*] )/.test(para)) continue; // headings, quotes, pictures, tables, lists
    const re = /["“]([^"“”\n]+)["”]/g;
    let m;
    while ((m = re.exec(para))) {
      const after = para.slice(m.index + m[0].length, m.index + m[0].length + 60);
      const before = para.slice(Math.max(0, m.index - 60), m.index);
      const a = after.match(tagAfter);
      const b = !a && before.match(tagBefore);
      const name = a ? a[1] || a[2] : b ? b[1] : null;
      const id = name && index.get(name);
      if (!id) continue;
      let text = m[1].replace(/[*_]/g, "").replace(/\s+/g, " ").trim().replace(/,$/, ".");
      const words = text.split(" ").length;
      if (words < minWords || words > maxWords) continue;
      // A line that says its own speaker's name gives the answer away.
      if ([...index].some(([n, i]) => i === id && new RegExp(`(?<![\\p{L}])${n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\p{L}])`, "u").test(text))) continue;
      out.push({ text, id });
    }
  }
  return out;
}
