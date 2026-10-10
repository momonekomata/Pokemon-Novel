// Author-tier encryption. Pages are AES-256-GCM encrypted with a key derived from the
// author password (PBKDF2-SHA256); the browser derives the same key at login.
// Parameters must match assets/author.js.
import { webcrypto } from "node:crypto";

const { subtle } = webcrypto;
export const KDF_ITERATIONS = 600000;

export async function deriveKey(password, salt) {
  const base = await subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveKey"]);
  return subtle.deriveKey(
    { name: "PBKDF2", hash: "SHA-256", salt: new TextEncoder().encode(salt), iterations: KDF_ITERATIONS },
    base,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt"]
  );
}

export async function encrypt(key, text) {
  const iv = webcrypto.getRandomValues(new Uint8Array(12));
  const data = new Uint8Array(await subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(text)));
  const out = new Uint8Array(iv.length + data.length);
  out.set(iv);
  out.set(data, iv.length);
  return Buffer.from(out).toString("base64");
}
