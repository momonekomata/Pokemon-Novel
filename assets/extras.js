// Extras page: Who Said It? and Cast Shuffle. Both read extras.json and show only what the reader
// has met, by asking the spoiler shield in reader.js (window.spoilerShield).
(() => {
  const root = (() => {
    const css = document.querySelector('link[href$="assets/style.css"]');
    return css ? css.getAttribute("href").replace(/assets\/style\.css$/, "") : "";
  })();
  const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const shuffle = (a) => { a = a.slice(); for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
  const pick = (a) => a[Math.floor(Math.random() * a.length)];
  const store = {
    get(k, d) { try { return JSON.parse(localStorage.getItem("extras-" + k)) ?? d; } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem("extras-" + k, JSON.stringify(v)); } catch (e) {} },
  };
  const copy = (text, btn) => {
    const done = (msg) => { const t = btn.textContent; btn.textContent = msg; setTimeout(() => (btn.textContent = t), 1400); };
    navigator.clipboard?.writeText(text).then(() => done("Copied"), () => done("Couldn't copy")) ?? done("Couldn't copy");
  };

  // ---------- Tabs (#quiz / #shuffle) ----------
  const tabs = [...document.querySelectorAll("[data-x-tab]")];
  const show = (name) => {
    for (const t of tabs) {
      const on = t.dataset.xTab === name;
      t.setAttribute("aria-selected", String(on));
      document.getElementById(t.dataset.xTab).hidden = !on;
    }
  };
  tabs.forEach((t) => t.addEventListener("click", () => { show(t.dataset.xTab); history.replaceState(null, "", "#" + t.dataset.xTab); }));
  show(location.hash === "#shuffle" ? "shuffle" : "quiz");

  const shield = window.spoilerShield || { met: async () => true };
  fetch(root + "extras.json")
    .then((r) => r.json())
    .then(async (data) => {
      const metChars = [];
      for (const ch of data.characters) if (ch.a.length && (await shield.met(ch.a))) metChars.push(ch);
      const lines = [];
      for (const q of data.quiz) if (await shield.met([q.c])) lines.push(q);
      // Places from the wiki carry the chapter that introduces them; they unlock once it's been opened.
      const places = [];
      for (const p of data.places) if (!p.a || (await shield.met(p.a))) places.push(p);
      data.places = places;
      quiz(data, lines, metChars);
      cast(data, metChars);
    })
    .catch(() => {
      for (const id of ["quiz-app", "shuffle-app"]) document.getElementById(id).innerHTML = `<p class="x-empty">The games couldn't load. Try reloading the page.</p>`;
    });

  const notYet = (what) => `<div class="x-empty"><p>${what}</p><p><a class="btn btn-primary" href="${root}index.html#chapters">Go to the chapters</a></p></div>`;

  // ---------- Who Said It? ----------
  function quiz(data, lines, metChars) {
    const app = document.getElementById("quiz-app");
    const speakerIds = [...new Set(lines.map((q) => q.s))];
    // Wrong answers: other quiz speakers the reader has met, else any character she has met.
    const metPages = new Set(metChars.map((c) => c.id));
    const pool = Object.keys(data.speakers).filter((k) => metPages.has(data.speakers[k].page));
    if (lines.length < 3 || new Set([...pool, ...speakerIds]).size < 4) {
      app.innerHTML = notYet(`Read a little further first. The quiz unlocks lines from chapters you've opened, and it needs a few different speakers to ask about. ${lines.length} of ${data.quiz.length} lines unlocked so far.`);
      return;
    }
    let G;
    let best = store.get("quiz-best", 0);
    const name = (k) => data.speakers[k]?.name || k;
    const start = (len) => {
      const deck = shuffle(lines).slice(0, len === "all" ? lines.length : Number(len));
      G = { len, deck, i: 0, score: 0, streak: 0, max: 0, picked: null, opts: [], missed: [], hint: false };
      deal();
    };
    const deal = () => {
      const q = G.deck[G.i];
      const others = shuffle([...new Set([...speakerIds, ...pool])].filter((k) => k !== q.s && data.speakers[k].name !== data.speakers[q.s].name));
      G.opts = shuffle([q.s, ...others.slice(0, 3)]);
      G.picked = null;
      G.hint = false;
      render();
    };
    const answer = (k) => {
      if (G.picked) return;
      const q = G.deck[G.i];
      G.picked = k;
      if (k === q.s) { G.score++; G.streak++; G.max = Math.max(G.max, G.streak); }
      else { G.streak = 0; G.missed.push({ q, k }); }
      if (G.max > best) { best = G.max; store.set("quiz-best", best); }
      render();
      app.querySelector(".x-next")?.focus({ preventScroll: true });
    };
    const next = () => {
      if (!G.picked) return;
      G.i++;
      if (G.i < G.deck.length) deal();
      else render();
    };
    const render = () => {
      const done = G.i >= G.deck.length;
      const asked = done ? G.deck.length : G.i + (G.picked ? 1 : 0);
      const bar = `<div class="x-bar">
        <div class="stats-grid x-score">
          <div class="stat"><span class="stat-label">Score</span><span class="stat-value">${G.score}/${asked}</span></div>
          <div class="stat"><span class="stat-label">Streak</span><span class="stat-value">${G.streak}</span></div>
          <div class="stat"><span class="stat-label">Best streak</span><span class="stat-value">${best}</span></div>
        </div>
        <label class="x-round">Round <select id="quiz-len">${["10", "20", "all"].map((v) => `<option value="${v}"${v === String(G.len) ? " selected" : ""}>${v === "all" ? `All ${lines.length}` : v}</option>`).join("")}</select></label>
      </div>`;
      if (done) {
        const pct = Math.round((100 * G.score) / G.deck.length);
        app.innerHTML = `${bar}<div class="x-card x-end">
          <p class="x-big">${G.score} / ${G.deck.length}</p>
          <p class="x-muted">${pct}% · longest streak ${G.max}</p>
          <button class="btn btn-primary x-next" type="button" data-again>Play again</button>
          ${G.missed.length ? `<h3>The ones that got away</h3><ul class="x-missed">${G.missed.map(({ q, k }) => `<li><q>${esc(q.t)}</q><span class="x-muted">${esc(name(q.s))}, not ${esc(name(k))} · <a href="${root}${q.c}.html">${esc(q.l)}: ${esc(q.n)}</a></span></li>`).join("")}</ul>` : ""}
        </div>`;
        return;
      }
      const q = G.deck[G.i];
      const right = G.picked === q.s;
      app.innerHTML = `${bar}
        <figure class="x-card x-quote">
          <blockquote>${esc(q.t)}</blockquote>
          ${q.h ? (G.hint || G.picked ? `<figcaption>${esc(q.h)}</figcaption>` : `<button class="x-link" type="button" data-hint>Show a hint</button>`) : ""}
        </figure>
        <div class="x-options">${G.opts.map((k, i) => {
          const cls = G.picked ? (k === q.s ? " is-right" : k === G.picked ? " is-wrong" : "") : "";
          const sp = data.speakers[k];
          return `<button class="x-option${cls}" type="button" data-pick="${esc(k)}"${G.picked ? " disabled" : ""}><kbd>${i + 1}</kbd><span>${esc(sp.name)}${G.picked && sp.species ? `<small>${esc(sp.species)}</small>` : ""}</span></button>`;
        }).join("")}</div>
        ${G.picked ? `<div class="x-result" role="status">
          <p>${right ? "Right." : `It was <a href="${root}${data.speakers[q.s].url}">${esc(name(q.s))}</a>.`} <span class="x-muted">${esc(q.l)} · <a href="${root}${q.c}.html">${esc(q.n)}</a></span></p>
          <button class="btn btn-primary x-next" type="button" data-next>${G.i + 1 >= G.deck.length ? "See results" : "Next"}</button>
        </div>` : ""}`;
    };
    app.addEventListener("click", (e) => {
      const b = e.target.closest("button");
      if (!b) return;
      if (b.dataset.pick) answer(b.dataset.pick);
      else if ("next" in b.dataset) next();
      else if ("again" in b.dataset) start(G.len);
      else if ("hint" in b.dataset) { G.hint = true; render(); }
    });
    app.addEventListener("change", (e) => { if (e.target.id === "quiz-len") start(e.target.value); });
    document.addEventListener("keydown", (e) => {
      if (document.getElementById("quiz").hidden || e.altKey || e.ctrlKey || e.metaKey || e.target.closest("input, select, textarea")) return;
      if (/^[1-4]$/.test(e.key) && G.i < G.deck.length && G.opts[Number(e.key) - 1]) answer(G.opts[Number(e.key) - 1]);
      else if (e.key === "Enter" && !e.target.closest("button")) { if (G.i >= G.deck.length) start(G.len); else next(); }
    });
    start(10);
  }

  // ---------- Cast Shuffle ----------
  function cast(data, metChars) {
    const app = document.getElementById("shuffle-app");
    if (metChars.length < 2 || !data.places.length || !data.sparks.length) {
      app.innerHTML = notYet(`Meet a few more characters first. The shuffle only uses characters from chapters you've opened (${metChars.length} so far).`);
      return;
    }
    const byId = new Map(metChars.map((c) => [c.id, c]));
    const sorted = [...metChars].sort((a, b) => a.name.localeCompare(b.name));
    const S = { slots: [null, null, null], locks: [false, false, false], three: false, place: null, mood: null, spark: null, lockScene: {} };
    let saved = store.get("shuffle-saved", []);
    const given = (id) => byId.get(id)?.name.split(" ").slice(-1)[0] || "";
    const sparkText = () => (S.spark || "").replace(/\{A\}/g, given(S.slots[0])).replace(/\{B\}/g, given(S.slots[1])).replace(/\{C\}/g, given(S.slots[2]) || given(S.slots[1]));
    const n = () => (S.three ? 3 : 2);
    const promptText = () => `${S.slots.slice(0, n()).map((id) => byId.get(id)?.name).join(" × ")}\nPlace: ${S.place.name}\nMood: ${S.mood}\nSpark: ${sparkText()}`;

    const roll = () => {
      const taken = new Set(S.slots.filter((id, i) => S.locks[i] && id));
      for (let i = 0; i < n(); i++) {
        if (S.locks[i] && S.slots[i]) continue;
        const c = pick(metChars.filter((c) => !taken.has(c.id)));
        S.slots[i] = c.id;
        taken.add(c.id);
      }
      if (!S.lockScene.place) S.place = pick(data.places);
      if (!S.lockScene.mood && data.moods.length) S.mood = pick(data.moods);
      if (!S.lockScene.spark) S.spark = pick(data.sparks);
      render();
    };
    const lockBtn = (attr, on, label) => `<button class="x-lock" type="button" ${attr} aria-pressed="${on}" aria-label="${on ? "Unlock" : "Lock"} ${label}" title="${on ? "Locked" : "Lock"}">${on ? "Locked" : "Lock"}</button>`;
    const slot = (i) => {
      const off = i >= n();
      const c = byId.get(S.slots[i]);
      const label = ["First character", "Second character", "Third character"][i];
      if (off) return `<div class="x-slot is-off"><p class="x-muted">A third character is off.</p></div>`;
      return `<div class="x-slot${S.locks[i] ? " is-locked" : ""}">
        <div class="x-slot-head"><span class="stat-label">${label}</span>${lockBtn(`data-lock="${i}"`, S.locks[i], label)}</div>
        ${c ? `<p class="x-name"><a href="${root}${c.url}">${esc(c.name)}</a></p>${c.species ? `<p class="x-species">${esc(c.species)}</p>` : ""}<p class="x-hook">${esc(c.intro)}</p>` : ""}
        <select data-choose="${i}" aria-label="Choose the ${label.toLowerCase()}"><option value="">Choose…</option>${sorted.map((x) => `<option value="${x.id}"${x.id === S.slots[i] ? " selected" : ""}>${esc(x.name)}</option>`).join("")}</select>
      </div>`;
    };
    const render = () => {
      app.innerHTML = `
        <div class="x-controls">
          <button class="btn btn-primary" type="button" data-roll>Shuffle</button>
          <label class="check"><input type="checkbox" id="shuffle-three"${S.three ? " checked" : ""}> Three characters</label>
          <span class="x-muted">${metChars.length} characters you've met</span>
        </div>
        <div class="x-slots">${[0, 1, 2].map(slot).join("")}</div>
        <div class="x-card x-scene">
          <div class="x-row"><span class="stat-label">Place</span>${lockBtn('data-scene="place"', !!S.lockScene.place, "place")}<p>${esc(S.place.name)}${S.place.note ? ` <span class="x-muted">· ${esc(S.place.note)}</span>` : ""}</p></div>
          ${S.mood ? `<div class="x-row"><span class="stat-label">Mood</span>${lockBtn('data-scene="mood"', !!S.lockScene.mood, "mood")}<p>${esc(S.mood)}</p></div>` : ""}
          <div class="x-row"><span class="stat-label">Spark</span>${lockBtn('data-scene="spark"', !!S.lockScene.spark, "spark")}<p class="x-spark">${esc(sparkText())}</p></div>
          <div class="x-controls"><button class="btn btn-ghost btn-small" type="button" data-copy>Copy prompt</button><button class="btn btn-ghost btn-small" type="button" data-save>Save</button></div>
        </div>
        ${saved.length ? `<h3 class="x-saved-head">Saved prompts <span class="x-muted">${saved.length}</span></h3><ol class="x-saved">${saved.map((s, i) => `<li><pre>${esc(s)}</pre><span><button class="x-link" type="button" data-copy-saved="${i}">Copy</button> <button class="x-link" type="button" data-delete="${i}">Remove</button></span></li>`).join("")}</ol>` : ""}`;
    };
    app.addEventListener("click", (e) => {
      const b = e.target.closest("button");
      if (!b) return;
      const d = b.dataset;
      if ("roll" in d) roll();
      else if (d.lock) { S.locks[d.lock] = !S.locks[d.lock]; render(); }
      else if (d.scene) { S.lockScene[d.scene] = !S.lockScene[d.scene]; render(); }
      else if ("copy" in d) copy(promptText(), b);
      else if ("save" in d) { saved.unshift(promptText()); store.set("shuffle-saved", saved); render(); }
      else if (d.copySaved) copy(saved[d.copySaved], b);
      else if (d.delete) { saved.splice(Number(d.delete), 1); store.set("shuffle-saved", saved); render(); }
    });
    app.addEventListener("change", (e) => {
      if (e.target.id === "shuffle-three") { S.three = e.target.checked; if (S.three && !S.slots[2]) roll(); else render(); }
      else if (e.target.dataset.choose) { const i = Number(e.target.dataset.choose); S.slots[i] = e.target.value || null; S.locks[i] = !!e.target.value; render(); }
    });
    roll();
  }
})();
