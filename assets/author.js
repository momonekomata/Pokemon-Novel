// Author area: derives the page key from the password (PBKDF2-SHA256, matching lib/vault.mjs),
// keeps it in this browser, and decrypts the AES-GCM-sealed pages.
(() => {
  const KEY = "author-key";
  const enc = new TextEncoder();
  const fromB64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
  const toB64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)));

  const stored = () => {
    try { return sessionStorage.getItem(KEY) || localStorage.getItem(KEY); } catch (e) { return null; }
  };
  const forget = () => {
    try { sessionStorage.removeItem(KEY); localStorage.removeItem(KEY); } catch (e) {}
  };

  async function decrypt(rawKey, payload) {
    const key = await crypto.subtle.importKey("raw", fromB64(rawKey), "AES-GCM", false, ["decrypt"]);
    const data = fromB64(payload);
    const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: data.slice(0, 12) }, key, data.slice(12));
    return new TextDecoder().decode(plain);
  }

  // ---------- Login page ----------
  const form = document.getElementById("login-form");
  if (form && form.dataset.check) {
    const submit = document.getElementById("login-submit");
    const error = document.getElementById("login-error");
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      error.hidden = true;
      submit.disabled = true;
      submit.textContent = "Checking…";
      try {
        const base = await crypto.subtle.importKey("raw", enc.encode(document.getElementById("password").value), "PBKDF2", false, ["deriveBits"]);
        const bits = await crypto.subtle.deriveBits(
          { name: "PBKDF2", hash: "SHA-256", salt: enc.encode(form.dataset.salt), iterations: Number(form.dataset.iterations) },
          base,
          256
        );
        const rawKey = toB64(bits);
        if ((await decrypt(rawKey, form.dataset.check)) !== "ok") throw new Error("mismatch");
        const store = document.getElementById("remember").checked ? localStorage : sessionStorage;
        forget();
        try { store.setItem(KEY, rawKey); } catch (err) {}
        const next = new URLSearchParams(location.search).get("next");
        location.replace(next && /^[\w\-./]+\.html$/.test(next) ? next : "index.html");
      } catch (err) {
        error.hidden = false;
        submit.disabled = false;
        submit.textContent = "Sign in";
      }
    });
    return;
  }

  // ---------- Sealed pages ----------
  const vault = document.querySelector("[data-vault]");
  if (!vault) return;
  const toLogin = () => {
    const login = new URL(vault.dataset.login, location.href);
    const here = location.pathname.split("/author/")[1] || "index.html";
    location.replace(`${login.pathname}?next=${encodeURIComponent(here.startsWith("p/") ? here : "index.html")}`);
  };
  const rawKey = stored();
  if (!rawKey) return toLogin();

  decrypt(rawKey, vault.dataset.vault)
    .then((text) => {
      const { title, html } = JSON.parse(text);
      document.title = title;
      vault.innerHTML = html;
      vault.removeAttribute("data-vault");
      document.dispatchEvent(new Event("vault:open"));
      const out = document.getElementById("sign-out");
      if (out) out.addEventListener("click", () => { forget(); toLogin(); });
      if (location.hash) document.getElementById(decodeURIComponent(location.hash.slice(1)))?.scrollIntoView();
    })
    .catch(() => { forget(); toLogin(); });
})();
