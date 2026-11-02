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
// scrypt written out, because browsers don't provide it. Node's crypto.scrypt gives the same result.
async function pbkdf2(password, salt, length) {
  const key = await crypto.subtle.importKey("raw", password, "PBKDF2", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: "PBKDF2", salt, iterations: 1, hash: "SHA-256" }, key, length * 8));
}
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
async function scrypt(password, salt, { N: cost, r, p, dkLen }) {
  const blockWords = 32 * r;
  const initial = await pbkdf2(password, salt, p * 128 * r);
  const words = new Uint32Array(initial.buffer.slice(0));
  const V = new Uint32Array(cost * blockWords);
  const Y = new Uint32Array(blockWords);
  for (let i = 0; i < p; i++) {
    const X = words.subarray(i * blockWords, (i + 1) * blockWords);
    for (let n = 0; n < cost; n++) { V.set(X, n * blockWords); blockMix(X, Y, r); }
    for (let n = 0; n < cost; n++) {
      const j = X[(2 * r - 1) * 16] & (cost - 1);
      for (let w = 0; w < blockWords; w++) X[w] ^= V[j * blockWords + w];
      blockMix(X, Y, r);
    }
  }
  return pbkdf2(password, new Uint8Array(words.buffer), dkLen);
}

// ---- Page
const $ = (id) => document.getElementById(id);
const sha256 = async (bytes) => new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
const verdict = (el, tone, text) => { el.innerHTML = ""; const d = document.createElement("div"); d.className = `verdict ${tone}`; d.textContent = text; el.append(d); };
const duration = (seconds) => {
  if (seconds < 1) return `${(seconds * 1000).toFixed(seconds < 0.01 ? 3 : 0)} ms`;
  const units = [["year", 31557600], ["day", 86400], ["hour", 3600], ["minute", 60], ["second", 1]];
  const [name, size] = units.find(([, s]) => seconds >= s);
  const n = seconds / size;
  return `about ${n >= 100 ? Math.round(n).toLocaleString() : n.toFixed(1)} ${name}s`;
};

// 1. Avalanche
const bitsEl = $("bits");
for (let i = 0; i < 256; i++) bitsEl.append(document.createElement("i"));
async function renderAvalanche() {
  const [a, b] = await Promise.all([sha256(enc.encode($("a1").value)), sha256(enc.encode($("a2").value))]);
  $("h1").textContent = hex(a);
  $("h2").textContent = hex(b);
  let diff = 0;
  for (let i = 0; i < 256; i++) {
    const mask = 0x80 >> (i % 8);
    const differs = ((a[i >> 3] ^ b[i >> 3]) & mask) !== 0;
    bitsEl.children[i].classList.toggle("diff", differs);
    if (differs) diff++;
  }
  $("diffCount").textContent = `${diff} of 256 (${Math.round((diff / 256) * 100)}%)`;
}
$("a1").addEventListener("input", renderAvalanche);
$("a2").addEventListener("input", renderAvalanche);

// 2. PDF
const sampleFile = () => enc.encode("%PDF-1.4 Demo University certifies that Sample Student completed B.Tech Computer Science.");
let pdfBytes = sampleFile(), pdfOriginal = pdfBytes.slice(), pdfSigned = null, pdfName = "sample certificate";
async function renderPdf() {
  const now = hex(await sha256(pdfBytes));
  $("pdfNow").textContent = now;
  $("pdfSigned").textContent = pdfSigned || "Not recorded yet";
  $("pdfInfo").textContent = `File: ${pdfName}, ${pdfBytes.length.toLocaleString()} bytes`;
  if (!pdfSigned) return verdict($("pdfVerdict"), "info", "Record the hash to start.");
  if (now === pdfSigned) verdict($("pdfVerdict"), "good", "Match: the PDF matches the signed hash.");
  else verdict($("pdfVerdict"), "bad", "Tampered: the PDF does not match the signed hash.");
}
$("pdfSign").onclick = async () => { pdfSigned = hex(await sha256(pdfBytes)); renderPdf(); };
$("pdfTamper").onclick = () => { pdfBytes = pdfBytes.slice(); pdfBytes[Math.floor(pdfBytes.length / 2)] ^= 1; renderPdf(); };
$("pdfReset").onclick = () => { pdfBytes = pdfOriginal.slice(); renderPdf(); };
$("pdfFile").onchange = async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  pdfBytes = new Uint8Array(await file.arrayBuffer());
  pdfOriginal = pdfBytes.slice();
  pdfName = file.name;
  pdfSigned = null;
  renderPdf();
};

// 3. Tokens
const base64url = (b) => btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
let tokReal = null, tokDb = null;
const serverLookup = async (cookie) => hex(await sha256(enc.encode(cookie))).slice(2) === tokDb;
$("tokNew").onclick = async () => {
  tokReal = base64url(randomBytes(32));
  tokDb = hex(await sha256(enc.encode(tokReal))).slice(2);
  $("tokReal").textContent = tokReal;
  $("tokDb").textContent = tokDb;
  $("tokStolen").disabled = $("tokGood").disabled = false;
  $("tokVerdict").innerHTML = "";
};
$("tokStolen").onclick = async () => {
  const ok = await serverLookup(tokDb);
  verdict($("tokVerdict"), ok ? "bad" : "good", ok ? "Logged in." : "Rejected: the server hashes the cookie first, and the hash of a hash matches no row.");
};
$("tokGood").onclick = async () => {
  const ok = await serverLookup(tokReal);
  verdict($("tokVerdict"), ok ? "good" : "bad", ok ? "Accepted: the hash of the real token matches the row." : "Rejected.");
};

