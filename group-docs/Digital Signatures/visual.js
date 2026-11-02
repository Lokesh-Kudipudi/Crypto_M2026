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

// ---- Page
const $ = (id) => document.getElementById(id);
const verdict = (el, tone, text) => { el.innerHTML = ""; const d = document.createElement("div"); d.className = `verdict ${tone}`; d.textContent = text; el.append(d); };
const word = (n) => unhex(BigInt(n).toString(16).padStart(64, "0"));
const k256Text = (t) => keccak256(enc.encode(t));
const sigHex = ({ r, s, v }) => bigToHex32(r) + bigToHex32(s).slice(2) + v.toString(16).padStart(2, "0");

// 1. Toy curve
const TOY_P = 97n, SIZE = 360, PAD = 18, SCALE = (SIZE - 2 * PAD) / 96;
const toyPoints = [];
for (let x = 0n; x < TOY_P; x++) for (let y = 0n; y < TOY_P; y++) if (mod(y * y - x * x * x - 7n, TOY_P) === 0n) toyPoints.push([x, y]);
const toyOrder = (g) => { let n = 1, p = g; while ((p = pointAdd(p, g, TOY_P))) n++; return n + 1; };
const toyG = toyPoints.reduce((best, p) => (toyOrder(p) > toyOrder(best) ? p : best), toyPoints[0]);
const toyN = toyOrder(toyG);
const NS = "http://www.w3.org/2000/svg";
const px = (v) => PAD + Number(v) * SCALE;
const py = (v) => SIZE - PAD - Number(v) * SCALE;
function svgEl(name, attrs) { const e = document.createElementNS(NS, name); for (const a in attrs) e.setAttribute(a, attrs[a]); return e; }
function renderCurve() {
  const k = Number($("k").value), svg = $("curve");
  $("kVal").textContent = k;
  svg.innerHTML = "";
  for (const [x, y] of toyPoints) svg.append(svgEl("circle", { cx: px(x), cy: py(y), r: 3, fill: "#c6d2e6" }));
  const multiples = [];
  for (let i = 1; i < k; i++) multiples.push(pointMul(BigInt(i), toyG, TOY_P));
  for (let i = 0; i < multiples.length; i++) {
    const a = multiples[i], b = multiples[i + 1] ?? pointMul(BigInt(k), toyG, TOY_P);
    if (a && b && k <= 12) svg.append(svgEl("line", { x1: px(a[0]), y1: py(a[1]), x2: px(b[0]), y2: py(b[1]), stroke: "#9db6dc", "stroke-width": 1 }));
  }
  svg.append(svgEl("circle", { cx: px(toyG[0]), cy: py(toyG[1]), r: 6, fill: "#fff", stroke: "#2a5599", "stroke-width": 2 }));
  const label = svgEl("text", { x: px(toyG[0]) + 8, y: py(toyG[1]) - 8, "font-size": 12, fill: "#2a5599", "font-weight": 700 });
  label.textContent = "G";
  svg.append(label);
  const point = pointMul(BigInt(k), toyG, TOY_P);
  if (point) svg.append(svgEl("circle", { cx: px(point[0]), cy: py(point[1]), r: 7, fill: "#2a5599" }));
  $("kPoint").textContent = point ? `(${point[0]}, ${point[1]})` : "The point at infinity, the group's identity";
}
$("k").max = toyN;
$("k").oninput = renderCurve;

let demoKey;
function newKey() {
  demoKey = randomScalar();
  const pub = pointMul(demoKey);
  $("kPriv").textContent = bigToHex32(demoKey);
  $("kPub").textContent = `${bigToHex32(pub[0])}, ${bigToHex32(pub[1])}`;
  $("kAddr").textContent = addressOf(pub);
}
$("newKey").onclick = () => { newKey(); signMessage(); };

// 2. Sign and recover
let lastSig = null;
function signMessage() {
  const z = hex(keccak256(enc.encode($("sMsg").value)));
  const k = randomScalar();
  lastSig = ecdsaSign(z, demoKey, k);
  if (lastSig.s > N / 2n) { lastSig = { r: lastSig.r, s: N - lastSig.s, v: lastSig.v === 27 ? 28 : 27 }; }
  $("sZ").textContent = z;
  $("sK").textContent = bigToHex32(k);
  $("sR").textContent = bigToHex32(lastSig.r);
  $("sS").textContent = bigToHex32(lastSig.s);
  $("sCheck").value = $("sMsg").value;
  checkSignature();
}
function checkSignature() {
  const z = hex(keccak256(enc.encode($("sCheck").value)));
  const pub = ecdsaRecover(z, lastSig);
  const address = pub ? addressOf(pub) : "No valid point";
  $("sRec").textContent = address;
  if (address === addressOf(pointMul(demoKey))) verdict($("sVerdict"), "good", "Same address as the signer, so the message is authentic.");
  else verdict($("sVerdict"), "bad", "A different address: the message changed, or someone else signed it.");
}
$("sGo").onclick = signMessage;
$("sCheck").oninput = checkSignature;

