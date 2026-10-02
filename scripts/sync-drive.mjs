// Mirrors the novel's Google Drive folder into content/ so the build can read it.
//
// Needs GOOGLE_SERVICE_ACCOUNT_JSON (the service account's key file contents),
// or GOOGLE_SERVICE_ACCOUNT_FILE (a path to that key file).
// The Drive folder must be shared with that service account's email address.
// Pulls the Markdown files at the folder root plus everything under the wiki folder;
// writes content/.drive-meta.json with each file's Drive timestamps.
import { createSign } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const config = JSON.parse(readFileSync("site.config.json", "utf8"));
const OUT = "content";
const API = "https://www.googleapis.com/drive/v3";

const b64url = (data) => Buffer.from(data).toString("base64url");

async function accessToken() {
  const file = process.env.GOOGLE_SERVICE_ACCOUNT_FILE;
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON || (file && readFileSync(file, "utf8"));
  if (!raw) throw new Error("Set GOOGLE_SERVICE_ACCOUNT_JSON or GOOGLE_SERVICE_ACCOUNT_FILE.");
  const key = JSON.parse(raw);
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = b64url(JSON.stringify({
    iss: key.client_email,
    scope: "https://www.googleapis.com/auth/drive.readonly",
    aud: "https://oauth2.googleapis.com/token",
    iat: now,
    exp: now + 3600,
  }));
  const signature = createSign("RSA-SHA256").update(`${header}.${claims}`).sign(key.private_key, "base64url");
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: `${header}.${claims}.${signature}`,
    }),
  });
  if (!res.ok) throw new Error(`Token request failed: ${res.status} ${await res.text()}`);
  return (await res.json()).access_token;
}

async function api(token, path, params = {}) {
  const url = `${API}${path}?${new URLSearchParams(params)}`;
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
    if (res.ok) return res;
    if (attempt < 4 && (res.status === 429 || res.status >= 500)) {
      await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
      continue;
    }
    throw new Error(`Drive API ${path} failed: ${res.status} ${await res.text()}`);
  }
}

async function listFolder(token, folderId) {
  const files = [];
  let pageToken;
  do {
    const res = await api(token, "/files", {
      q: `'${folderId}' in parents and trashed = false`,
      fields: "nextPageToken, files(id, name, mimeType, createdTime, modifiedTime)",
      pageSize: "1000",
      supportsAllDrives: "true",
      includeItemsFromAllDrives: "true",
      ...(pageToken ? { pageToken } : {}),
    });
    const body = await res.json();
    files.push(...body.files);
    pageToken = body.nextPageToken;
  } while (pageToken);
  return files;
}

const FOLDER = "application/vnd.google-apps.folder";
const isMarkdown = (f) => f.mimeType !== FOLDER && f.name.toLowerCase().endsWith(".md");

async function walk(token, folderId, prefix, out) {
  for (const f of await listFolder(token, folderId)) {
    const path = prefix ? `${prefix}/${f.name}` : f.name;
    if (f.mimeType === FOLDER) await walk(token, f.id, path, out);
    else if (isMarkdown(f)) out.push({ ...f, path });
  }
}

const token = await accessToken();
const files = [];
for (const f of await listFolder(token, config.drive.folderId)) {
  if (f.mimeType === FOLDER && f.name === config.drive.wikiFolder) await walk(token, f.id, f.name, files);
  else if (isMarkdown(f)) files.push({ ...f, path: f.name });
}

rmSync(OUT, { recursive: true, force: true });
const meta = {};
let done = 0;
const queue = [...files];
await Promise.all(Array.from({ length: 8 }, async () => {
  for (let f; (f = queue.shift()); ) {
    const res = await api(token, `/files/${f.id}`, { alt: "media", supportsAllDrives: "true" });
    const dest = join(OUT, f.path);
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, Buffer.from(await res.arrayBuffer()));
    meta[f.path] = { id: f.id, createdTime: f.createdTime, modifiedTime: f.modifiedTime };
    done++;
  }
}));
writeFileSync(join(OUT, ".drive-meta.json"), JSON.stringify(meta, null, 2));
console.log(`Synced ${done} Markdown files from Drive into ${OUT}/`);
