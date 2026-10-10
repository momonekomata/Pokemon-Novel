// Copies the novel's text from the vault repository (momonekomata/pokemon-novel-vault) into content/,
// next to the illustrations scripts/sync-drive.mjs downloaded with SYNC_SCOPE=images.
//
// Expects a git checkout of the vault at VAULT_DIR (default "vault"), with full history if possible
// (fetch-depth: 0), because each file's dates come from git:
//   modified = date of the last commit that touched it; for a file untouched since the import (its only
//              commit is the repository's first), its Drive modified date from before the move
//   created  = the earlier of its Drive creation date (kept from before the move) and the date of the
//              commit that first added it
// Writes content/.drive-meta.json in the same shape the Drive sync produced, so lib/content.mjs and
// the build need no changes.
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const config = JSON.parse(readFileSync("site.config.json", "utf8"));
const OUT = "content";
const VAULT = process.env.VAULT_DIR || "vault";
const wikiFolder = config.drive.wikiFolder;

if (!existsSync(join(VAULT, ".git"))) {
  console.error(`No vault checkout at ${VAULT}/. Clone momonekomata/pokemon-novel-vault there first.`);
  process.exit(1);
}

// Root Markdown and everything under wiki/, the same scope the Drive sync used.
function listMarkdown(dir, prefix = "") {
  return readdirSync(join(VAULT, dir), { withFileTypes: true }).flatMap((d) => {
    const rel = prefix ? `${prefix}/${d.name}` : d.name;
    if (d.isDirectory()) return d.name === ".git" ? [] : listMarkdown(join(dir, d.name), rel);
    return d.name.toLowerCase().endsWith(".md") ? [rel] : [];
  });
}
const rootFiles = readdirSync(VAULT, { withFileTypes: true })
  .filter((d) => d.isFile() && d.name.toLowerCase().endsWith(".md"))
  .map((d) => d.name);
const wikiFiles = existsSync(join(VAULT, wikiFolder)) ? listMarkdown(wikiFolder, wikiFolder) : [];
const files = [...rootFiles, ...wikiFiles];

// One pass over the history: newest commit first, so the first date seen for a path is its last
// modification and the last date seen is when it was added.
const log = execFileSync("git", ["-C", VAULT, "log", "--no-renames", "--name-only", "--format=>%cI", "HEAD"], {
  encoding: "utf8",
  maxBuffer: 256 * 1024 * 1024,
});
const lastChange = new Map();
const firstAdd = new Map();
let when = null;
for (const line of log.split("\n")) {
  if (line.startsWith(">")) when = line.slice(1);
  else if (line && when) {
    if (!lastChange.has(line)) lastChange.set(line, when);
    firstAdd.set(line, when);
  }
}

// The import commit: the repository's first. A file whose last change is this commit has not been
// edited since the move, so its Drive date (if older) is the truer "last modified".
const firstCommit = execFileSync("git", ["-C", VAULT, "log", "--max-parents=0", "--format=%cI", "HEAD"], { encoding: "utf8" })
  .trim().split("\n").pop();

const metaFile = join(OUT, ".drive-meta.json");
const driveMeta = existsSync(metaFile) ? JSON.parse(readFileSync(metaFile, "utf8")) : {};
const meta = {};
for (const [path, m] of Object.entries(driveMeta)) if (!m.listedOnly) meta[path] = m; // images

const earlier = (a, b) => (!a ? b : !b ? a : new Date(a) <= new Date(b) ? a : b);
let copied = 0;
for (const path of files) {
  const dest = join(OUT, path);
  mkdirSync(dirname(dest), { recursive: true });
  copyFileSync(join(VAULT, path), dest);
  copied++;
  const drive = driveMeta[path];
  const gitModified = lastChange.get(path);
  const untouchedSinceImport = gitModified && gitModified === firstCommit;
  const modified =
    untouchedSinceImport && drive?.modifiedTime && new Date(drive.modifiedTime) <= new Date(gitModified)
      ? drive.modifiedTime
      : gitModified || drive?.modifiedTime || new Date().toISOString();
  const created = earlier(drive?.createdTime, firstAdd.get(path)) || modified;
  meta[path] = { source: "vault", createdTime: created, modifiedTime: modified };
}

const sorted = Object.fromEntries(Object.keys(meta).sort().map((k) => [k, meta[k]]));
writeFileSync(metaFile, JSON.stringify(sorted, null, 2));
const head = execFileSync("git", ["-C", VAULT, "rev-parse", "--short", "HEAD"], { encoding: "utf8" }).trim();
console.log(`Copied ${copied} Markdown files from the vault (commit ${head}) into ${OUT}/`);
