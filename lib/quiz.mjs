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

// Lines to mine from the prose for Who Said It?, so the quiz grows with every chapter. The speaker of
// each quotation is worked out from the prose around it, in this order:
//   1. a speech tag naming them:          "…," Sakura said.   "…?" asked Reina.   Reina said, "…"
//   2. the narration beside the quote, whose subject acts in the same paragraph:
//                                         Reina folded her arms. "…"     "…" Sakura looked away.
//   3. "I" in a first-person story:       "…," I said.   I set the cup down. "…"   → the narrator
//   4. "she said" / "he said": the character just named (in the paragraph, or the one before), if the
//      pronoun fits her or his page
//   5. two-person back-and-forth: an untagged line in a run of alternating speakers
// A tag naming someone without a public page, or a paragraph naming two people with no clear subject,
// leaves the line out. Each line gets a hint built from the same prose, with the speaker taken out.
const SPEECH = "said|says|asked|asks|replied|replies|answered|added|called|shouted|yelled|whispered|murmured|muttered|snapped|sighed|laughed|grumbled|hissed|breathed|announced|declared|insisted|admitted|offered|continued|repeated|demanded|cried|growled|purred|chirped|barked|huffed|groaned|protested|corrected|agreed|warned|promised|told|began|went on|managed|blurted|mumbled|squeaked|sniffed|scoffed|teased|pressed|ventured|countered|conceded|noted|observed|explained|whimpered|yelped|gasped|rasped|drawled|sang|stammered";
const NAME = "[A-Z][\\p{L}'’-]+(?: [A-Z][\\p{L}'’-]+)?";
const PRON = "I|She|He|she|he";
const reTagAfter = new RegExp(`^[ \\t]*,?[ \\t]*(?:(${NAME}|${PRON})[ \\t]+(?:${SPEECH})\\b|(?:${SPEECH})[ \\t]+(${NAME}|she|he)\\b)`, "u");
const reTagBefore = new RegExp(`(?:^|[.!?…”"]\\s+)(${NAME}|${PRON})[ \\t]+(?:${SPEECH})(?:[ \\t]+\\p{L}+ly)?[,:][ \\t]*$`, "u");
const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// "f" or "m" from how a character page refers to her or him (more she/her than he/him/his, or the reverse).
export function pageGender(src) {
  const t = src.replace(/"[^"]*"|“[^”]*”/g, " ");
  const f = (t.match(/\b(she|her|hers|herself)\b/gi) || []).length;
  const m = (t.match(/\b(he|him|his|himself)\b/gi) || []).length;
  return f > m * 1.5 ? "f" : m > f * 1.5 ? "m" : "";
}

