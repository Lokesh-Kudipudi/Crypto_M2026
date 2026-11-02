// Algorithms written out step by step for learning. Not constant-time, so never use them with real keys.
// Small byte helpers shared by the demos on this page.
const enc = new TextEncoder();
const hex = (b) => "0x" + [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
const unhex = (h) => Uint8Array.from((h.replace(/^0x/, "").match(/../g) || []).map((x) => parseInt(x, 16)));
const concatBytes = (...parts) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
};
const randomBytes = (n) => crypto.getRandomValues(new Uint8Array(n));
const short = (h, n = 8) => (h.length > n * 2 + 3 ? `${h.slice(0, n + 2)}…${h.slice(-n)}` : h);
// Keccak-256, the hash Ethereum uses. Browsers don't provide it, so it's written out here.
// This is the original Keccak padding (0x01), which differs from the NIST SHA3-256 padding (0x06).
const KECCAK_RC = [
  0x0000000000000001n, 0x0000000000008082n, 0x800000000000808an, 0x8000000080008000n, 0x000000000000808bn,
  0x0000000080000001n, 0x8000000080008081n, 0x8000000000008009n, 0x000000000000008an, 0x0000000000000088n,
  0x0000000080008009n, 0x000000008000000an, 0x000000008000808bn, 0x800000000000008bn, 0x8000000000008089n,
  0x8000000000008003n, 0x8000000000008002n, 0x8000000000000080n, 0x000000000000800an, 0x800000008000000an,
  0x8000000080008081n, 0x8000000000008080n, 0x0000000080000001n, 0x8000000080008008n,
];
const KECCAK_ROT = [1, 3, 6, 10, 15, 21, 28, 36, 45, 55, 2, 14, 27, 41, 56, 8, 25, 43, 62, 18, 39, 61, 20, 44];
const KECCAK_PI = [10, 7, 11, 17, 18, 3, 5, 16, 8, 21, 24, 4, 15, 23, 19, 13, 12, 2, 20, 14, 22, 9, 6, 1];
const MASK64 = (1n << 64n) - 1n;
const rotl64 = (x, n) => ((x << BigInt(n)) | (x >> BigInt(64 - n))) & MASK64;

function keccakF(s) {
  for (let round = 0; round < 24; round++) {
    const c = [0, 1, 2, 3, 4].map((x) => s[x] ^ s[x + 5] ^ s[x + 10] ^ s[x + 15] ^ s[x + 20]);
    for (let x = 0; x < 5; x++) {
      const d = c[(x + 4) % 5] ^ rotl64(c[(x + 1) % 5], 1);
      for (let y = 0; y < 25; y += 5) s[x + y] ^= d;
    }
    let last = s[1];
    for (let i = 0; i < 24; i++) {
      const j = KECCAK_PI[i];
      const next = s[j];
      s[j] = rotl64(last, KECCAK_ROT[i]);
      last = next;
    }
    for (let y = 0; y < 25; y += 5) {
      const row = s.slice(y, y + 5);
      for (let x = 0; x < 5; x++) s[y + x] = row[x] ^ (~row[(x + 1) % 5] & MASK64 & row[(x + 2) % 5]);
    }
    s[0] ^= KECCAK_RC[round];
  }
}

function keccak256(bytes) {
  const RATE = 136;
  const padded = new Uint8Array((Math.floor(bytes.length / RATE) + 1) * RATE);
  padded.set(bytes);
  padded[bytes.length] ^= 0x01;
  padded[padded.length - 1] ^= 0x80;
  const s = new Array(25).fill(0n);
  for (let off = 0; off < padded.length; off += RATE) {
    for (let i = 0; i < RATE / 8; i++) {
      let lane = 0n;
      for (let b = 7; b >= 0; b--) lane = (lane << 8n) | BigInt(padded[off + i * 8 + b]);
      s[i] ^= lane;
    }
    keccakF(s);
  }
  const out = new Uint8Array(32);
  for (let i = 0; i < 4; i++) {
    let lane = s[i];
    for (let b = 0; b < 8; b++) { out[i * 8 + b] = Number(lane & 0xffn); lane >>= 8n; }
  }
  return out;
}
// The same rules as code/client/src/certcrypto.mjs, so these hashes match the real project.
const word = (n) => { const w = new Uint8Array(32); let v = BigInt(n); for (let i = 31; i >= 0; i--) { w[i] = Number(v & 0xffn); v >>= 8n; } return w; };
function abiString(text) {
  const b = enc.encode(text);
  const body = new Uint8Array(Math.ceil(b.length / 32) * 32);
  body.set(b);
  return concatBytes(word(b.length), body);
}
/** abi.encode(string name, string value, bytes32 salt) */
function abiEncodeField(name, value, salt) {
  const a = abiString(name), b = abiString(value);
  return concatBytes(word(96), word(96 + a.length), unhex(salt), a, b);
}
const fieldLeaf = (name, value, salt) => hex(keccak256(concatBytes(Uint8Array.of(0), abiEncodeField(name, value, salt))));
const batchLeaf = (certRoot) => hex(keccak256(concatBytes(Uint8Array.of(2), unhex(certRoot))));
const hashNode = (a, b) => {
  const [low, high] = BigInt(a) < BigInt(b) ? [a, b] : [b, a];
  return hex(keccak256(concatBytes(Uint8Array.of(1), unhex(low), unhex(high))));
};
function treeLevels(leaves) {
  const levels = [leaves];
  while (levels[levels.length - 1].length > 1) {
    const level = levels[levels.length - 1];
    const next = [];
    for (let i = 0; i < level.length; i += 2) next.push(i + 1 < level.length ? hashNode(level[i], level[i + 1]) : level[i]);
    levels.push(next);
  }
  return levels;
}
const merkleRoot = (leaves) => treeLevels(leaves).pop()[0];
function merkleProof(leaves, index) {
  const proof = [];
  for (const level of treeLevels(leaves).slice(0, -1)) {
    const sibling = index ^ 1;
    if (sibling < level.length) proof.push(level[sibling]);
    index >>= 1;
  }
  return proof;
}
const verifyProof = (root, leaf, proof) => proof.reduce(hashNode, leaf) === root;
// secp256k1 written out with BigInt so each step is visible. For learning only: it isn't constant-time,
// so real keys must never be used with it.
const P = 0xfffffffffffffffffffffffffffffffffffffffffffffffffffffffefffffc2fn;
const N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
const G = [0x79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798n,
           0x483ada7726a3c4655da4fbfc0e1108a8fd17b448a68554199c47d08ffb10d4b8n];
