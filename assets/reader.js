(() => {
  const root = document.documentElement;
  const PREFS_KEY = "reader-prefs";
  const PROGRESS_KEY = "reader-progress";

  const load = (key) => { try { return JSON.parse(localStorage.getItem(key) || "{}"); } catch (e) { return {}; } };
  const save = (key, val) => { try { localStorage.setItem(key, JSON.stringify(val)); } catch (e) {} };

  // ---------- Reading preferences ----------
  const saved = load(PREFS_KEY);
  // Version 2 made sans the default. Older saved settings always held the old default (serif), so
  // forget that one setting once; a reader who picks Serif again keeps it.
  if (saved.v !== 2) delete saved.font;
  const prefs = Object.assign({ theme: "auto", font: "sans", width: "normal", size: 100, illust: "show", cards: "on" }, saved, { v: 2 });
  if (!Number.isFinite(prefs.size)) prefs.size = 100; // repair a size saved as NaN by an earlier bug

  function apply() {
    if (prefs.theme === "auto") delete root.dataset.theme; else root.dataset.theme = prefs.theme;
    root.dataset.font = prefs.font;
    root.dataset.width = prefs.width;
    root.dataset.illust = prefs.illust;
    root.dataset.cards = prefs.cards;
    root.style.setProperty("--scale", prefs.size / 100);
    document.querySelectorAll("[data-set]").forEach((b) =>
      b.setAttribute("aria-pressed", String(prefs[b.dataset.set] === b.dataset.value)));
    const out = document.getElementById("size-out");
    if (out) out.textContent = prefs.size + "%";
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.content = getComputedStyle(document.body).backgroundColor;
  }

  document.addEventListener("click", (e) => {
    const set = e.target.closest("[data-set]");
    const step = e.target.closest('[data-step="size"]');
    if (set) prefs[set.dataset.set] = set.dataset.value;
    else if (step) prefs.size = Math.min(150, Math.max(80, prefs.size + (Number(step.dataset.dir) || 0) * 10));
    else return;
    save(PREFS_KEY, prefs);
    apply();
  });
  apply();

  // ---------- Settings panel ----------
  const toggle = document.getElementById("settings-toggle");
  const panel = document.getElementById("settings");
  const setOpen = (open) => { panel.hidden = !open; toggle.setAttribute("aria-expanded", String(open)); };
  toggle.addEventListener("click", () => setOpen(panel.hidden));
  document.addEventListener("click", (e) => {
    if (!panel.hidden && !panel.contains(e.target) && !toggle.contains(e.target)) setOpen(false);
  });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") setOpen(false); });

  // ---------- Chapter page ----------
  const reader = document.querySelector(".reader");
  const progress = load(PROGRESS_KEY);

  if (reader) {
    const slug = reader.dataset.slug;
    const bar = document.getElementById("progress");
    const topbar = document.getElementById("topbar");
    let lastY = window.scrollY;
    let saveTimer;

    const ratio = () => {
      const max = document.documentElement.scrollHeight - window.innerHeight;
      return max > 0 ? Math.min(1, window.scrollY / max) : 1;
    };

    // Restore position if returning to an unfinished chapter.
    const saved = progress.chapters && progress.chapters[slug];
    if (saved && saved < 0.98 && !location.hash) {
      requestAnimationFrame(() => {
        window.scrollTo(0, saved * (document.documentElement.scrollHeight - window.innerHeight));
      });
    }

    const onScroll = () => {
      const r = ratio();
      bar.style.width = (r * 100).toFixed(2) + "%";

      const y = window.scrollY;
      if (panel.hidden) topbar.classList.toggle("is-hidden", y > lastY && y > 120);
      if (y < lastY) topbar.classList.remove("is-hidden");
      lastY = y;

      clearTimeout(saveTimer);
      saveTimer = setTimeout(() => {
        const p = load(PROGRESS_KEY);
        p.chapters = p.chapters || {};
        p.chapters[slug] = r;
        if (r > 0.98) (p.read = p.read || {})[slug] = true;
        p.last = { slug, title: reader.dataset.title };
        save(PROGRESS_KEY, p);
      }, 250);
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    onScroll();

    // Arrow keys move between chapters.
    document.addEventListener("keydown", (e) => {
      if (e.altKey || e.ctrlKey || e.metaKey || e.target.closest("input, textarea")) return;
      const rel = e.key === "ArrowLeft" ? "prev" : e.key === "ArrowRight" ? "next" : null;
      const link = rel && document.querySelector(`a[rel="${rel}"]`);
      if (link) location.href = link.href;
    });
  }

  // ---------- Character cards: tap a highlighted name ----------
  let cardData = null;
  let card = null;
  const closeCard = () => { if (card) { card.remove(); card = null; } };
  async function loadCards() {
    if (!cardData) {
      try { cardData = await (await fetch("characters.json")).json(); }
      catch (e) { cardData = {}; }
    }
    return cardData;
  }
  document.addEventListener("click", async (e) => {
    const name = e.target.closest("a.char");
    if (card && !e.target.closest(".char-card")) closeCard();
    if (!name || e.metaKey || e.ctrlKey || e.shiftKey) return;
    e.preventDefault();
    if (prefs.cards === "off") return;
    const info = (await loadCards())[name.dataset.char];
    if (!info) { location.href = name.href; return; }
    closeCard();
    card = document.createElement("div");
    card.className = "char-card";
    card.setAttribute("role", "dialog");
    card.setAttribute("aria-label", info.name);
    card.innerHTML = `
      ${info.image ? `<img class="char-card-img" src="${info.image}" alt="">` : ""}
      <div class="char-card-body">
        <p class="char-card-name"></p>
        ${info.species ? `<p class="char-card-species">${info.species}</p>` : ""}
        ${info.summary ? `<p class="char-card-summary">${info.summary}</p>` : ""}
        <a class="char-card-link" href="${name.getAttribute("href")}">Open wiki page →</a>
      </div>`;
    card.querySelector(".char-card-name").textContent = info.name;
    document.body.appendChild(card);
    // Below the name, kept on screen; above it if there's no room below.
    const r = name.getBoundingClientRect();
    const w = card.offsetWidth, h = card.offsetHeight, pad = 12;
    const left = Math.min(Math.max(pad, r.left + r.width / 2 - w / 2), window.innerWidth - w - pad);
    const below = r.bottom + 8 + h < window.innerHeight;
    card.style.left = `${left + window.scrollX}px`;
    card.style.top = `${(below ? r.bottom + 8 : r.top - h - 8) + window.scrollY}px`;
    card.querySelector(".char-card-link").focus({ preventScroll: true });
  });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeCard(); });
  window.addEventListener("resize", closeCard);

  // ---------- Search matches: chapter opened from a search result (#find=…) ----------
  (function highlightFind() {
    const m = location.hash.match(/^#find=(.+)$/);
    const prose = document.querySelector(".prose");
    if (!m || !prose) return;
    const query = decodeURIComponent(m[1]);
    const fold = (t) => t.normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[\u2018\u2019]/g, "'").replace(/[\u201c\u201d]/g, '"').toLowerCase();
    const foldKeep = (t) => [...t].map((ch) => fold(ch)[0] || ch).join("");
    const terms = [];
    query.replace(/"([^"]+)"|(\S+)/g, (_, phrase, word) => { terms.push(fold(phrase || word)); });
    const wanted = terms.filter((t) => t.length > 1 || /\d/.test(t));
    if (!wanted.length) return;
    const marks = [];
    const walker = document.createTreeWalker(prose, NodeFilter.SHOW_TEXT);
    const nodes = [];
    while (walker.nextNode()) nodes.push(walker.currentNode);
    for (const node of nodes) {
      const text = node.nodeValue.normalize("NFC");
      const folded = foldKeep(text);
      const found = [];
      for (const t of wanted) for (let i = folded.indexOf(t); i >= 0; i = folded.indexOf(t, i + t.length)) found.push([i, i + t.length]);
      if (!found.length) continue;
      found.sort((a, b) => a[0] - b[0]);
      const frag = document.createDocumentFragment();
      let pos = 0;
      for (const [a, b] of found) {
        if (a < pos) continue;
        frag.append(text.slice(pos, a));
        const mark = document.createElement("mark");
        mark.className = "find";
        mark.textContent = text.slice(a, b);
        frag.append(mark);
        marks.push(mark);
        pos = b;
      }
      frag.append(text.slice(pos));
      node.replaceWith(frag);
    }
    if (!marks.length) return;
    let current = -1;
    const bar = document.createElement("div");
    bar.className = "find-bar";
    bar.innerHTML = `<span class="find-count"></span><button type="button" data-find-step="-1" aria-label="Previous match">↑</button><button type="button" data-find-step="1" aria-label="Next match">↓</button><button type="button" data-find-close aria-label="Clear highlights">×</button>`;
    const show = (i) => {
      marks[current]?.classList.remove("find-current");
      current = (i + marks.length) % marks.length;
      marks[current].classList.add("find-current");
      marks[current].scrollIntoView({ block: "center", behavior: "smooth" });
      bar.querySelector(".find-count").textContent = `${current + 1} of ${marks.length}`;
    };
    bar.addEventListener("click", (e) => {
      const step = e.target.closest("[data-find-step]");
      if (step) return show(current + Number(step.dataset.findStep));
      if (e.target.closest("[data-find-close]")) {
        marks.forEach((mk) => mk.replaceWith(mk.textContent));
        bar.remove();
        history.replaceState(null, "", location.pathname);
      }
    });
    document.body.appendChild(bar);
    requestAnimationFrame(() => show(0));
  })();

  // ---------- Illustrations: tap to view full-screen ----------
  document.addEventListener("click", (e) => {
    const link = e.target.closest(".illust-link");
    if (!link || e.metaKey || e.ctrlKey || e.shiftKey) return;
    e.preventDefault();
    const img = link.querySelector("img");
    const box = document.createElement("div");
    box.className = "lightbox";
    box.setAttribute("role", "dialog");
    box.setAttribute("aria-label", img.alt || "Illustration");
    box.innerHTML = `<img src="${link.getAttribute("href")}" alt="">`;
    box.querySelector("img").alt = img.alt;
    const close = () => {
      box.remove();
      document.removeEventListener("keydown", onKey);
      link.focus();
    };
    const onKey = (ev) => { if (ev.key === "Escape") close(); };
    box.addEventListener("click", close);
    document.addEventListener("keydown", onKey);
    document.body.appendChild(box);
  });

  // ---------- Wiki filter (also runs once an author page is unlocked) ----------
  function initFilter() {
    const input = document.getElementById("wiki-filter");
    if (!input || input.dataset.ready) return;
    input.dataset.ready = "1";
    input.addEventListener("input", () => {
      const q = input.value.trim().toLowerCase();
      let any = false;
      document.querySelectorAll("[data-filter-group]").forEach((group) => {
        let shown = 0;
        group.querySelectorAll("[data-filter-text]").forEach((item) => {
          const hit = !q || item.dataset.filterText.includes(q);
          item.hidden = !hit;
          if (hit) shown++;
        });
        group.hidden = shown === 0;
        if (shown) any = true;
      });
      document.getElementById("filter-empty").hidden = any;
    });
  }
  initFilter();
  document.addEventListener("vault:open", initFilter);

  // ---------- Home page ----------
  const resume = document.getElementById("resume");
  if (resume && progress.last) {
    resume.href = progress.last.slug + ".html";
    document.getElementById("resume-title").textContent = progress.last.title;
    resume.hidden = false;
  }
  document.querySelectorAll(".toc-item").forEach((a) => {
    if (progress.read && progress.read[a.dataset.slug]) a.classList.add("is-read");
    if (progress.last && progress.last.slug === a.dataset.slug) a.classList.add("is-current");
  });
})();