export function mineLines(src, index, { narrator = null, genders = {}, minWords = 5, maxWords = 35 } = {}) {
  const names = [...index.keys()].sort((a, b) => b.length - a.length);
  const reName = names.length ? new RegExp(`(?<![\\p{L}\\p{N}])(?:${names.map(escRe).join("|")})(?![\\p{L}\\p{N}])`, "gu") : null;
  const namesOf = (id) => names.filter((n) => index.get(n) === id);
  const fits = (id, pron) => {
    const g = /^he$/i.test(pron || "") ? "m" : /^she$/i.test(pron || "") ? "f" : "";
    return !g || !genders[id] || genders[id] === g;
  };
  const idFor = (word) => (word === "I" ? narrator || null : index.get(word) || null);
  const isPron = (w) => /^(I|she|he)$/i.test(w);
  const firstName = (text) => { reName.lastIndex = 0; const m = reName && reName.exec(text); return m ? m[0] : null; };
  const allIds = (text) => (reName ? [...new Set([...text.matchAll(reName)].map((m) => index.get(m[0])))] : []);
  // The subject a narration sentence starts with: a known name, I, she or he.
  const subjectOf = (sentence) => {
    const t = sentence.trim().replace(/^[—–\-,;:…]+\s*/, "");
    const n = firstName(t);
    if (n && t.startsWith(n)) return n;
    const p = t.match(/^(I|She|He)\b/);
    return p ? p[1] : null;
  };
  const sentences = (text) => text.split(/(?<=[.!?…])\s+/).map((x) => x.trim()).filter((x) => /\p{L}/u.test(x));

  const out = [];
  let chain = []; // speakers of the last dialogue paragraphs, newest last (null = unknown)
  let lastNamed = null; // last character named in the previous paragraph's narration
  let prevNarration = "";
  const paras = src.split(/\n\s*\n/);
  paras.forEach((para, pi) => {
    if (/^\s*([*_-]\s*){3,}$/.test(para) || /^\s*#/.test(para)) { chain = []; lastNamed = null; prevNarration = ""; return; }
    if (/^\s*(>|!\[|\||[-*] )/.test(para)) return;
    const quotes = [...para.matchAll(/["“]([^"“”\n]+)["”]/g)];
    const narration = para.replace(/["“][^"“”\n]*["”]/g, " ⟦Q⟧ ");
    if (!quotes.length) {
      const ids = allIds(narration);
      lastNamed = ids.length ? [...narration.matchAll(reName)].map((m) => index.get(m[0])).pop() : lastNamed;
      prevNarration = narration;
      chain = [];
      return;
    }
    const narrIds = allIds(narration);
    let paraSpeaker; // undefined = not decided yet, null = unknown
    const resolved = quotes.map((q, qi) => {
      const start = q.index, end = q.index + q[0].length;
      const before = para.slice(qi ? quotes[qi - 1].index + quotes[qi - 1][0].length : 0, start);
      const after = para.slice(end, qi + 1 < quotes.length ? quotes[qi + 1].index : para.length);
      let who, how, beat = "";
      const ta = after.match(reTagAfter), tb = !ta && before.match(reTagBefore);
      const tag = ta ? ta[1] || ta[2] : tb ? tb[1] : null;
      if (tag) {
        if (isPron(tag) && tag !== "I") {
          const cands = narrIds.filter((id) => fits(id, tag));
          who = cands.length === 1 ? cands[0] : !narrIds.length && lastNamed && fits(lastNamed, tag) ? lastNamed : null;
          how = "pronoun";
        } else { who = idFor(tag); how = "tag"; }
        beat = ta ? after.slice(ta[0].length) : before.replace(reTagBefore, "");
      } else {
        // Narration beside the quote: the sentence just before it, else just after.
        const prevS = sentences(before).pop() || "";
        const nextS = sentences(after)[0] || "";
        const subj = subjectOf(prevS) || subjectOf(nextS);
        beat = subjectOf(prevS) ? prevS : nextS || prevS;
        if (subj) {
          if (subj === "I") who = narrator || null;
          else if (isPron(subj)) {
            const cands = narrIds.filter((id) => fits(id, subj));
            who = cands.length === 1 ? cands[0] : !narrIds.length && lastNamed && fits(lastNamed, subj) ? lastNamed : null;
          } else who = idFor(subj);
          how = "beat";
        } else if (narrIds.length === 1 && !/\bI\b/.test(narration)) { who = narrIds[0]; how = "beat"; }
        else if (/\S/.test(narration.replace(/⟦Q⟧/g, "").replace(/[\s.,;:!?…—–-]+/g, ""))) who = null; // narration, but no clear subject
        else if (paraSpeaker !== undefined) who = paraSpeaker;
        else {
          // Pure dialogue: alternate with the two paragraphs before.
          const [x, y] = chain.slice(-2);
          who = x && y && x !== y && chain.length >= 2 ? x : null;
          how = "turns";
        }
      }
      if (tag && !isPron(tag) && !who) who = null; // a tag names someone without a public page
      if (paraSpeaker === undefined && who !== undefined) paraSpeaker = who;
      return { q: q[1], who: who || null, beat, pos: pi / paras.length };
    });
    chain.push(paraSpeaker ?? null);
    for (const r of resolved) {
      if (!r.who) continue;
      const text = r.q.replace(/[*_]/g, "").replace(/\s+/g, " ").trim().replace(/,$/, ".");
      const words = text.split(" ").length;
      if (words < minWords || words > maxWords) continue;
      if (namesOf(r.who).some((n) => new RegExp(`(?<![\\p{L}])${escRe(n)}(?![\\p{L}])`, "u").test(text))) continue; // gives the answer away
      out.push({ text, id: r.who, hint: makeHint(r, namesOf(r.who), genders[r.who], prevNarration) });
    }
    const ids = allIds(narration);
    if (ids.length) lastNamed = [...narration.matchAll(reName)].map((m) => index.get(m[0])).pop();
    prevNarration = narration;
  });
  return out;

  // A few words of context without the speaker in them: the action beat beside the line, else the
  // narration just before, else where in the story it falls.
  function makeHint(r, ownNames, gender, prev) {
    const own = new RegExp(`(?<![\\p{L}])(?:${["I", ...ownNames].map(escRe).join("|")})(?![\\p{L}])`, "u");
    const tidy = (t) => {
      t = t.replace(/⟦Q⟧/g, " ").replace(/[*_]+/g, "").replace(/\s+/g, " ").trim();
      t = t.replace(new RegExp(`^[,;:—–\\-\\s]*(?:(?:${NAME}|${PRON})\\s+(?:${SPEECH})\\b|(?:${SPEECH})\\s+(?:${NAME}|she|he)\\b)[,;:\\s]*`, "u"), "");
      t = t.replace(/^[,;:—–\-…\s]+/, "").replace(/[\s,;:—–-]+$/, "");
      const subj = subjectOf(t);
      if (subj && (subj === "I" || isPron(subj) || ownNames.includes(subj))) t = t.slice(subj.length).trim();
      t = t.split(/(?<=[.!?…])\s+/)[0].replace(/[.!?…]+$/, "");
      const words = t.split(" ");
      if (words.length > 14) t = words.slice(0, 14).join(" ").replace(/[,;:]$/, "") + "…";
      if (gender) t = t.replace(/\bmy\b/g, gender === "m" ? "his" : "her").replace(/\bme\b/g, gender === "m" ? "him" : "her").replace(/\bmyself\b/g, gender === "m" ? "himself" : "herself");
      return t.charAt(0).toUpperCase() + t.slice(1);
    };
    for (const cand of [r.beat, sentences(prev.replace(/⟦Q⟧/g, " ")).pop() || ""]) {
      const h = tidy(cand || "");
      if (h.split(" ").length >= 2 && !own.test(h) && !/⟦/.test(h) && /\p{L}{3}/u.test(h)) return h;
    }
    return r.pos < 0.34 ? "Early in the story" : r.pos < 0.67 ? "Midway through the story" : "Late in the story";
  }
}
