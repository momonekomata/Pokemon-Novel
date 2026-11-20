// Builds the site. With only the main title (no Book.md folders in the text repository) this is
// exactly scripts/build.mjs. With more titles (lib/books.mjs) each one is built into its own folder,
// the main title included (/manyo/ by default, "id" in site.config.json), and the front page becomes a
// shelf of all of them. Links to the main title's old addresses forward to its folder (_redirects on
// Cloudflare Pages; nas/nginx.conf does the same on the NAS).
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { bookConfig, findBooks } from "../lib/books.mjs";
import { escapeHtml as esc } from "../lib/markdown.mjs";

const CONTENT = process.env.CONTENT_DIR || "content";
const OUT = process.env.OUT_DIR || "_site";
const config = JSON.parse(readFileSync("site.config.json", "utf8"));
const books = findBooks(CONTENT);
const build = (env = {}) => execFileSync(process.execPath, ["scripts/build.mjs"], { stdio: "inherit", env: { ...process.env, ...env } });

if (!books.length) {
  build();
  process.exit(0);
}

const mainId = config.id || "manyo";
const WORK = ".build"; // per-title settings and file dates, rebuilt every time
rmSync(WORK, { recursive: true, force: true });
mkdirSync(WORK, { recursive: true });
rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

const metaFile = join(CONTENT, ".drive-meta.json");
const meta = existsSync(metaFile) ? JSON.parse(readFileSync(metaFile, "utf8")) : {};
const shelf = [{ id: mainId, order: 1 }];

console.log(`\n== ${config.title} (${mainId}/) ==`);
build({ OUT_DIR: join(OUT, mainId), LIBRARY_URL: "../index.html" });

const taken = new Set([mainId, "assets"]);
for (const book of books) {
  let id = book.id;
  for (let n = 2; taken.has(id); n++) id = `${book.id}-${n}`;
  taken.add(id);
  const prefix = `${book.folder}/`;
  const bookMeta = Object.fromEntries(Object.entries(meta).filter(([k]) => k.startsWith(prefix)).map(([k, v]) => [k.slice(prefix.length), v]));
  writeFileSync(join(WORK, `${id}.meta.json`), JSON.stringify(bookMeta));
  writeFileSync(join(WORK, `${id}.config.json`), JSON.stringify(bookConfig(config, book), null, 2));
  console.log(`\n== ${book.title} (${id}/) ==`);
  build({
    SITE_CONFIG: join(WORK, `${id}.config.json`),
    META_FILE: join(WORK, `${id}.meta.json`),
    CONTENT_DIR: join(CONTENT, book.folder),
    IMAGE_DIR: CONTENT,
    HISTORY_PREFIX: prefix,
    OUT_DIR: join(OUT, id),
    UPDATES_FILE: join("data", "books", id, "updates.json"),
    BOOK_ID: id,
    BOOK_COVER: book.cover,
    BOOK_STATUS: book.status,
    LIBRARY_URL: "../index.html",
  });
  shelf.push({ id, order: book.order });
}

// ---------- The shelf ----------
// Shared files at the top: the stylesheet and scripts (the same for every title) and the tab icon.
cpSync(join(OUT, mainId, "assets"), join(OUT, "assets"), { recursive: true });
const icons = readdirSync(join(OUT, mainId)).filter((f) => /^(favicon[\w-]*\.(png|svg)|apple-touch-icon\.png)$/.test(f));
for (const f of icons) cpSync(join(OUT, mainId, f), join(OUT, f));
const iconTags = [
  icons.includes("favicon.svg") && '<link rel="icon" href="favicon.svg" type="image/svg+xml">',
  icons.includes("favicon-32.png") && '<link rel="icon" href="favicon-32.png" sizes="32x32" type="image/png">',
  icons.includes("favicon-192.png") && '<link rel="icon" href="favicon-192.png" sizes="192x192" type="image/png">',
  icons.includes("apple-touch-icon.png") && '<link rel="apple-touch-icon" href="apple-touch-icon.png">',
].filter(Boolean).join("\n");

