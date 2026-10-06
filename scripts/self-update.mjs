// Keeps the NAS copy of the site's code in step with GitHub.
// Checks the latest commit on GITHUB_BRANCH; if it's new, downloads that version and copies it over
// /app, never touching the NAS's own files (settings, key, built site, Tailscale state, Drive mirror).
//
// Exit codes for nas/run.sh: 0 = nothing to do or update skipped, 3 = updated and run.sh itself changed
// (restart the loop with the new one).
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";

const { GITHUB_TOKEN, GITHUB_REPO = "momonekomata/Pokemon-Novel", GITHUB_BRANCH = "main" } = process.env;
const APP = process.cwd();
const STAMP = join(APP, ".deployed-commit");
// Never overwritten: everything the NAS owns.
const KEEP = new Set(["settings.env", "secrets", "public", "tailscale-state", "content", "data", "node_modules", "_site", ".deployed-commit", "vault", "drive-mirror", "mirror-state"]);

const log = (msg) => console.log(`[${new Date().toISOString().slice(0, 16).replace("T", " ")}] ${msg}`);
const hashFile = (p) => (existsSync(p) ? createHash("sha256").update(readFileSync(p)).digest("hex") : "");

if (!GITHUB_TOKEN) {
  log("Code updates from GitHub are off (no GITHUB_TOKEN in settings.env).");
  process.exit(0);
}

const headers = { authorization: `Bearer ${GITHUB_TOKEN}`, "user-agent": "manyo-site-nas", "x-github-api-version": "2022-11-28" };
const api = `${process.env.GITHUB_API || "https://api.github.com"}/repos/${GITHUB_REPO}`;

try {
  const res = await fetch(`${api}/commits/${encodeURIComponent(GITHUB_BRANCH)}`, { headers: { ...headers, accept: "application/vnd.github.sha" } });
  if (!res.ok) throw new Error(`GitHub said ${res.status} when checking ${GITHUB_REPO} branch "${GITHUB_BRANCH}". ${res.status === 401 ? "The GITHUB_TOKEN is wrong or expired." : res.status === 404 ? "Check GITHUB_REPO and GITHUB_BRANCH, and that the token can read this repository." : ""}`);
  const sha = (await res.text()).trim();
  const current = existsSync(STAMP) ? readFileSync(STAMP, "utf8").trim() : "";
  if (sha === current) {
    log(`Site code is up to date (${sha.slice(0, 7)}).`);
    process.exit(0);
  }

  log(`New site code on GitHub (${sha.slice(0, 7)}); downloading...`);
  const tar = await fetch(`${api}/tarball/${sha}`, { headers });
  if (!tar.ok) throw new Error(`Download failed: ${tar.status}`);
  const work = mkdtempSync(join(tmpdir(), "site-update-"));
  writeFileSync(join(work, "code.tar.gz"), Buffer.from(await tar.arrayBuffer()));
  execFileSync("tar", ["-xzf", "code.tar.gz"], { cwd: work });
  const root = join(work, readdirSync(work).find((d) => d !== "code.tar.gz"));

  // Refuse anything that isn't this site (e.g. a branch that doesn't have it yet).
  for (const required of ["scripts/build.mjs", "nas/run.sh", "package.json"]) {
    if (!existsSync(join(root, required))) throw new Error(`Branch "${GITHUB_BRANCH}" has no ${required}; not updating. Is GITHUB_BRANCH right?`);
  }

  const before = { lock: hashFile(join(APP, "package-lock.json")), run: hashFile(join(APP, "nas/run.sh")), compose: hashFile(join(APP, "docker-compose.yml")), nas: ["nas/nginx.conf", "nas/serve.json"].map((f) => hashFile(join(APP, f))).join() };
  for (const entry of readdirSync(root)) {
    if (KEEP.has(entry)) continue;
    cpSync(join(root, entry), join(APP, entry), { recursive: true, force: true });
  }
  rmSync(work, { recursive: true, force: true });

  if (hashFile(join(APP, "package-lock.json")) !== before.lock) {
    log("Tools changed; reinstalling...");
    execFileSync("npm", ["ci", "--no-audit", "--no-fund"], { cwd: APP, stdio: "inherit" });
  }
  writeFileSync(STAMP, sha + "\n");
  log(`Updated site code to ${sha.slice(0, 7)}.`);

  const nasChanged = ["nas/nginx.conf", "nas/serve.json"].map((f) => hashFile(join(APP, f))).join() !== before.nas;
  if (hashFile(join(APP, "docker-compose.yml")) !== before.compose || nasChanged) {
    log("NOTE: this update changed the container setup. In Container Manager: Project → manyo-site → Stop, then Build.");
  }
  process.exit(hashFile(join(APP, "nas/run.sh")) !== before.run ? 3 : 0);
} catch (err) {
  log(`Code update skipped: ${err.message}`);
  process.exit(0);
}
