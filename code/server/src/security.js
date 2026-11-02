import { createCipheriv, createDecipheriv, createHash, randomBytes, scrypt as scryptCb, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

const scrypt = promisify(scryptCb);
const SCRYPT = { N: 2 ** 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const KEY_BYTES = 64;
const CLAIM_ALPHABET = "ABCDEFGHJKMNPQRSTVWXYZ23456789";

export async function hashPassword(password) {
  const salt = randomBytes(16);
  const hash = await scrypt(password, salt, KEY_BYTES, SCRYPT);
  return `scrypt$${salt.toString("base64")}$${hash.toString("base64")}`;
}

export async function verifyPassword(password, stored) {
  const [, salt, hash] = stored.split("$");
  const expected = Buffer.from(hash, "base64");
  const actual = await scrypt(password, Buffer.from(salt, "base64"), KEY_BYTES, SCRYPT);
  return timingSafeEqual(actual, expected);
}

export const randomToken = () => randomBytes(32).toString("base64url");
export const hashToken = (token) => createHash("sha256").update(token).digest("hex");

/** A 20-character code, about 98 bits, grouped so it can be read out or typed. */
export function randomClaimCode() {
  const chars = [];
  while (chars.length < 20) {
    const byte = randomBytes(1)[0];
    // Reject the top of the byte range so every character is equally likely
    if (byte < 240) chars.push(CLAIM_ALPHABET[byte % CLAIM_ALPHABET.length]);
  }
  return chars.join("").match(/.{5}/g).join("-");
}

export const normalizeClaimCode = (code) =>
  String(code).toUpperCase().replace(/[^A-Z0-9]/g, "").match(/.{1,5}/g)?.join("-") ?? "";

/** AES-256-GCM for data at rest. Protects a copied database file, not a compromised server. */
export function seal(key, text) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const body = Buffer.concat([cipher.update(text, "utf8"), cipher.final()]);
  return [iv, cipher.getAuthTag(), body].map((b) => b.toString("base64")).join(".");
}

export function unseal(key, sealed) {
  const [iv, tag, body] = sealed.split(".").map((p) => Buffer.from(p, "base64"));
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(body), decipher.final()]).toString("utf8");
}

export function loadOrCreateKey(file) {
  if (existsSync(file)) return readFileSync(file);
  mkdirSync(path.dirname(file), { recursive: true });
  const key = randomBytes(32);
  writeFileSync(file, key, { mode: 0o600 });
  return key;
}