const mod = (a, m) => ((a % m) + m) % m;
function inv(a, m) {
  let [r0, r1, s0, s1] = [mod(a, m), m, 1n, 0n];
  while (r1) { const q = r0 / r1; [r0, r1] = [r1, r0 - q * r1]; [s0, s1] = [s1, s0 - q * s1]; }
  return mod(s0, m);
}
function modPow(b, e, m) { let r = 1n; b = mod(b, m); while (e) { if (e & 1n) r = r * b % m; b = b * b % m; e >>= 1n; } return r; }
function pointAdd(p1, p2, field = P) {
  if (!p1) return p2;
  if (!p2) return p1;
  const [x1, y1] = p1, [x2, y2] = p2;
  if (x1 === x2 && mod(y1 + y2, field) === 0n) return null;
  const m = x1 === x2 ? mod(3n * x1 * x1 * inv(2n * y1, field), field) : mod((y2 - y1) * inv(x2 - x1, field), field);
  const x3 = mod(m * m - x1 - x2, field);
  return [x3, mod(m * (x1 - x3) - y1, field)];
}
function pointMul(k, point = G, field = P) {
  let r = null, a = point;
  for (; k > 0n; k >>= 1n) { if (k & 1n) r = pointAdd(r, a, field); a = pointAdd(a, a, field); }
  return r;
}
const bytesToBig = (b) => BigInt(hex(b));
const bigToHex32 = (n) => "0x" + n.toString(16).padStart(64, "0");
function randomScalar() {
  for (;;) { const k = bytesToBig(randomBytes(32)); if (k > 0n && k < N) return k; }
}
const addressOf = (point) => {
  const raw = concatBytes(unhex(bigToHex32(point[0])), unhex(bigToHex32(point[1])));
  return hex(keccak256(raw).slice(12));
};
/** Signs a 32-byte digest, returning a low-s signature, as wallets do. */
function ecdsaSign(digest, priv, fixedK) {
  const z = BigInt(digest);
  for (;;) {
    const k = fixedK ?? randomScalar();
    const R = pointMul(k);
    const r = mod(R[0], N);
    if (r === 0n) continue;
    let s = mod(inv(k, N) * (z + r * priv), N);
    if (s === 0n) continue;
    let v = 27 + Number(R[1] & 1n);
    if (!fixedK && s > N / 2n) { s = N - s; v = v === 27 ? 28 : 27; }
    return { r, s, v };
  }
}
/** ecrecover: the public key that would make this signature valid for this digest. */
function ecdsaRecover(digest, { r, s, v }) {
  const y2 = mod(modPow(r, 3n, P) + 7n, P);
  let y = modPow(y2, (P + 1n) / 4n, P);
  if (mod(y * y, P) !== y2) return null;
  if ((y & 1n) !== BigInt(v - 27)) y = P - y;
  const rInv = inv(r, N);
  const z = BigInt(digest);
  return pointAdd(pointMul(mod(-z * rInv, N)), pointMul(mod(s * rInv, N), [r, y]));
}

// ---- SHA-256 (FIPS 180-4), keeping every round so the page can step through it
const PRIMES = [];
for (let n = 2; PRIMES.length < 64; n++) if (PRIMES.every((p) => n % p)) PRIMES.push(n);
const frac32 = (x) => Math.floor((x % 1) * 2 ** 32) >>> 0;
const SHA_K = PRIMES.map((p) => frac32(Math.cbrt(p)));
const SHA_H0 = PRIMES.slice(0, 8).map((p) => frac32(Math.sqrt(p)));
const rotr = (x, n) => ((x >>> n) | (x << (32 - n))) >>> 0;
const bigSigma0 = (x) => (rotr(x, 2) ^ rotr(x, 13) ^ rotr(x, 22)) >>> 0;
const bigSigma1 = (x) => (rotr(x, 6) ^ rotr(x, 11) ^ rotr(x, 25)) >>> 0;
const smallSigma0 = (x) => (rotr(x, 7) ^ rotr(x, 18) ^ (x >>> 3)) >>> 0;
const smallSigma1 = (x) => (rotr(x, 17) ^ rotr(x, 19) ^ (x >>> 10)) >>> 0;
const ch = (e, f, g) => ((e & f) ^ (~e & g)) >>> 0;
const maj = (a, b, c) => ((a & b) ^ (a & c) ^ (b & c)) >>> 0;

