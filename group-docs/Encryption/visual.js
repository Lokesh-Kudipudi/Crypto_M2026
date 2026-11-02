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

// ---- Page
const $ = (id) => document.getElementById(id);
const AAD = enc.encode("academic-certificate-pdf-v1");
const IV_BYTES = 12;
const dec = new TextDecoder();
const verdict = (el, tone, text) => { el.innerHTML = ""; const d = document.createElement("div"); d.className = `verdict ${tone}`; d.textContent = text; el.append(d); };
const importGcm = (key) => crypto.subtle.importKey("raw", key, "AES-GCM", false, ["encrypt", "decrypt"]);
const b64 = (b) => btoa(String.fromCharCode(...b));

async function encryptPdf(bytes, key, iv = randomBytes(IV_BYTES)) {
  const body = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: AAD }, await importGcm(key), bytes));
  return concatBytes(iv, body);
}
async function decryptPdf(ciphertext, key, aad = AAD) {
  return new Uint8Array(await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: ciphertext.slice(0, IV_BYTES), additionalData: aad }, await importGcm(key), ciphertext.slice(IV_BYTES)));
}

// 1. Encrypt and tamper
let key, sealedFile, original;
function renderBytes() {
  const el = $("bytes");
  el.innerHTML = "";
  sealedFile.forEach((byte, i) => {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = byte.toString(16).padStart(2, "0");
    b.className = i < IV_BYTES ? "b-iv" : i >= sealedFile.length - 16 ? "b-tag" : "b-ct";
    if (byte !== original[i]) b.classList.add("flipped");
    b.setAttribute("aria-label", `Byte ${i}, ${b.className.split(" ")[0] === "b-iv" ? "IV" : b.className.startsWith("b-tag") ? "tag" : "ciphertext"}`);
    b.onclick = () => { sealedFile[i] ^= 1; renderBytes(); tryDecrypt(); };
    el.append(b);
  });
}
async function tryDecrypt(useKey = key, aad = AAD, label = "") {
  try {
    const out = await decryptPdf(sealedFile, useKey, aad);
    $("decOut").textContent = dec.decode(out);
    verdict($("decVerdict"), "good", "Decrypted: the tag is valid.");
  } catch {
    $("decOut").textContent = "Nothing. GCM returns no output when the check fails.";
    const changed = sealedFile.some((b, i) => b !== original[i]);
    verdict($("decVerdict"), "bad", label || (changed ? "Rejected: a changed byte makes the tag check fail." : "Rejected."));
  }
}
async function encryptNow() {
  key = randomBytes(32);
  sealedFile = await encryptPdf(enc.encode($("plain").value), key);
  original = sealedFile.slice();
  $("keyOut").textContent = hex(key);
  renderBytes();
  await tryDecrypt();
  await renderCtr();
}
$("encGo").onclick = encryptNow;
$("restore").onclick = () => { sealedFile = original.slice(); renderBytes(); tryDecrypt(); };
$("wrongKey").onclick = () => tryDecrypt(randomBytes(32), AAD, "Rejected: a wrong key can't produce a valid tag.");
$("wrongAad").onclick = () => tryDecrypt(key, enc.encode("some-other-format"), "Rejected: the AAD is part of the tag, even though it isn't encrypted.");

// 2. Rebuild the ciphertext from AES-CTR, starting at counter 2 as GCM does
async function renderCtr() {
  const plain = enc.encode($("plain").value);
  const iv = original.slice(0, IV_BYTES);
  const ct = original.slice(IV_BYTES, original.length - 16);
  const counter = concatBytes(iv, Uint8Array.of(0, 0, 0, 2));
  const ctrKey = await crypto.subtle.importKey("raw", key, "AES-CTR", false, ["encrypt"]);
  const keystream = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-CTR", counter, length: 32 }, ctrKey, new Uint8Array(plain.length)));
  const rebuilt = keystream.map((b, i) => b ^ plain[i]);
  $("ctrRows").innerHTML = "";
  const blocks = Math.min(Math.ceil(plain.length / 16), 6);
  for (let i = 0; i < blocks; i++) {
    const range = [i * 16, (i + 1) * 16];
    const cells = [String(i + 1), `IV + ${i + 2}`, hex(keystream.slice(...range)).slice(2), hex(plain.slice(...range)).slice(2), hex(rebuilt.slice(...range)).slice(2)];
    const tr = document.createElement("tr");
    for (const text of cells) { const td = document.createElement("td"); td.textContent = text; tr.append(td); }
    $("ctrRows").append(tr);
  }
  const same = hex(rebuilt) === hex(ct);
  verdict($("ctrVerdict"), same ? "good" : "bad", same ? "This matches the GCM ciphertext from section 1, byte for byte." : "This doesn't match the GCM ciphertext.");
}

