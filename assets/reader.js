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
  const prefs = Object.assign({ theme: "auto", font: "sans", width: "normal", size: 100, illust: "show", cards: "on", shield: "on" }, saved, { v: 2 });
  if (!Number.isFinite(prefs.size)) prefs.size = 100; // repair a size saved as NaN by an earlier bug

  function apply() {
    if (prefs.theme === "auto") delete root.dataset.theme; else root.dataset.theme = prefs.theme;
    root.dataset.font = prefs.font;
    root.dataset.width = prefs.width;
    root.dataset.illust = prefs.illust;
    root.dataset.cards = prefs.cards;
    root.dataset.shield = prefs.shield;
    document.dispatchEvent(new Event("prefs:change"));
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

  // ---------- Spoiler shield ----------
  // A character counts as met once the reader has opened a chapter that mentions her (any main
  // chapter up to the furthest one opened, or that side story). Pages and wiki cards carry the
  // chapters she appears in (data-appears); order.json gives the reading order.
  const siteRoot = (() => {
    const css = document.querySelector('link[href$="assets/style.css"]');
    return css ? css.getAttribute("href").replace(/assets\/style\.css$/, "") : "";
  })();
  const shield = {
    ready: fetch(siteRoot + "order.json").then((r) => r.json()).catch(() => ({ main: [], extras: [] })),
    async met(slugs) {
      if (prefs.shield === "off" || !slugs?.length) return true;
      const order = await this.ready;
      const opened = Object.keys(load(PROGRESS_KEY).chapters || {});
      const furthest = Math.max(-1, ...opened.map((s) => order.main.indexOf(s)));
      return slugs.some((s) => { const i = order.main.indexOf(s); return i >= 0 ? i <= furthest : opened.includes(s); });
    },
  };
  window.spoilerShield = shield;

  async function applyShield() {
    // Wiki directory: unmet characters become a "not met yet" card until tapped.
    let hidden = 0;
    for (const li of document.querySelectorAll("li[data-appears]")) {
      const ok = li.dataset.revealed || (await shield.met(li.dataset.appears.split(" ")));
      li.classList.toggle("unmet", !ok);
      if (!ok) hidden++;
    }
    const note = document.getElementById("shield-note");
    if (note) {
      note.hidden = !hidden;
      note.innerHTML = hidden ? `Spoiler shield: ${hidden} character${hidden === 1 ? "" : "s"} you haven't met yet ${hidden === 1 ? "is" : "are"} hidden. Tap a card to peek, or turn the shield off under the <strong>T</strong> button.` : "";
    }
    // A character's own page: a veil until she's met.
    const page = document.querySelector("main.wiki[data-appears]");
    if (page && !page.dataset.revealed) {
      const ok = await shield.met(page.dataset.appears.split(" "));
      let veil = document.getElementById("spoiler-veil");
      if (!ok && !veil) {
        const order = await shield.ready;
        const first = page.dataset.appears.split(" ")[0];
        veil = document.createElement("div");
        veil.id = "spoiler-veil";
        veil.className = "spoiler-veil";
        veil.innerHTML = `<p class="veil-title">Spoiler shield</p><p>You haven't reached the chapter where this character first appears yet.</p><div class="veil-actions"><a class="btn btn-primary" href="${siteRoot}${first}.html">Go to that chapter</a><button class="btn btn-ghost" type="button">Show anyway</button></div>`;
        veil.querySelector("button").addEventListener("click", () => { page.dataset.revealed = "1"; veil.remove(); page.classList.remove("veiled"); });
        page.prepend(veil);
        page.classList.add("veiled");
        if (!order.main.includes(first) && !order.extras.includes(first)) veil.querySelector("a").remove();
      } else if (ok && veil) {
        veil.remove();
        page.classList.remove("veiled");
      }
    }
  }
  document.addEventListener("click", (e) => {
    const li = e.target.closest("li.unmet");
    if (!li) return;
    e.preventDefault();
    li.dataset.revealed = "1";
    li.classList.remove("unmet");
  }, true);
  applyShield();
  document.addEventListener("prefs:change", applyShield);

  // ---------- Line chart (writing stats): drawn at the real width, crosshair + tooltip ----------
  function drawCharts() {
    for (const el of document.querySelectorAll(".line-chart[data-points]")) {
      const pts = JSON.parse(el.dataset.points).map(([d, v]) => ({ t: Date.parse(d + "T00:00:00Z"), d, v }));
      if (!pts.length) continue;
      const W = el.clientWidth || 600, H = 220, padL = 52, padR = 16, padT = 16, padB = 28;
      const t0 = pts[0].t, t1 = Math.max(pts.at(-1).t, t0 + 86400e3);
      const step = (m) => { const p = 10 ** Math.floor(Math.log10(m)); return [1, 2, 2.5, 5, 10].map((k) => k * p).find((k) => m / k <= 4) || 10 * p; };
      const vmax = Math.max(1, ...pts.map((p) => p.v)), tick = step(vmax), top = Math.ceil(vmax / tick) * tick;
      const x = (t) => padL + ((t - t0) / (t1 - t0)) * (W - padL - padR);
      const y = (v) => padT + (1 - v / top) * (H - padT - padB);
      const compact = (n) => (n >= 1e6 ? (n / 1e6).toFixed(1).replace(/\.0$/, "") + "M" : n >= 1e3 ? (n / 1e3).toFixed(n >= 1e4 ? 0 : 1).replace(/\.0$/, "") + "K" : String(n));
      const day = (t) => new Date(t).toLocaleDateString("en", { month: "short", day: "numeric", timeZone: "UTC" });
      const line = pts.map((p, i) => `${i ? "L" : "M"}${x(p.t).toFixed(1)},${y(p.v).toFixed(1)}`).join("");
      const grid = [];
      for (let v = 0; v <= top; v += tick) grid.push(`<line x1="${padL}" x2="${W - padR}" y1="${y(v)}" y2="${y(v)}" class="lc-grid"/><text x="${padL - 8}" y="${y(v) + 4}" class="lc-axis" text-anchor="end">${compact(v)}</text>`);
      const last = pts.at(-1);
      el.innerHTML = `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" style="width:${W}px;height:${H}px">
        ${grid.join("")}
        <text x="${padL}" y="${H - 8}" class="lc-axis">${day(t0)}</text>
        <text x="${W - padR}" y="${H - 8}" class="lc-axis" text-anchor="end">${day(t1)}</text>
        <path d="${line}L${x(last.t)},${y(0)}L${x(t0)},${y(0)}Z" class="lc-area"/>
        <path d="${line}" class="lc-line"/>
        <circle cx="${x(last.t)}" cy="${y(last.v)}" r="4" class="lc-dot"/>
        <line class="lc-cross" y1="${padT}" y2="${H - padB}" visibility="hidden"/>
        <circle class="lc-dot lc-hover" r="4" visibility="hidden"/>
        <rect class="lc-hit" x="${padL}" y="0" width="${W - padL - padR}" height="${H}" tabindex="0" aria-label="Move along the chart to read values"/>
      </svg><div class="lc-tip" hidden><strong></strong><span></span></div>`;
      const cross = el.querySelector(".lc-cross"), hov = el.querySelector(".lc-hover"), tip = el.querySelector(".lc-tip");
      const show = (i) => {
        const p = pts[i];
        cross.setAttribute("x1", x(p.t)); cross.setAttribute("x2", x(p.t)); cross.setAttribute("visibility", "visible");
        hov.setAttribute("cx", x(p.t)); hov.setAttribute("cy", y(p.v)); hov.setAttribute("visibility", "visible");
        tip.hidden = false;
        tip.querySelector("strong").textContent = p.v.toLocaleString("en") + " words";
        tip.querySelector("span").textContent = new Date(p.t).toLocaleDateString("en", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
        tip.style.left = `${Math.min(Math.max(0, x(p.t) - tip.offsetWidth / 2), W - tip.offsetWidth)}px`;
        tip.style.top = `${Math.max(0, y(p.v) - tip.offsetHeight - 12)}px`;
        el.dataset.index = i;
      };
      const nearest = (px) => pts.reduce((best, p, i) => (Math.abs(x(p.t) - px) < Math.abs(x(pts[best].t) - px) ? i : best), 0);
      const hit = el.querySelector(".lc-hit");
      hit.addEventListener("pointermove", (e) => show(nearest(e.clientX - el.getBoundingClientRect().left)));
      hit.addEventListener("pointerleave", () => { cross.setAttribute("visibility", "hidden"); hov.setAttribute("visibility", "hidden"); tip.hidden = true; });
      hit.addEventListener("keydown", (e) => {
        const i = Number(el.dataset.index ?? pts.length - 1);
        if (e.key === "ArrowLeft") show(Math.max(0, i - 1));
        if (e.key === "ArrowRight") show(Math.min(pts.length - 1, i + 1));
      });
      hit.addEventListener("focus", () => show(pts.length - 1));
    }
  }
  drawCharts();
  document.addEventListener("vault:open", drawCharts);
  let resizeTimer;
  window.addEventListener("resize", () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(drawCharts, 150); });

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