function shaPad(bytes) {
  const padded = new Uint8Array((((bytes.length + 8) >> 6) + 1) * 64);
  padded.set(bytes);
  padded[bytes.length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(padded.length - 8, Math.floor((bytes.length * 8) / 2 ** 32));
  view.setUint32(padded.length - 4, (bytes.length * 8) >>> 0);
  return padded;
}
function sha256Trace(bytes, keep = true) {
  const padded = shaPad(bytes), view = new DataView(padded.buffer);
  const H = SHA_H0.slice(), blocks = [];
  for (let off = 0; off < padded.length; off += 64) {
    const W = new Array(64);
    for (let t = 0; t < 16; t++) W[t] = view.getUint32(off + t * 4);
    for (let t = 16; t < 64; t++) W[t] = (smallSigma1(W[t - 2]) + W[t - 7] + smallSigma0(W[t - 15]) + W[t - 16]) >>> 0;
    let [a, b, c, d, e, f, g, h] = H;
    const rounds = [];
    for (let t = 0; t < 64; t++) {
      const T1 = (h + bigSigma1(e) + ch(e, f, g) + SHA_K[t] + W[t]) >>> 0;
      const T2 = (bigSigma0(a) + maj(a, b, c)) >>> 0;
      if (keep) rounds.push({ before: [a, b, c, d, e, f, g, h], T1, T2 });
      h = g; g = f; f = e; e = (d + T1) >>> 0; d = c; c = b; b = a; a = (T1 + T2) >>> 0;
      if (keep) rounds[t].after = [a, b, c, d, e, f, g, h];
    }
    [a, b, c, d, e, f, g, h].forEach((v, i) => { H[i] = (H[i] + v) >>> 0; });
    if (keep) blocks.push({ W, rounds, H: H.slice() });
  }
  const digest = new Uint8Array(32);
  H.forEach((v, i) => new DataView(digest.buffer).setUint32(i * 4, v));
  return { padded, blocks, digest };
}
const sha256 = (bytes) => sha256Trace(bytes, false).digest;

// ---- HMAC and PBKDF2, as scrypt uses them
function hmacSha256(key, msg) {
  const k = new Uint8Array(64);
  k.set(key.length > 64 ? sha256(key) : key);
  const ipad = k.map((b) => b ^ 0x36), opad = k.map((b) => b ^ 0x5c);
  const inner = sha256(concatBytes(ipad, msg));
  return { ipad, opad, inner, mac: sha256(concatBytes(opad, inner)) };
}
function pbkdf2One(password, salt, length) {
  const out = new Uint8Array(length);
  for (let i = 1, at = 0; at < length; i++, at += 32) {
    const block = hmacSha256(password, concatBytes(salt, Uint8Array.of(i >>> 24, (i >>> 16) & 255, (i >>> 8) & 255, i & 255))).mac;
    out.set(block.slice(0, Math.min(32, length - at)), at);
  }
  return out;
}

// ---- scrypt (RFC 7914)
function salsa208(B) {
  const x = B.slice();
  const R = (a, b) => (a << b) | (a >>> (32 - b));
  for (let i = 0; i < 8; i += 2) {
    x[4] ^= R(x[0] + x[12], 7); x[8] ^= R(x[4] + x[0], 9); x[12] ^= R(x[8] + x[4], 13); x[0] ^= R(x[12] + x[8], 18);
    x[9] ^= R(x[5] + x[1], 7); x[13] ^= R(x[9] + x[5], 9); x[1] ^= R(x[13] + x[9], 13); x[5] ^= R(x[1] + x[13], 18);
    x[14] ^= R(x[10] + x[6], 7); x[2] ^= R(x[14] + x[10], 9); x[6] ^= R(x[2] + x[14], 13); x[10] ^= R(x[6] + x[2], 18);
    x[3] ^= R(x[15] + x[11], 7); x[7] ^= R(x[3] + x[15], 9); x[11] ^= R(x[7] + x[3], 13); x[15] ^= R(x[11] + x[7], 18);
    x[1] ^= R(x[0] + x[3], 7); x[2] ^= R(x[1] + x[0], 9); x[3] ^= R(x[2] + x[1], 13); x[0] ^= R(x[3] + x[2], 18);
    x[6] ^= R(x[5] + x[4], 7); x[7] ^= R(x[6] + x[5], 9); x[4] ^= R(x[7] + x[6], 13); x[5] ^= R(x[4] + x[7], 18);
    x[11] ^= R(x[10] + x[9], 7); x[8] ^= R(x[11] + x[10], 9); x[9] ^= R(x[8] + x[11], 13); x[10] ^= R(x[9] + x[8], 18);
    x[12] ^= R(x[15] + x[14], 7); x[13] ^= R(x[12] + x[15], 9); x[14] ^= R(x[13] + x[12], 13); x[15] ^= R(x[14] + x[13], 18);
  }
  for (let i = 0; i < 16; i++) B[i] = (B[i] + x[i]) | 0;
}
function blockMix(B, Y, r) {
  const X = B.slice(32 * r - 16, 32 * r);
  for (let i = 0; i < 2 * r; i++) {
    for (let j = 0; j < 16; j++) X[j] ^= B[i * 16 + j];
    salsa208(X);
    Y.set(X, i * 16);
  }
  for (let i = 0; i < r; i++) B.set(Y.subarray(i * 2 * 16, (i * 2 + 1) * 16), i * 16);
  for (let i = 0; i < r; i++) B.set(Y.subarray((i * 2 + 1) * 16, (i * 2 + 2) * 16), (i + r) * 16);
}
function scrypt(password, salt, { cost, r, p, dkLen }, onStep) {
  const blockWords = 32 * r;
  const initial = pbkdf2One(password, salt, p * 128 * r);
  const words = new Uint32Array(initial.buffer.slice(0));
  const V = new Uint32Array(cost * blockWords);
  const Y = new Uint32Array(blockWords);
  for (let i = 0; i < p; i++) {
    const X = words.subarray(i * blockWords, (i + 1) * blockWords);
    for (let n = 0; n < cost; n++) {
      V.set(X, n * blockWords);
      if (onStep) onStep({ phase: "fill", n, head: X[0] });
      blockMix(X, Y, r);
    }
    for (let n = 0; n < cost; n++) {
      const j = X[(2 * r - 1) * 16] & (cost - 1);
      if (onStep) onStep({ phase: "read", n, j });
      for (let w = 0; w < blockWords; w++) X[w] ^= V[j * blockWords + w];
      blockMix(X, Y, r);
    }
  }
  return pbkdf2One(password, new Uint8Array(words.buffer), dkLen);
}

// ---- AES (FIPS 197), keeping the state after every operation
const SBOX = new Uint8Array(256);
(function buildSbox() {
  let p = 1, q = 1;
  const rotl8 = (x, n) => ((x << n) | (x >> (8 - n))) & 0xff;
  do {
    p = (p ^ ((p << 1) & 0xff) ^ (p & 0x80 ? 0x1b : 0)) & 0xff;
    q ^= (q << 1) & 0xff; q ^= (q << 2) & 0xff; q ^= (q << 4) & 0xff;
    if (q & 0x80) q ^= 0x09;
    SBOX[p] = (q ^ rotl8(q, 1) ^ rotl8(q, 2) ^ rotl8(q, 3) ^ rotl8(q, 4)) ^ 0x63;
  } while (p !== 1);
  SBOX[0] = 0x63;
})();
const xtime = (b) => ((b << 1) ^ (b & 0x80 ? 0x1b : 0)) & 0xff;
function expandKey(key) {
  const Nk = key.length / 4, Nr = Nk + 6, w = [];
  for (let i = 0; i < Nk; i++) w.push(key.slice(i * 4, i * 4 + 4));
  let rcon = 1;
  for (let i = Nk; i < 4 * (Nr + 1); i++) {
    let t = w[i - 1].slice();
    if (i % Nk === 0) {
      t = Uint8Array.of(SBOX[t[1]] ^ rcon, SBOX[t[2]], SBOX[t[3]], SBOX[t[0]]);
      rcon = xtime(rcon);
    } else if (Nk > 6 && i % Nk === 4) t = t.map((b) => SBOX[b]);
    w.push(w[i - Nk].map((b, j) => b ^ t[j]));
  }
  const roundKeys = [];
  for (let r = 0; r <= Nr; r++) roundKeys.push(concatBytes(w[r * 4], w[r * 4 + 1], w[r * 4 + 2], w[r * 4 + 3]));
  return roundKeys;
}
const subBytes = (s) => s.map((b) => SBOX[b]);
const shiftRows = (s) => s.map((_, i) => { const r = i % 4, c = i >> 2; return s[r + 4 * ((c + r) % 4)]; });
function mixColumns(s) {
  const out = new Uint8Array(16);
  for (let c = 0; c < 4; c++) {
    const [a, b, d, e] = s.slice(c * 4, c * 4 + 4);
    out[c * 4] = xtime(a) ^ (xtime(b) ^ b) ^ d ^ e;
    out[c * 4 + 1] = a ^ xtime(b) ^ (xtime(d) ^ d) ^ e;
    out[c * 4 + 2] = a ^ b ^ xtime(d) ^ (xtime(e) ^ e);
    out[c * 4 + 3] = (xtime(a) ^ a) ^ b ^ d ^ xtime(e);
  }
  return out;
}
const addRoundKey = (s, k) => s.map((b, i) => b ^ k[i]);
function aesBlock(block, key, trace) {
  const rk = expandKey(key), Nr = rk.length - 1;
  const note = (round, op, state, roundKey) => { if (trace) trace.push({ round, op, state: state.slice(), roundKey }); };
  note(0, "Input", block);
  let s = addRoundKey(block, rk[0]);
  note(0, "AddRoundKey", s, rk[0]);
  for (let r = 1; r <= Nr; r++) {
    s = subBytes(s); note(r, "SubBytes", s);
    s = shiftRows(s); note(r, "ShiftRows", s);
    if (r < Nr) { s = mixColumns(s); note(r, "MixColumns", s); }
    s = addRoundKey(s, rk[r]); note(r, "AddRoundKey", s, rk[r]);
  }
  return s;
}

// ---- GCM (NIST SP 800-38D): counter mode and GHASH written out
const GCM_R = 0xe1n << 120n;
const blockToBig = (b) => BigInt(hex(b.length ? b : new Uint8Array(1)));
const bigToBlock = (n) => unhex(n.toString(16).padStart(32, "0"));
function gfMul(x, y) {
  let z = 0n, v = y;
  for (let i = 127n; i >= 0n; i--) {
    if ((x >> i) & 1n) z ^= v;
    v = v & 1n ? (v >> 1n) ^ GCM_R : v >> 1n;
  }
  return z;
}
const toBlocks16 = (bytes) => {
  const out = [];
  for (let i = 0; i < bytes.length; i += 16) { const b = new Uint8Array(16); b.set(bytes.slice(i, i + 16)); out.push(b); }
  return out;
};
const incCounter = (c) => { const out = c.slice(); new DataView(out.buffer).setUint32(12, (new DataView(out.buffer).getUint32(12) + 1) >>> 0); return out; };
function gcmEncrypt(key, iv, aad, plain) {
  const H = aesBlock(new Uint8Array(16), key);
  const J0 = concatBytes(iv, Uint8Array.of(0, 0, 0, 1));
  const ct = new Uint8Array(plain.length), counters = [];
  let counter = J0;
  for (let i = 0; i < plain.length; i += 16) {
    counter = incCounter(counter);
    const keystream = aesBlock(counter, key);
    for (let j = 0; j < 16 && i + j < plain.length; j++) ct[i + j] = plain[i + j] ^ keystream[j];
    counters.push({ counter, keystream, plain: plain.slice(i, i + 16), cipher: ct.slice(i, i + 16) });
  }
  const lengths = new Uint8Array(16);
  const lv = new DataView(lengths.buffer);
  lv.setUint32(4, aad.length * 8);
  lv.setUint32(12, plain.length * 8);
  const h = blockToBig(H), ghash = [];
  let y = 0n;
  for (const [kind, blocks] of [["AAD", toBlocks16(aad)], ["Ciphertext", toBlocks16(ct)], ["Lengths", [lengths]]]) {
    for (const block of blocks) {
      y = gfMul(y ^ blockToBig(block), h);
      ghash.push({ kind, block, y: bigToBlock(y) });
    }
  }
  const S = bigToBlock(y), mask = aesBlock(J0, key);
  const tag = S.map((b, i) => b ^ mask[i]);
  return { H, J0, counters, ct, ghash, S, mask, tag };
}

// ---- Keccak-f[1600], one step at a time
const KECCAK_RHO = [0, 1, 62, 28, 27, 36, 44, 6, 55, 20, 3, 10, 43, 25, 39, 41, 45, 15, 21, 8, 18, 2, 61, 56, 14];
const rotlLane = (x, n) => (n ? rotl64(x, n) : x);
function keccakSteps(firstBlock) {
  const s = new Array(25).fill(0n);
  for (let i = 0; i < 17; i++) {
    let lane = 0n;
    for (let b = 7; b >= 0; b--) lane = (lane << 8n) | BigInt(firstBlock[i * 8 + b]);
    s[i] = lane;
  }
  const steps = [{ round: 0, step: "Absorbed", lanes: s.slice() }];
  let a = s;
  for (let round = 0; round < 24; round++) {
    const c = [0, 1, 2, 3, 4].map((x) => a[x] ^ a[x + 5] ^ a[x + 10] ^ a[x + 15] ^ a[x + 20]);
    a = a.map((lane, i) => lane ^ c[(i % 5 + 4) % 5] ^ rotl64(c[(i % 5 + 1) % 5], 1));
    steps.push({ round, step: "θ theta", lanes: a.slice() });
    a = a.map((lane, i) => rotlLane(lane, KECCAK_RHO[i]));
    steps.push({ round, step: "ρ rho", lanes: a.slice() });
    const b = new Array(25);
    for (let x = 0; x < 5; x++) for (let y = 0; y < 5; y++) b[y + 5 * ((2 * x + 3 * y) % 5)] = a[x + 5 * y];
    a = b;
    steps.push({ round, step: "π pi", lanes: a.slice() });
    a = a.map((lane, i) => { const y = i - (i % 5), x = i % 5; return lane ^ (~a[y + (x + 1) % 5] & MASK64 & a[y + (x + 2) % 5]); });
    steps.push({ round, step: "χ chi", lanes: a.slice() });
    a = a.slice();
    a[0] ^= KECCAK_RC[round];
    steps.push({ round, step: "ι iota", lanes: a.slice() });
  }
  return steps;
}

// ---- Page helpers
const $ = (id) => document.getElementById(id);
const hx = (b) => hex(b).slice(2);
const w32 = (n) => (n >>> 0).toString(16).padStart(8, "0");
const verdict = (el, tone, text) => { el.innerHTML = ""; const d = document.createElement("div"); d.className = `verdict ${tone}`; d.textContent = text; el.append(d); };
function rows(tbody, data, monoCols = []) {
  tbody.innerHTML = "";
  for (const r of data) {
    const tr = document.createElement("tr");
    r.forEach((text, i) => { const td = document.createElement("td"); td.textContent = text; if (monoCols.includes(i)) td.className = "mono-cell"; tr.append(td); });
    tbody.append(tr);
  }
}
function chips(el, items) {
  el.innerHTML = "";
  for (const [text, cls] of items) { const s = document.createElement("span"); s.textContent = text; if (cls) s.className = cls; el.append(s); }
}
const on = (id, fn, event = "input") => { $(id).addEventListener(event, fn); };

// SHA-256 lab
function renderSha() {
  const msg = enc.encode($("shaIn").value), t = Number($("shaRound").value);
  const tr = sha256Trace(msg), block = tr.blocks[0], rd = block.rounds[t];
  const lenStart = tr.padded.length - 8;
  chips($("shaPad"), [...tr.padded.slice(0, 64)].map((b, i) => {
    const cls = i < msg.length ? "msg" : i >= lenStart && tr.padded.length === 64 ? "len" : "pad";
    return [b.toString(16).padStart(2, "0"), cls];
  }));
  $("shaRoundVal").textContent = t;
  $("shaRegs").innerHTML = "";
  "abcdefgh".split("").forEach((name, i) => {
    const d = document.createElement("div"), b = document.createElement("b");
    b.textContent = name;
    d.append(b, w32(rd.after[i]));
    $("shaRegs").append(d);
  });
  const [a, b, c, , e, f, g, h] = rd.before;
  rows($("shaCalc"), [
    ["T1", `h ${w32(h)} + Σ1(e) ${w32(bigSigma1(e))} + Ch ${w32(ch(e, f, g))} + K[${t}] ${w32(SHA_K[t])} + W[${t}] ${w32(block.W[t])} = ${w32(rd.T1)}`],
    ["T2", `Σ0(a) ${w32(bigSigma0(a))} + Maj ${w32(maj(a, b, c))} = ${w32(rd.T2)}`],
  ], [1]);
  chips($("shaW"), block.W.map((v, i) => [w32(v), i === t ? "on" : ""]));
  $("shaOut").textContent = hx(tr.digest);
}
on("shaIn", renderSha);
on("shaRound", renderSha);

// Claim codes
const CLAIM_ALPHABET = "ABCDEFGHJKMNPQRSTVWXYZ23456789";
function makeClaim() {
  const chars = [];
  let rejected = 0, used = 0;
  while (chars.length < 20) {
    const byte = randomBytes(1)[0];
    used++;
    if (byte < 240) chars.push(CLAIM_ALPHABET[byte % 30]); else rejected++;
  }
  const code = chars.join("").match(/.{5}/g).join("-");
  $("claimOut").textContent = code;
  $("claimHash").textContent = hx(sha256(enc.encode(code)));
  $("claimNote").textContent = `Used ${used} random bytes, and ${rejected} ${rejected === 1 ? "was" : "were"} rejected for being 240 or above.`;
}
on("claimGo", makeClaim, "click");

// HMAC
function renderHmac() {
  const r = hmacSha256(enc.encode($("hKey").value), enc.encode($("hMsg").value));
  $("hInner").textContent = hx(r.inner);
  $("hOut").textContent = hx(r.mac);
}
on("hKey", renderHmac);
on("hMsg", renderHmac);

// scrypt lab
const SC_SALT = randomBytes(16);
function renderScrypt() {
  const cost = Number($("scN").value), reads = [];
  scrypt(enc.encode($("scPw").value), SC_SALT, { cost, r: 1, p: 1, dkLen: 32 }, (s) => { if (s.phase === "read") reads.push(s.j); });
  const counts = new Array(cost).fill(0);
  reads.forEach((j) => counts[j]++);
  $("scMem").innerHTML = "";
  counts.forEach((c, i) => {
    const cell = document.createElement("i");
    cell.textContent = i;
    cell.title = `Block ${i}: read ${c} time${c === 1 ? "" : "s"}`;
    if (c >= 2) cell.className = "hit3"; else if (c === 1) cell.className = "hit2";
    $("scMem").append(cell);
  });
  $("scOrder").textContent = reads.join(" → ");
}
on("scPw", renderScrypt);
on("scN", renderScrypt, "change");
on("scFull", () => {
  $("scFullOut").textContent = "Running…";
  setTimeout(() => {
    const start = performance.now();
    const out = scrypt(enc.encode($("scPw").value), SC_SALT, { cost: 2 ** 15, r: 8, p: 1, dkLen: 64 });
    const ms = performance.now() - start;
    $("scFullOut").textContent = `N = 32,768, r = 8, p = 1 took ${ms.toFixed(0)} ms on this device. Output: ${hx(out).slice(0, 48)}…`;
  }, 20);
}, "click");

// AES lab
let aesKey = randomBytes(32), aesTrace = [];
const AES_DESC = {
  Input: "The 16 plaintext bytes, arranged column by column.",
  AddRoundKey: "XOR with this round's key. This is the only step where the key enters.",
  SubBytes: "Each byte is replaced using the S-box. This is the only non-linear step.",
  ShiftRows: "Row 0 stays, and rows 1, 2 and 3 rotate left by 1, 2 and 3.",
  MixColumns: "Each column is multiplied by a fixed matrix, so every byte affects its whole column.",
};
const aesInput = () => { const b = new Uint8Array(16); b.set(enc.encode($("aesIn").value).slice(0, 16)); return b; };
function computeAes() {
  aesTrace = [];
  const out = aesBlock(aesInput(), aesKey, aesTrace);
  $("aesKey").textContent = hx(aesKey);
  $("aesOut").textContent = hx(out);
  $("aesStep").max = aesTrace.length - 1;
  const flipped = aesInput(); flipped[0] ^= 1;
  const other = aesBlock(flipped, aesKey);
  let bits = 0;
  out.forEach((b, i) => { let x = b ^ other[i]; while (x) { bits += x & 1; x >>= 1; } });
  $("aesAvalanche").textContent = `Flipping 1 input bit changes ${bits} of the 128 output bits.`;
  renderAes();
}
function renderAes() {
  const i = Math.min(Number($("aesStep").value), aesTrace.length - 1), st = aesTrace[i], prev = aesTrace[i - 1];
  $("aesStepVal").textContent = `${i} of ${aesTrace.length - 1}`;
  $("aesOp").textContent = st.op === "Input" ? "Input" : `Round ${st.round}: ${st.op}`;
  $("aesDesc").textContent = AES_DESC[st.op];
  $("aesRkBox").hidden = !st.roundKey;
  if (st.roundKey) $("aesRk").textContent = hx(st.roundKey);
  const grid = $("aesState");
  grid.innerHTML = "";
  for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++) {
    const cell = document.createElement("i"), idx = r + 4 * c;
    cell.textContent = st.state[idx].toString(16).padStart(2, "0");
    if (prev && prev.state[idx] !== st.state[idx]) cell.className = "changed";
    grid.append(cell);
  }
}
on("aesIn", computeAes);
on("aesStep", renderAes);
on("aesNewKey", () => { aesKey = randomBytes(32); computeAes(); }, "click");

