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
  const prefs = Object.assign({ theme: "auto", font: "sans", width: "normal", size: 100, illust: "show" }, saved, { v: 2 });

  function apply() {
    if (prefs.theme === "auto") delete root.dataset.theme; else root.dataset.theme = prefs.theme;
    root.dataset.font = prefs.font;
    root.dataset.width = prefs.width;
    root.dataset.illust = prefs.illust;
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
    const step = e.target.closest("[data-step]");
    if (set) prefs[set.dataset.set] = set.dataset.value;
    else if (step) prefs.size = Math.min(150, Math.max(80, prefs.size + Number(step.dataset.dir) * 10));
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
