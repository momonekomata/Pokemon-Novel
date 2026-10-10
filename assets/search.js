// Search page: loads search-index.json once and searches it in the browser.
// Matching ignores case, accents (ō = o) and curly vs straight quotes. Several words must all appear;
// "quoted words" must appear together.
(() => {
  const input = document.getElementById("search-input");
  const status = document.getElementById("search-status");
  const list = document.getElementById("search-results");
  if (!input) return;

  // Same length in and out, so positions in the folded text line up with the original.
  const fold = (s) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[‘’]/g, "'").replace(/[“”]/g, '"').toLowerCase();
  const foldKeep = (s) => [...s.normalize("NFC")].map((ch) => fold(ch)[0] || ch).join("");
  const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

  let index = null;
  async function load() {
    if (index) return index;
    status.textContent = "Loading…";
    const data = await (await fetch("search-index.json")).json();
    index = data.map((d) => {
      const text = d.x.normalize("NFC");
      return { ...d, text, folded: foldKeep(text), foldedTitle: foldKeep(d.t) };
    });
    return index;
  }

  const terms = (q) => {
    const out = [];
    q.replace(/"([^"]+)"|(\S+)/g, (_, phrase, word) => { out.push(fold(phrase || word)); });
    return out.filter((t) => t.length > 1 || /\d/.test(t));
  };

  function snippet(entry, term) {
    const at = entry.folded.indexOf(term);
    if (at < 0) return esc(entry.text.slice(0, 160)) + "…";
    const start = Math.max(0, entry.text.lastIndexOf("\n", at) + 1, at - 90);
    const end = Math.min(entry.text.length, at + term.length + 110);
    const before = entry.text.slice(start, at), hit = entry.text.slice(at, at + term.length), after = entry.text.slice(at + term.length, end);
    return `${start > 0 ? "…" : ""}${esc(before.replace(/\n/g, " "))}<mark>${esc(hit)}</mark>${esc(after.replace(/\n/g, " "))}${end < entry.text.length ? "…" : ""}`;
  }

  function count(hay, term) {
    let n = 0;
    for (let i = hay.indexOf(term); i >= 0; i = hay.indexOf(term, i + term.length)) n++;
    return n;
  }

  let timer;
  async function run() {
    const q = input.value.trim();
    history.replaceState(null, "", q ? `?q=${encodeURIComponent(q)}` : location.pathname);
    const ts = terms(q);
    if (!ts.length) { list.innerHTML = ""; status.textContent = ""; return; }
    const data = await load();
    if (input.value.trim() !== q) return; // a newer search is on its way
    const hits = [];
    for (const e of data) {
      if (!ts.every((t) => e.folded.includes(t) || e.foldedTitle.includes(t))) continue;
      const n = ts.reduce((sum, t) => sum + count(e.folded, t), 0);
      const titleHit = ts.some((t) => e.foldedTitle.includes(t));
      hits.push({ e, n, score: (titleHit ? 1000 : 0) + (e.k === "wiki" ? 10 : 0) + n });
    }
    // Spoiler shield: leave out pages of characters the reader hasn't met yet.
    let shielded = 0;
    if (window.spoilerShield) {
      for (let i = hits.length - 1; i >= 0; i--) {
        if (hits[i].e.a && !(await window.spoilerShield.met(hits[i].e.a))) { hits.splice(i, 1); shielded++; }
      }
      if (input.value.trim() !== q) return;
    }
    hits.sort((a, b) => b.score - a.score);
    status.textContent = (hits.length ? `${hits.length} ${hits.length === 1 ? "page" : "pages"}` : "Nothing found. Try fewer or different words.") +
      (shielded ? ` · ${shielded} hidden by the spoiler shield (characters you haven't met yet)` : "");
    const find = encodeURIComponent(q);
    list.innerHTML = hits
      .slice(0, 100)
      .map(({ e, n }) => `
        <li><a class="search-hit" href="${e.u}${e.k === "chapter" ? `#find=${find}` : ""}">
          <span class="search-hit-head"><span class="search-hit-label">${esc(e.l)}</span><span class="search-hit-count">${n} match${n === 1 ? "" : "es"}</span></span>
          <span class="search-hit-title">${esc(e.t)}</span>
          <span class="search-hit-snippet">${snippet(e, ts[0])}</span>
        </a></li>`)
      .join("");
  }

  input.addEventListener("input", () => { clearTimeout(timer); timer = setTimeout(run, 150); });
  const q = new URLSearchParams(location.search).get("q");
  if (q) { input.value = q; run(); }
})();