// GCM lab
const GCM_AAD = enc.encode("academic-certificate-pdf-v1");
const gcmKey = randomBytes(32), gcmIv = randomBytes(12);
async function renderGcm() {
  const plain = enc.encode($("gcmIn").value);
  const r = gcmEncrypt(gcmKey, gcmIv, GCM_AAD, plain);
  $("gcmH").textContent = hx(r.H);
  $("gcmJ").textContent = hx(r.J0);
  rows($("gcmCtr"), r.counters.slice(0, 6).map((c) => [hx(c.counter), hx(c.keystream), hx(c.cipher)]), [0, 1, 2]);
  rows($("gcmGhash"), r.ghash.slice(0, 12).map((g) => [g.kind, hx(g.block), hx(g.y)]), [1, 2]);
  $("gcmTag").textContent = hx(r.tag);
  try {
    const key = await crypto.subtle.importKey("raw", gcmKey, "AES-GCM", false, ["encrypt"]);
    const real = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: gcmIv, additionalData: GCM_AAD }, key, plain));
    $("gcmReal").textContent = hx(real.slice(-16));
    const same = hx(real) === hx(concatBytes(r.ct, r.tag));
    verdict($("gcmVerdict"), same ? "good" : "bad", same ? "The hand-computed ciphertext and tag match the browser's AES-GCM exactly." : "These don't match.");
  } catch {
    $("gcmReal").textContent = "Web Crypto isn't available here.";
    $("gcmVerdict").innerHTML = "";
  }
}
on("gcmIn", renderGcm);