// 3. EIP-712
const published = new Set();
const REGISTRY = hex(randomBytes(20)), OTHER_REGISTRY = hex(randomBytes(20));
const issuerKey = randomScalar(), strangerKey = randomScalar();
const issuerAddr = addressOf(pointMul(issuerKey)), strangerAddr = addressOf(pointMul(strangerKey));
const DOMAIN_TYPE = k256Text("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
const BATCH_TYPEHASH = k256Text("Batch(bytes32 root,uint32 count)");
let eRoot = hex(randomBytes(32)), eSignature = null, eSigned = null;
function digestFor(root, count, chainId, registry) {
  const domain = keccak256(concatBytes(DOMAIN_TYPE, k256Text("AcademicCertificates"), k256Text("1"), word(chainId), word(BigInt(registry))));
  const struct = keccak256(concatBytes(BATCH_TYPEHASH, unhex(root), word(count)));
  return { domain: hex(domain), struct: hex(struct), digest: hex(keccak256(concatBytes(Uint8Array.of(0x19, 0x01), domain, struct))) };
}
const lowS = (digest, key) => ecdsaSign(digest, key);
function renderDigest() {
  const d = digestFor(eRoot, $("eCount").value, $("eChain").value, REGISTRY);
  $("eDomain").textContent = d.domain;
  $("eStruct").textContent = d.struct;
  $("eDigest").textContent = d.digest;
}
$("eCount").oninput = $("eChain").oninput = renderDigest;
$("eSign").onclick = () => {
  if (published.has(eRoot)) { eRoot = hex(randomBytes(32)); $("eRoot").textContent = eRoot; renderDigest(); }
  const count = Number($("eCount").value), chainId = Number($("eChain").value);
  eSignature = lowS(digestFor(eRoot, count, chainId, REGISTRY).digest, issuerKey);
  eSigned = { root: eRoot, count, chainId };
  $("eSig").textContent = sigHex(eSignature);
  for (const id of ["aGood", "aPayer", "aCount", "aRoot", "aChain", "aContract"]) $(id).disabled = false;
  $("eVerdict").innerHTML = "";
  $("eDetail").hidden = true;
};
function publish(root, count, chainId, registry, sig, note) {
  const signer = addressOf(ecdsaRecover(digestFor(root, count, chainId, registry).digest, sig));
  $("eDetail").hidden = false;
  $("eRec").textContent = signer;
  if (signer !== issuerAddr) return verdict($("eVerdict"), "bad", `Reverted: "Signer is not an approved issuer". ${note}`);
  if (published.has(root)) return verdict($("eVerdict"), "bad", 'Reverted: "Batch already published". The registry accepts each root once.');
  published.add(root);
  verdict($("eVerdict"), "good", `Published, with Demo University recorded as issuer. ${note}`);
}
$("aGood").onclick = () => publish(eSigned.root, eSigned.count, eSigned.chainId, REGISTRY, eSignature, "");
$("aPayer").onclick = () => {
  const root = hex(randomBytes(32)), { count, chainId } = eSigned;
  publish(root, count, chainId, REGISTRY, lowS(digestFor(root, count, chainId, REGISTRY).digest, issuerKey), "The university signed a new batch, and a different account sent it. The signature decides the issuer, not the account paying gas.");
};
$("aCount").onclick = () => publish(eSigned.root, eSigned.count + 1, eSigned.chainId, REGISTRY, eSignature, "The count is part of the signed data, so the digest changed.");
$("aRoot").onclick = () => publish(hex(randomBytes(32)), eSigned.count, eSigned.chainId, REGISTRY, eSignature, "The root is part of the signed data.");
$("aChain").onclick = () => publish(eSigned.root, eSigned.count, 999, REGISTRY, eSignature, "The chain ID is part of the domain separator.");
$("aContract").onclick = () => publish(eSigned.root, eSigned.count, eSigned.chainId, OTHER_REGISTRY, eSignature, "The contract address is part of the domain separator.");
$("aStranger").onclick = () => {
  const root = hex(randomBytes(32)), count = Number($("eCount").value), chainId = Number($("eChain").value);
  publish(root, count, chainId, REGISTRY, lowS(digestFor(root, count, chainId, REGISTRY).digest, strangerKey), "The signature is valid, but this wallet isn't in the registry.");
};

// 4. Malleability
function renderMalleable() {
  const z = hex(keccak256(randomBytes(32)));
  const sig = ecdsaSign(z, issuerKey);
  const twin = { r: sig.r, s: N - sig.s, v: sig.v === 27 ? 28 : 27 };
  $("mRows").innerHTML = "";
  for (const [name, form] of [["Original (low s)", sig], ["Twin (high s)", twin]]) {
    const who = addressOf(ecdsaRecover(z, form)) === issuerAddr ? "The same signer" : "Someone else";
    const accepted = form.s <= N / 2n;
    const tr = document.createElement("tr");
    [name, short(bigToHex32(form.s), 10), who, accepted ? "Accepted" : "Rejected: invalid signature 's' value"].forEach((text, i) => {
      const td = document.createElement("td");
      td.textContent = text;
      if (i === 1) td.className = "mono";
      if (i === 3) td.style.cssText = `font-weight:600;color:var(--${accepted ? "good" : "bad"})`;
      tr.append(td);
    });
    $("mRows").append(tr);
  }
}
$("mGo").onclick = renderMalleable;

// 5. Wallet linking
const walletKey = randomScalar(), walletAddr = addressOf(pointMul(walletKey)), otherWalletKey = randomScalar();
const server = { nonce: null, wallet: null };
let lMessage = null, lSignature = null;
const walletMessage = (nonce) => `Link this wallet to your certificate account.\n\nThis costs nothing and sends no transaction.\n\nCode: ${nonce}`;
function personalDigest(message) {
  const bytes = enc.encode(message);
  return hex(keccak256(concatBytes(enc.encode(`\x19Ethereum Signed Message:\n${bytes.length}`), bytes)));
}
const renderServer = () => {
  $("lState").textContent = `wallet_nonce: ${server.nonce ? short(server.nonce, 8) : "NULL"}\nwallet: ${server.wallet ?? "NULL"}`;
};
const markSteps = (n) => [...$("lSteps").children].forEach((li, i) => li.classList.toggle("done", i < n));
$("lChallenge").onclick = () => {
  server.nonce = btoa(String.fromCharCode(...randomBytes(32))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  server.wallet = null;
  lMessage = walletMessage(server.nonce);
  lSignature = null;
  $("lMsg").textContent = lMessage;
  $("lSign").disabled = false;
  $("lSend").disabled = $("lReplay").disabled = $("lWrong").disabled = true;
  $("lVerdict").innerHTML = "";
  markSteps(1);
  renderServer();
};
$("lSign").onclick = () => {
  lSignature = ecdsaSign(personalDigest(lMessage), walletKey);
  $("lSend").disabled = $("lWrong").disabled = false;
  verdict($("lVerdict"), "info", `Signed by ${short(walletAddr, 6)}. No transaction was sent, and no gas was used.`);
  markSteps(2);
};
function serverLink(address, sig) {
  if (!server.nonce) return verdict($("lVerdict"), "bad", 'Rejected: "Start wallet linking again." The code was already used.');
  const signer = addressOf(ecdsaRecover(personalDigest(walletMessage(server.nonce)), sig));
  if (signer !== address) return verdict($("lVerdict"), "bad", `Rejected: "The signature doesn't match this wallet." It recovers to ${short(signer, 6)}.`);
  server.wallet = signer;
  server.nonce = null;
  renderServer();
  markSteps(3);
  $("lReplay").disabled = false;
  verdict($("lVerdict"), "good", "Linked. The code is cleared, so this signature can't be used again.");
}
$("lSend").onclick = () => serverLink(walletAddr, lSignature);
$("lReplay").onclick = () => serverLink(walletAddr, lSignature);
$("lWrong").onclick = () => serverLink(walletAddr, ecdsaSign(personalDigest(lMessage), otherWalletKey));

// 6. Nonce reuse
$("rGo").onclick = () => {
  const key = randomScalar(), k = randomScalar();
  const z1 = hex(keccak256(enc.encode("message one"))), z2 = hex(keccak256(enc.encode("message two")));
  const a = ecdsaSign(z1, key, k), b = ecdsaSign(z2, key, k);
  const kFound = mod((BigInt(z1) - BigInt(z2)) * inv(a.s - b.s, N), N);
  const found = mod((a.s * kFound - BigInt(z1)) * inv(a.r, N), N);
  $("rReal").textContent = bigToHex32(key);
  $("rFound").textContent = bigToHex32(found);
  verdict($("rVerdict"), found === key ? "bad" : "warn", found === key ? "The private key was recovered from two public signatures." : "The attack didn't match.");
};

$("eRoot").textContent = eRoot;
$("eIssuer").textContent = issuerAddr;
$("eStranger").textContent = strangerAddr;
newKey();
signMessage();
renderCurve();
renderDigest();
renderMalleable();
renderServer();