// 4. Fast-hash attack
const WORDS = ["password", "123456", "qwerty", "iloveyou", "admin", "welcome", "monkey", "dragon", "letmein", "sunshine", "football", "shadow", "master", "princess", "superman", "trustno1"];
const SUFFIXES = ["", "1", "12", "123", "1234", "!", "2020", "2021", "2022", "2023", "2024", "2025", "2026"];
let shaGuessSeconds = null, scryptGuessSeconds = null;
const renderFastHash = async () => { $("fastHash").textContent = hex(await sha256(enc.encode($("fastPw").value))); };
$("fastPw").addEventListener("input", renderFastHash);
$("fastGo").onclick = async () => {
  const target = $("fastHash").textContent;
  const start = performance.now();
  let tried = 0, found = null;
  outer: for (const w of WORDS) for (const s of SUFFIXES) {
    tried++;
    if (hex(await sha256(enc.encode(w + s))) === target) { found = w + s; break outer; }
  }
  const seconds = (performance.now() - start) / 1000;
  shaGuessSeconds = seconds / tried;
  if (found) verdict($("fastVerdict"), "bad", `Cracked "${found}" after ${tried} guesses in ${duration(seconds)}.`);
  else verdict($("fastVerdict"), "warn", `Not in this short list of ${tried} guesses, but a real attacker's list has billions of entries.`);
  renderBudget();
};
async function renderSaltRows() {
  const pw = "dragon2024";
  $("saltRows").innerHTML = "";
  for (const user of ["Aisha", "Ben"]) {
    const salt = randomBytes(16);
    const plain = hex(await sha256(enc.encode(pw)));
    const salted = hex(await sha256(concatBytes(salt, enc.encode(pw))));
    const tr = document.createElement("tr");
    for (const text of [user, short(plain), short(salted)]) {
      const td = document.createElement("td");
      td.textContent = text;
      if (text !== user) td.className = "mono";
      tr.append(td);
    }
    $("saltRows").append(tr);
  }
}

// 5. scrypt
const memCells = [];
for (let i = 0; i < 64; i++) { const c = document.createElement("i"); $("memory").append(c); memCells.push(c); }
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
async function animateMemory() {
  memCells.forEach((c) => (c.className = ""));
  if (reduced) { memCells.forEach((c) => (c.className = "w")); $("memPhase").textContent = "Fill every block, then read them in an unpredictable order."; return; }
  $("memPhase").textContent = "Phase 1: fill memory. Each block depends on the one before.";
  for (const c of memCells) { c.className = "w"; await wait(14); }
  $("memPhase").textContent = "Phase 2: read blocks at positions that depend on the data, so they can't be skipped.";
  for (let i = 0; i < 40; i++) {
    const c = memCells[randomBytes(1)[0] % 64];
    c.className = "r";
    await wait(40);
    c.className = "w";
  }
  $("memPhase").textContent = "Done. Skipping the memory means recomputing blocks, which costs far more time.";
}
const b64 = (b) => btoa(String.fromCharCode(...b));
$("scGo").onclick = async () => {
  $("scGo").disabled = true;
  $("scStat").textContent = "Computing…";
  const animation = animateMemory();
  await wait(30);
  const salt = randomBytes(16);
  const start = performance.now();
  const out = await scrypt(enc.encode($("scPw").value), salt, { N: 2 ** 15, r: 8, p: 1, dkLen: 64 });
  scryptGuessSeconds = (performance.now() - start) / 1000;
  $("scOut").textContent = `scrypt$${b64(salt)}$${b64(out)}`;
  $("scStat").textContent = `One hash took ${duration(scryptGuessSeconds)} and needed 32 MiB of memory on this device.`;
  renderBudget();
  await animation;
  $("scGo").disabled = false;
};
async function measureSha() {
  const start = performance.now();
  for (let i = 0; i < 400; i++) await sha256(enc.encode("guess" + i));
  shaGuessSeconds = (performance.now() - start) / 1000 / 400;
}
function renderBudget() {
  const guesses = Number($("space").value);
  const rows = [["SHA-256", shaGuessSeconds], ["scrypt (project settings)", scryptGuessSeconds]];
  $("budget").innerHTML = "";
  for (const [name, seconds] of rows) {
    const tr = document.createElement("tr");
    const cells = seconds ? [name, duration(seconds), duration(seconds * guesses)] : [name, "Press “Hash with scrypt”", "Not measured yet"];
    for (const text of cells) { const td = document.createElement("td"); td.textContent = text; tr.append(td); }
    $("budget").append(tr);
  }
}
$("space").onchange = renderBudget;

(async function start() {
  await Promise.all([renderAvalanche(), renderPdf(), renderFastHash(), renderSaltRows()]);
  await measureSha();
  renderBudget();
})().catch((e) => {
  document.querySelector("main").insertAdjacentHTML("afterbegin", '<div class="verdict bad">This browser blocked the Web Crypto API. Open the page in a current Chrome, Edge, Firefox or Safari.</div>');
  console.error(e);
});