// Toy curve
const TOY_P = 97n;
const toyPoints = [];
for (let x = 0n; x < TOY_P; x++) for (let y = 0n; y < TOY_P; y++) if (mod(y * y - x * x * x - 7n, TOY_P) === 0n) toyPoints.push([x, y]);
const toyOrder = (g) => { let n = 1, p = g; while ((p = pointAdd(p, g, TOY_P))) n++; return n + 1; };
const toyG = toyPoints.reduce((best, p) => (toyOrder(p) > toyOrder(best) ? p : best), toyPoints[0]);
const toyN = toyOrder(toyG), TOY_N = BigInt(toyN);
const pt = (p) => (p ? `(${p[0]}, ${p[1]})` : "infinity");
const NS = "http://www.w3.org/2000/svg";
const svgEl = (name, attrs) => { const e = document.createElementNS(NS, name); for (const a in attrs) e.setAttribute(a, attrs[a]); return e; };
function renderToy() {
  const k = Number($("toyK").value);
  $("toyKVal").textContent = `${k} (binary ${k.toString(2)})`;
  const svg = $("toyCurve"), px = (v) => 16 + Number(v) * 3.2, py = (v) => 324 - Number(v) * 3.2;
  svg.innerHTML = "";
  for (const [x, y] of toyPoints) svg.append(svgEl("circle", { cx: px(x), cy: py(y), r: 3, fill: "#c6d2e6" }));
  svg.append(svgEl("circle", { cx: px(toyG[0]), cy: py(toyG[1]), r: 6, fill: "#fff", stroke: "#2a5599", "stroke-width": 2 }));
  const result = pointMul(BigInt(k), toyG, TOY_P);
  if (result) svg.append(svgEl("circle", { cx: px(result[0]), cy: py(result[1]), r: 7, fill: "#2a5599" }));
  // Left-to-right double-and-add, as usually taught
  const out = [];
  let r = null;
  for (const bit of k.toString(2)) {
    r = pointAdd(r, r, TOY_P);
    let op = "Double";
    if (bit === "1") { r = pointAdd(r, toyG, TOY_P); op = "Double, then add G"; }
    out.push([bit, op, pt(r)]);
  }
  rows($("toyRows"), out, [2]);
}
on("toyK", renderToy);