// 3. ECB picture
function drawCertificate(ctx, w, h) {
  ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, w, h);
  ctx.strokeStyle = "#000"; ctx.lineWidth = 4; ctx.strokeRect(5, 5, w - 10, h - 10);
  ctx.fillStyle = "#000"; ctx.font = "bold 36px Arial"; ctx.textAlign = "center"; ctx.fillText("A+", w / 2, 50);
  ctx.fillStyle = "#777"; ctx.fillRect(20, 62, w - 40, 8); ctx.fillRect(20, 78, w - 56, 8);
  ctx.fillStyle = "#000"; ctx.beginPath(); ctx.arc(w - 32, 96, 12, 0, 7); ctx.fill();
}
const toGrey = (img) => { const g = new Uint8Array(img.width * img.height); for (let i = 0; i < g.length; i++) g[i] = img.data[i * 4] < 64 ? 0 : img.data[i * 4] < 200 ? 120 : 255; return g; };
function paint(canvas, grey, w, h) {
  const ctx = canvas.getContext("2d");
  const out = ctx.createImageData(w, h);
  for (let i = 0; i < grey.length; i++) { out.data.set([grey[i], grey[i], grey[i], 255], i * 4); }
  ctx.putImageData(out, 0, 0);
}
async function renderImages() {
  const canvas = $("imgPlain"), w = canvas.width, h = canvas.height, ctx = canvas.getContext("2d");
  drawCertificate(ctx, w, h);
  const grey = toGrey(ctx.getImageData(0, 0, w, h));
  paint(canvas, grey, w, h);
  // ECB isn't in Web Crypto. CBC with a zero IV on a single block is the same as one raw AES block.
  const S = 4;
  const toBlocks = () => {
    const blocks = [];
    for (let by = 0; by + S <= h; by += S) for (let bx = 0; bx + S <= w; bx += S) {
      const block = new Uint8Array(16);
      for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) block[y * S + x] = grey[(by + y) * w + bx + x];
      blocks.push({ bx, by, block });
    }
    return blocks;
  };
  const fillBlock = (out, bx, by, shade) => { for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) out[(by + y) * w + bx + x] = shade; };
  const blocks = toBlocks();
  const white = new Uint8Array(16).fill(255), black = new Uint8Array(16);
  let cbc, imgKey;
  const rawAes = async (block) => new Uint8Array(await crypto.subtle.encrypt({ name: "AES-CBC", iv: new Uint8Array(16) }, cbc, block)).slice(0, 16);
  // Choose a key whose flat blocks get clearly different shades, so the leak is easy to see
  do {
    imgKey = randomBytes(32);
    cbc = await crypto.subtle.importKey("raw", imgKey, "AES-CBC", false, ["encrypt"]);
  } while (Math.abs((await rawAes(white))[0] - (await rawAes(black))[0]) < 110);
  const cache = new Map(), ecb = new Uint8Array(grey.length);
  for (const { bx, by, block } of blocks) {
    const id = block.join();
    if (!cache.has(id)) cache.set(id, await rawAes(block));
    fillBlock(ecb, bx, by, cache.get(id)[0]);
  }
  paint($("imgEcb"), ecb, w, h);
  const ordered = concatBytes(...blocks.map((b) => b.block));
  const sealedImage = (await encryptPdf(ordered, imgKey)).slice(IV_BYTES);
  const gcm = new Uint8Array(grey.length);
  blocks.forEach(({ bx, by }, i) => fillBlock(gcm, bx, by, sealedImage[i * 16]));
  paint($("imgGcm"), gcm, w, h);
}

