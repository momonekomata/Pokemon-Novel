// Paragraph-then-word diff of two versions of a chapter, for the "What changed" pages.
import { plainText } from "./markdown.mjs";

// Longest common subsequence over two arrays; returns ops [["=", a, b] | ["-", a] | ["+", b]].
function lcs(a, b) {
  const n = a.length, m = b.length;
  const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const ops = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) ops.push(["=", a[i++], b[j++]]);
    else if (dp[i + 1][j] >= dp[i][j + 1]) ops.push(["-", a[i++]]);
    else ops.push(["+", b[j++]]);
  }
  while (i < n) ops.push(["-", a[i++]]);
  while (j < m) ops.push(["+", b[j++]]);
  return ops;
}

// Markdown paragraph → readable plain text (formatting marks dropped, pictures named).
const toPlain = (p) =>
  p
    .replace(/!\[\[([^\]|]+)(?:\|[^\]]*)?\]\]/g, "[picture: $1]")
    .replace(/!\[[^\]]*\]\(<?([^)>\s]+)[^)]*\)/g, "[picture: $1]")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/(\*\*|__|\*|_|~~|`)(.+?)\1/g, "$2")
    .replace(/^#+\s+|^>\s?/gm, "")
    .replace(/^(\s*[-*_]){3,}\s*$/, "* * *")
    .trim();

const paragraphs = (md) => md.replace(/\r\n/g, "\n").split(/\n\s*\n/).map(toPlain).filter(Boolean);

// Word-level markup for one changed paragraph.
function wordDiff(before, after) {
  const tok = (s) => s.match(/\s+|[^\s]+/g) || [];
  return lcs(tok(before), tok(after))
    .map(([op, w, w2]) => (op === "=" ? plainText(w2 ?? w) : op === "-" ? `<del>${plainText(w)}</del>` : `<ins>${plainText(w)}</ins>`))
    .join("")
    .replace(/<\/del><del>/g, "")
    .replace(/<\/ins><ins>/g, "");
}

// Returns { html, changed } where html lists each changed passage with one unchanged paragraph of
// context before it. changed is the number of paragraphs added, removed or edited.
export function chapterDiff(oldMd, newMd) {
  const ops = lcs(paragraphs(oldMd), paragraphs(newMd));
  const blocks = [];
  let changed = 0;
  for (let k = 0; k < ops.length; ) {
    if (ops[k][0] === "=") { k++; continue; }
    const context = k > 0 ? ops[k - 1][2] : null;
    const removed = [], added = [];
    while (k < ops.length && ops[k][0] !== "=") (ops[k][0] === "-" ? removed : added).push(ops[k++][1]);
    const parts = [];
    const pairs = Math.min(removed.length, added.length);
    for (let i = 0; i < pairs; i++) parts.push(`<p class="chg">${wordDiff(removed[i], added[i])}</p>`);
    for (const r of removed.slice(pairs)) parts.push(`<p class="chg chg-del"><del>${plainText(r)}</del></p>`);
    for (const a of added.slice(pairs)) parts.push(`<p class="chg chg-add"><ins>${plainText(a)}</ins></p>`);
    changed += Math.max(removed.length, added.length);
    blocks.push(`<section class="diff-block">${context ? `<p class="ctx">${plainText(context)}</p>` : ""}${parts.join("")}</section>`);
  }
  return { html: blocks.join("\n"), changed };
}