// Toy ECDSA
function renderEcdsa() {
  const n = TOY_N, whole = (id) => mod(BigInt(Math.trunc(Number($(id).value)) || 0), n);
  const d = whole("eD"), k = whole("eK"), z = whole("eZ");
  if (!d || !k) { rows($("eRows"), []); return verdict($("eVerdict"), "warn", `d and k must not be a multiple of ${n}.`); }
  const Q = pointMul(d, toyG, TOY_P), R = pointMul(k, toyG, TOY_P), r = mod(R[0], n);
  const s = mod((z + r * d) * inv(k, n), n);
  if (!r || !s) { rows($("eRows"), []); return verdict($("eVerdict"), "warn", "This k gives r or s of 0, so a real signer would pick another k."); }
  const u1 = mod(z * inv(s, n), n), u2 = mod(r * inv(s, n), n);
  const Rp = pointAdd(pointMul(u1, toyG, TOY_P), pointMul(u2, Q, TOY_P), TOY_P);
  rows($("eRows"), [
    ["Public key", "Q = d × G", pt(Q)],
    ["Nonce point", "R = k × G", pt(R)],
    ["r", "R.x mod n", String(r)],
    ["s", `(${z} + ${r}·${d}) / ${k} mod ${n}`, String(s)],
    ["u1", `${z} / ${s} mod ${n}`, String(u1)],
    ["u2", `${r} / ${s} mod ${n}`, String(u2)],
    ["R'", "u1 × G + u2 × Q", pt(Rp)],
  ], [1, 2]);
  const valid = Rp && mod(Rp[0], n) === r;
  verdict($("eVerdict"), valid ? "good" : "bad", valid ? `Valid: R'.x mod n = ${r} = r.` : "Invalid.");
}
["eD", "eK", "eZ"].forEach((id) => on(id, renderEcdsa));