// 4. IV reuse
$("nGo").onclick = async () => {
  const p1 = enc.encode($("n1").value), p2 = enc.encode($("n2").value);
  const n = Math.min(p1.length, p2.length);
  const k = randomBytes(32), iv = randomBytes(IV_BYTES);
  const c1 = (await encryptPdf(p1, k, iv)).slice(IV_BYTES), c2 = (await encryptPdf(p2, k, iv)).slice(IV_BYTES);
  const x = new Uint8Array(n).map((_, i) => c1[i] ^ c2[i]);
  $("nXor").textContent = hex(x);
  const recovered = dec.decode(x.map((b, i) => b ^ p2[i]));
  verdict($("nVerdict"), "bad", `Attacker recovers message 1 without the key: "${recovered}"`);
};

// 5. Sealing
async function seal(k, text) {
  const iv = randomBytes(12);
  const out = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await importGcm(k), enc.encode(text)));
  const body = out.slice(0, -16), tag = out.slice(-16);
  return [iv, tag, body].map(b64).join(".");
}
const sealKey = randomBytes(32);
$("sealGo").onclick = async () => {
  $("seal1").textContent = await seal(sealKey, $("sealIn").value);
  $("seal2").textContent = await seal(sealKey, $("sealIn").value);
};

// 6. Who can read what
const DATA = ["Encrypted PDF on IPFS", "A student's credential (PDF key and salts)", "Dashboard data (names, courses, CGPA)"];
const PARTIES = {
  "Anyone on the IPFS network": [
    ["no", "They can fetch the ciphertext if they know the CID, but they have no key."],
    ["no", "Credentials aren't on IPFS."],
    ["no", "Dashboard data isn't on IPFS."]],
  "Someone who copied only the database file": [
    ["no", "PDF keys are inside sealed credentials."],
    ["no", "Sealed with AES-256-GCM, and secret.key is a separate file."],
    ["leak", "These columns are plain text for the issuer's dashboard."]],
  "Someone who copied the database and secret.key": [
    ["leak", "They can unseal the PDF key, and the CID tells them what to fetch."],
    ["leak", "They hold the sealing key."],
    ["leak", "These columns are plain text."]],
  "A compromised running server": [
    ["leak", "It can unseal any credential, then fetch and decrypt the PDF."],
    ["leak", "It has the key in memory."],
    ["leak", "It reads the database directly."]],
  "The student": [
    ["yes", "Their credential holds the key to their own PDF only."],
    ["yes", "Only their own, after claiming it."],
    ["no", "Students don't get the issuer's dashboard."]],
  "A verifier given a share link": [
    ["no", "Only if the student chose to include the PDF. Then they get that one key."],
    ["no", "They get only the disclosed fields, salts and proofs."],
    ["no", "They see only what was disclosed."]],
};
for (const name of Object.keys(PARTIES)) { const o = document.createElement("option"); o.textContent = name; $("party").append(o); }
function renderParty() {
  $("partyRows").innerHTML = "";
  PARTIES[$("party").value].forEach(([state, why], i) => {
    const tr = document.createElement("tr");
    const words = { yes: "Yes", no: "No", leak: "Yes (exposed)" };
    [DATA[i], words[state], why].forEach((text, c) => {
      const td = document.createElement("td");
      td.textContent = text;
      if (c === 1) td.className = state;
      tr.append(td);
    });
    $("partyRows").append(tr);
  });
}
$("party").onchange = renderParty;

(async function start() {
  await encryptNow();
  await renderImages();
  $("sealGo").click();
  $("nGo").click();
  renderParty();
})().catch((e) => {
  document.querySelector("main").insertAdjacentHTML("afterbegin", '<div class="verdict bad">This browser blocked the Web Crypto API. Open the page in a current Chrome, Edge, Firefox or Safari.</div>');
  console.error(e);
});
