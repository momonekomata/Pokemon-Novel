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
