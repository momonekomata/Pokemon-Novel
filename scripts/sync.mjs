// Fills content/ for the build. Where the text comes from is set by "source" in site.config.json:
//   "drive" (the default): chapters, wiki pages and images all come from the Google Drive folder.
//   "vault": text comes from the vault repository, images still from Drive's illustrations folder.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const config = JSON.parse(readFileSync("site.config.json", "utf8"));
const source = process.env.CONTENT_SOURCE || config.source || "drive";
const run = (script, env = {}) =>
  execFileSync(process.execPath, [script], { stdio: "inherit", env: { ...process.env, ...env } });

if (source === "vault") {
  run("scripts/sync-drive.mjs", { SYNC_SCOPE: "images" });
  run("scripts/sync-vault.mjs");
} else if (source === "drive") {
  run("scripts/sync-drive.mjs");
} else {
  console.error(`Unknown "source" in site.config.json: ${source} (use "drive" or "vault")`);
  process.exit(1);
}