// Real ECDSA
function renderReal() {
  const z = hex(keccak256(enc.encode($("rMsg").value)));
  const d = randomScalar(), sig = ecdsaSign(z, d), address = addressOf(pointMul(d));
  const twin = { r: sig.r, s: N - sig.s, v: sig.v === 27 ? 28 : 27 };
  const recovered = addressOf(ecdsaRecover(z, sig));
  rows($("rRows"), [
    ["z", z], ["Signer's address", address], ["r", bigToHex32(sig.r)], ["s (always in the lower half)", bigToHex32(sig.s)], ["v", String(sig.v)],
    ["Address recovered from (r, s, v)", recovered], ["Address recovered from the twin (r, n - s, flipped v)", addressOf(ecdsaRecover(z, twin))],
  ], [1]);
}
on("rSign", renderReal, "click");
on("rMsg", renderReal);

// EIP-712
const kText = (t) => keccak256(enc.encode(t));
const EIP_ROOT = hex(randomBytes(32));
function eipDigest(root, count, chainId, registry) {
  const domain = keccak256(concatBytes(kText("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"), kText("AcademicCertificates"), kText("1"), word(chainId), word(BigInt(registry))));
  const struct = keccak256(concatBytes(kText("Batch(bytes32 root,uint32 count)"), unhex(root), word(count)));
  return { domain, struct, digest: keccak256(concatBytes(Uint8Array.of(0x19, 1), domain, struct)) };
}
function renderEip() {
  let d;
  try { d = eipDigest(EIP_ROOT, $("eipCount").value || 0, $("eipChain").value || 0, $("eipRegistry").value); }
  catch { return rows($("eipRows"), [["Input", "Enter whole numbers and a valid hex address."]]); }
  rows($("eipRows"), [
    ["Batch root (random here)", EIP_ROOT], ["Domain separator", hex(d.domain)], ["Struct hash", hex(d.struct)], ["Digest to sign", hex(d.digest)],
  ], [1]);
}
["eipCount", "eipChain", "eipRegistry"].forEach((id) => on(id, renderEip));

// personal_sign
function renderPs() {
  const m = enc.encode($("psIn").value);
  const bytes = concatBytes(enc.encode(`\x19Ethereum Signed Message:\n${m.length}`), m);
  $("psBytes").textContent = hx(bytes);
  $("psDigest").textContent = hex(keccak256(bytes));
}
on("psIn", renderPs);

// Keccak lab
let kSteps = [];
const lane = (v) => v.toString(16).padStart(16, "0");
function computeKeccak() {
  const msg = enc.encode($("kIn").value);
  const first = new Uint8Array(136);
  first.set(msg.slice(0, 136));
  if (msg.length < 136) { first[msg.length] ^= 0x01; first[135] ^= 0x80; }
  kSteps = keccakSteps(first);
  $("kStep").max = kSteps.length - 1;
  $("kOut").textContent = hex(keccak256(msg));
  renderKeccak();
}
function renderKeccak() {
  const i = Number($("kStep").value), st = kSteps[i], prev = kSteps[i - 1];
  $("kStepVal").textContent = i ? `Step ${i} of ${kSteps.length - 1}: round ${st.round + 1}, ${st.step}` : "Step 0: the first block absorbed into an empty state";
  $("kLanes").innerHTML = "";
  st.lanes.forEach((v, j) => {
    const cell = document.createElement("i");
    cell.textContent = lane(v);
    cell.title = `A[${j % 5}, ${Math.floor(j / 5)}]`;
    if (prev && prev.lanes[j] !== v) cell.className = "changed";
    $("kLanes").append(cell);
  });
}
on("kIn", computeKeccak);
on("kStep", renderKeccak);

// ABI encoding
const ABI_SALT = hex(randomBytes(32));
function renderAbi() {
  const name = $("abiName").value, value = $("abiValue").value;
  const data = abiEncodeField(name, value, ABI_SALT), nameLen = enc.encode(name).length, valueLen = enc.encode(value).length;
  const nameWords = Math.ceil(nameLen / 32), valueWords = Math.ceil(valueLen / 32);
  const out = [];
  for (let i = 0; i < data.length / 32; i++) {
    const meaning = i === 0 ? "Where the name starts (byte 96)" : i === 1 ? `Where the value starts (byte ${96 + 32 + nameWords * 32})`
      : i === 2 ? "Salt, 32 random bytes" : i === 3 ? `Name's length: ${nameLen} bytes` : i < 4 + nameWords ? `Name: "${name}"`
      : i === 4 + nameWords ? `Value's length: ${valueLen} bytes` : `Value: "${value}"`;
    out.push([String(i * 32), hx(data.slice(i * 32, i * 32 + 32)), meaning]);
  }
  rows($("abiRows"), out, [1]);
  $("abiLeaf").textContent = fieldLeaf(name, value, ABI_SALT);
}
on("abiName", renderAbi);
on("abiValue", renderAbi);