const fmtDate = (iso) => new Date(iso).toLocaleDateString("en", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
const plural = (n, w) => `${n.toLocaleString("en")} ${w}${n === 1 ? "" : "s"}`;
const cards = shelf
  .sort((a, b) => a.order - b.order)
  .map(({ id }) => {
    const b = JSON.parse(readFileSync(join(OUT, id, "book.json"), "utf8"));
    const facts = [b.status, b.chapters && plural(b.chapters, "chapter"), b.sideStories && plural(b.sideStories, "side story").replace(/storys$/, "stories"), b.words && (b.words < 1000 ? plural(b.words, "word") : `${Math.round(b.words / 1000).toLocaleString("en")}k words`)].filter(Boolean);
    const cover = b.cover
      ? `<img class="book-cover" src="${id}/${b.cover.src}" alt=""${b.cover.width ? ` width="${b.cover.width}" height="${b.cover.height}"` : ""} loading="lazy">`
      : `<div class="book-cover book-cover-blank" aria-hidden="true"><span>${esc([...b.title][0] || "")}</span></div>`;
    return `
    <li class="book">
      <a class="book-link" href="${id}/index.html">${cover}</a>
      <div class="book-body">
        <h2 class="book-title"><a href="${id}/index.html">${esc(b.title)}</a></h2>
        ${b.subtitle ? `<p class="book-subtitle">${esc(b.subtitle)}</p>` : ""}
        ${b.description && b.description !== b.subtitle ? `<p class="book-desc">${esc(b.description)}</p>` : ""}
        ${facts.length ? `<p class="book-facts">${facts.map(esc).join(" · ")}</p>` : ""}
        ${b.latest ? `<p class="book-latest"><span class="badge badge-${b.latest.kind === "New" ? "new" : "revised"}">${esc(b.latest.kind)}</span> <a href="${id}/${b.latest.slug}.html">${esc(b.latest.label)}: ${esc(b.latest.title)}</a> <time datetime="${esc(b.latest.date)}">${fmtDate(b.latest.date)}</time></p>` : ""}
      </div>
    </li>`;
  })
  .join("");

const lib = config.library || {};
const title = lib.title || "Library";
writeFileSync(join(OUT, "index.html"), `<!doctype html>
<html lang="${config.lang || "en"}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${esc(lib.description || `Stories by ${config.author || ""}`)}">
<meta name="theme-color" content="#fbfaf7">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Literata:ital,opsz,wght@0,7..72,400;0,7..72,600;1,7..72,400&family=Inter:wght@400;500;600&display=swap">
<link rel="stylesheet" href="assets/style.css">
${iconTags}
<script>
  try { const p = JSON.parse(localStorage.getItem("reader-prefs") || "{}");
    if (p.theme && p.theme !== "auto") document.documentElement.dataset.theme = p.theme;
  } catch (e) {}
</script>
</head>
<body class="page-shelf">
<main class="shelf">
  <header class="shelf-head">
    <h1 class="shelf-title">${esc(title)}</h1>
    ${lib.subtitle || config.author ? `<p class="shelf-sub">${esc(lib.subtitle || `Stories by ${config.author}`)}</p>` : ""}
  </header>
  <ul class="books">${cards}
  </ul>
</main>
<footer class="site-footer"><span>© ${new Date().getFullYear()} ${esc(config.author || "")}</span></footer>
</body>
</html>
`);

// ---------- Old addresses of the main title ----------
const redirects = readdirSync(join(OUT, mainId), { withFileTypes: true })
  .filter((d) => !d.name.startsWith(".") && !["index.html", "book.json", "assets"].includes(d.name) && !icons.includes(d.name))
  .map((d) => (d.isDirectory() ? `/${d.name}/* /${mainId}/${d.name}/:splat 301` : `/${d.name} /${mainId}/${d.name} 301`));
writeFileSync(join(OUT, "_redirects"), redirects.join("\n") + "\n");

console.log(`\nShelf: ${shelf.length} titles; ${redirects.length} redirects from the main title's old addresses.`);