// Merkle proof lab
const M_VALUES = {
  certificateId: "CERT-2026-0042", uid: "U-1042", candidateName: "Sample Student", courseName: "B.Tech Computer Science",
  organizationName: "Demo University", cgpa: "8.72", completionYear: "2026", pdfSha256: "0x9f2c41e07ab3d58c", pdfCid: "bafybeifictionalcid",
};
const M_NAMES = Object.keys(M_VALUES);
const mSalts = M_NAMES.map(() => hex(randomBytes(32)));
const mLeaves = M_NAMES.map((n, i) => fieldLeaf(n, M_VALUES[n], mSalts[i]));
const mRoot = merkleRoot(mLeaves);
M_NAMES.forEach((n, i) => { const o = document.createElement("option"); o.value = i; o.textContent = `${n}: ${M_VALUES[n]}`; $("mField").append(o); });
function renderMerkle() {
  const i = Number($("mField").value), proof = merkleProof(mLeaves, i), out = [];
  let h = mLeaves[i];
  proof.forEach((sib, step) => {
    const lowFirst = BigInt(h) < BigInt(sib);
    const next = hashNode(h, sib);
    out.push([String(step + 1), short(h, 6), short(sib, 6), lowFirst ? "Current first" : "Sibling first", short(next, 6)]);
    h = next;
  });
  rows($("mRows"), out, [1, 2, 4]);
  const depth = Math.ceil(Math.log2(M_NAMES.length));
  const promoted = depth - proof.length;
  verdict($("mVerdict"), h === mRoot ? "good" : "bad", `The final hash ${h === mRoot ? "equals" : "differs from"} the certificate root ${short(mRoot, 6)}.${promoted ? ` The proof is shorter than the tree's depth of ${depth}, since this leaf was promoted at ${promoted} level${promoted === 1 ? "" : "s"}.` : ""}`);
}
on("mField", renderMerkle, "change");
rows($("mSizes"), [1, 9, 100, 1000, 1000000].map((n) => {
  const hashes = n === 1 ? 0 : Math.ceil(Math.log2(n));
  return [n.toLocaleString("en-US"), String(hashes), `${hashes * 32} bytes`];
}));

// Contents highlighting
const tocLinks = [...document.querySelectorAll("#toc a")];
if ("IntersectionObserver" in window) {
  const observer = new IntersectionObserver((entries) => {
    for (const entry of entries) if (entry.isIntersecting) tocLinks.forEach((a) => a.classList.toggle("active", a.getAttribute("href") === `#${entry.target.id}`));
  }, { rootMargin: "-10% 0px -80% 0px" });
  tocLinks.forEach((a) => { const s = document.querySelector(a.getAttribute("href")); if (s) observer.observe(s); });
}

// Self-check
async function runTests() {
  const addr1 = addressOf(pointMul(1n));
  const fipsAes = hx(aesBlock(unhex("00112233445566778899aabbccddeeff"), unhex("000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f")));
  const rfcScrypt = hx(scrypt(enc.encode("password"), enc.encode("NaCl"), { cost: 1024, r: 8, p: 16, dkLen: 64 }));
  const keccakMsg = new Uint8Array(136); keccakMsg[0] = 0x01; keccakMsg[135] = 0x80;
  const stepsOut = keccakSteps(keccakMsg).pop().lanes.slice(0, 4).map((l) => lane(l).match(/../g).reverse().join("")).join("");
  const z = hex(keccak256(enc.encode("test"))), d = randomScalar();
  const toyPrime = (() => { for (let i = 2; i * i <= toyN; i++) if (toyN % i === 0) return false; return toyN > 1; })();
  const results = [
    ["SHA-256 matches the published vector for \"abc\"", hx(sha256(enc.encode("abc"))) === "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"],
    ["AES-256 matches the FIPS 197 vector", fipsAes === "8ea2b7ca516745bfeafc49904b496089"],
    ["Keccak-256 matches the known hash of empty input", hx(keccak256(new Uint8Array())) === "c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470"],
    ["Stepped Keccak-f matches Keccak-256", stepsOut === hx(keccak256(new Uint8Array()))],
    ["The address of private key 1 matches the known value", addr1 === "0x7e5f4552091a69125d5dfcb7b8c2659029395bdf"],
    ["ECDSA signing and recovery round-trip", addressOf(ecdsaRecover(z, ecdsaSign(z, d))) === addressOf(pointMul(d))],
    [`The toy curve's order (${toyN}) is prime`, toyPrime],
    ["scrypt matches the RFC 7914 vector", rfcScrypt === "fdbabe1c9d3472007856e7190d01e9fe7c6ad7cbc8237830e77376634b3731622eaf30d92e22a3886ff109279d9830dac727afb94a83ee6d8360cbdfa2cc0640"],
  ];
  try {
    const msg = randomBytes(77), key = randomBytes(32), iv = randomBytes(12), aad = randomBytes(9);
    const shaReal = new Uint8Array(await crypto.subtle.digest("SHA-256", msg));
    results.push(["SHA-256 matches Web Crypto", hx(shaReal) === hx(sha256(msg))]);
    const hk = await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    results.push(["HMAC matches Web Crypto", hx(new Uint8Array(await crypto.subtle.sign("HMAC", hk, msg))) === hx(hmacSha256(key, msg).mac)]);
    const gk = await crypto.subtle.importKey("raw", key, "AES-GCM", false, ["encrypt"]);
    const real = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: aad }, gk, msg));
    const mine = gcmEncrypt(key, iv, aad, msg);
    results.push(["AES-256-GCM matches Web Crypto", hx(real) === hx(concatBytes(mine.ct, mine.tag))]);
  } catch {
    results.push(["Web Crypto comparisons were skipped, as this browser blocks them here", true]);
  }
  $("tests").innerHTML = "";
  for (const [label, pass] of results) { const d2 = document.createElement("div"); d2.className = pass ? "pass" : "fail"; d2.textContent = label; $("tests").append(d2); }
}

$("toyK").max = toyN - 1;
$("toyOrder").textContent = toyN;
$("eN").textContent = toyN;
renderSha(); makeClaim(); renderHmac(); renderScrypt(); computeAes(); renderGcm(); renderToy(); renderEcdsa(); renderReal(); renderEip(); renderPs(); computeKeccak(); renderAbi(); renderMerkle();
runTests();
