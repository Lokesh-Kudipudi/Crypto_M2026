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

// ---- Page
const $ = (id) => document.getElementById(id);
const verdict = (el, tone, text) => { el.innerHTML = ""; const d = document.createElement("div"); d.className = `verdict ${tone}`; d.textContent = text; el.append(d); };
const NS = "http://www.w3.org/2000/svg";
function svgEl(name, attrs, text) { const e = document.createElementNS(NS, name); for (const a in attrs) e.setAttribute(a, attrs[a]); if (text !== undefined) e.textContent = text; return e; }
const randomHex = (n) => hex(randomBytes(n));

// 1. Salted commitments
const plainCommit = (value) => hex(keccak256(enc.encode("cgpa" + value)));
let cgpaSalt = randomHex(32);
function renderSalt() {
  $("plainHash").textContent = plainCommit($("cgpa").value);
  $("saltHash").textContent = fieldLeaf("cgpa", $("cgpa").value, cgpaSalt);
  $("plainVerdict").innerHTML = $("saltVerdict").innerHTML = "";
}
$("cgpa").oninput = renderSalt;
$("saltGo").onclick = () => {
  const target = $("plainHash").textContent, salted = $("saltHash").textContent;
  const start = performance.now();
  let found = null, tried = 0;
  for (let i = 0; i <= 1000; i++) {
    const guess = (i / 100).toFixed(2);
    tried++;
    if (plainCommit(guess) === target) { found = guess; break; }
  }
  const ms = (performance.now() - start).toFixed(0);
  if (found) verdict($("plainVerdict"), "bad", `Cracked: CGPA is ${found}, after ${tried} guesses in ${ms} ms.`);
  else verdict($("plainVerdict"), "warn", `Not found in 0.00 to 10.00, but only because this value isn't in that range.`);
  const wrongSalt = randomHex(32);
  let hit = false;
  for (let i = 0; i <= 1000; i++) if (fieldLeaf("cgpa", (i / 100).toFixed(2), wrongSalt) === salted) hit = true;
  verdict($("saltVerdict"), hit ? "bad" : "good", "Safe: all 1,001 values fail, because the attacker would also need to guess 2^256 possible salts.");
};

// 2. Certificate tree
const VALUES = {
  certificateId: "CERT-2026-0042", uid: "U-1042", candidateName: "Sample Student", courseName: "B.Tech Computer Science",
  organizationName: "Demo University", cgpa: "8.72", completionYear: "2026",
  pdfSha256: "0x9f2c41e07ab3d58c6612fe00c7d14ba9e3307c8b52d6f1a4bd90ce7713a8f210", pdfCid: "bafybeifictionalcidforthisdemoonly",
};
const CERT_FIELDS = Object.keys(VALUES);
const fields = Object.fromEntries(CERT_FIELDS.map((n) => [n, { value: VALUES[n], salt: randomHex(32) }]));
const leaves = CERT_FIELDS.map((n) => fieldLeaf(n, fields[n].value, fields[n].salt));
const levels = treeLevels(leaves);
const certRoot = levels[levels.length - 1][0];
const chosen = new Set(["courseName", "organizationName"]);
const edits = {};
const STYLE = {
  revealed: ["#cdeedd", "#16794c"], proof: ["#dce7f7", "#2a5599"], computed: ["#fbe7c6", "#8a5a00"], hidden: ["#f1f3f6", "#d5dbe5"],
};

/** Position every node. A promoted node sits directly above its only child. */
function layout(allLevels, width, levelGap, top) {
  const n = allLevels[0].length, pos = [];
  const pad = 52, step = n > 1 ? (width - pad * 2) / (n - 1) : 0;
  pos.push(allLevels[0].map((_, i) => (n > 1 ? pad + step * i : width / 2)));
  for (let l = 1; l < allLevels.length; l++) {
    pos.push(allLevels[l].map((_, i) => {
      const a = pos[l - 1][i * 2], b = pos[l - 1][i * 2 + 1];
      return b === undefined ? a : (a + b) / 2;
    }));
  }
  const y = (l) => top + (allLevels.length - 1 - l) * levelGap;
  return { pos, y };
}

/** For each selected leaf, mark its path as recomputed and its siblings as supplied by the proof. */
function classify(allLevels, selected) {
  const state = allLevels.map((lvl) => lvl.map(() => "hidden"));
  const proofNodes = [];
  for (const start of selected) {
    let index = start;
    state[0][start] = "revealed";
    for (let l = 0; l < allLevels.length - 1; l++) {
      const sib = index ^ 1;
      if (sib < allLevels[l].length) proofNodes.push([l, sib]);
      index >>= 1;
      state[l + 1][index] = "computed";
    }
  }
  for (const [l, i] of proofNodes) if (state[l][i] === "hidden") state[l][i] = "proof";
  return state;
}

function drawTree(svg, allLevels, selected, { labels, width = 900, levelGap = 58, boxW = 62 }) {
  const top = 26, boxH = 24, height = top + (allLevels.length - 1) * levelGap + boxH + (labels ? 34 : 14);
  svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
  svg.innerHTML = "";
  const { pos, y } = layout(allLevels, width, levelGap, top);
  const state = classify(allLevels, selected);
  for (let l = 1; l < allLevels.length; l++) allLevels[l].forEach((_, i) => {
    for (const c of [i * 2, i * 2 + 1]) if (pos[l - 1][c] !== undefined) {
      svg.append(svgEl("line", { x1: pos[l][i], y1: y(l) + boxH, x2: pos[l - 1][c], y2: y(l - 1), stroke: "#b8c3d4", "stroke-width": 1.2 }));
    }
  });
  allLevels.forEach((lvl, l) => lvl.forEach((h, i) => {
    const isRoot = l === allLevels.length - 1;
    const [fill, stroke] = STYLE[state[l][i]];
    svg.append(svgEl("rect", { x: pos[l][i] - boxW / 2, y: y(l), width: boxW, height: boxH, rx: 4, fill, stroke, "stroke-width": isRoot ? 2 : 1.2 }));
    svg.append(svgEl("text", { x: pos[l][i], y: y(l) + 16, "text-anchor": "middle", class: "hex" }, h.slice(0, 8)));
    if (isRoot) svg.append(svgEl("text", { x: pos[l][i], y: y(l) - 7, "text-anchor": "middle", "font-weight": 700 }, labels ? "Certificate root" : "Batch root (on-chain)"));
    if (l === 0 && labels) svg.append(svgEl("text", { x: pos[l][i], y: y(l) + boxH + 15, "text-anchor": "middle" }, labels[i]));
  }));
}

function renderCertTree() {
  const selected = CERT_FIELDS.map((n, i) => (chosen.has(n) ? i : -1)).filter((i) => i >= 0);
  drawTree($("certTree"), levels, selected, { labels: CERT_FIELDS });
  $("certRoot").textContent = certRoot;
  const body = $("checkRows");
  body.innerHTML = "";
  let allGood = selected.length > 0;
  for (const i of selected) {
    const name = CERT_FIELDS[i];
    const value = edits[name] ?? fields[name].value;
    const proof = merkleProof(leaves, i);
    const recomputed = proof.reduce(hashNode, fieldLeaf(name, value, fields[name].salt));
    const good = recomputed === certRoot;
    if (!good) allGood = false;
    const tr = document.createElement("tr");
    const cells = [name, null, short(fields[name].salt, 4), String(proof.length), short(recomputed, 4), good ? "Match" : "Mismatch"];
    cells.forEach((text, c) => {
      const td = document.createElement("td");
      if (c === 1) {
        const inp = document.createElement("input");
        inp.type = "text";
        inp.value = value;
        inp.setAttribute("aria-label", `Value of ${name}`);
        inp.onchange = () => { edits[name] = inp.value; renderCertTree(); };
        td.append(inp);
      } else td.textContent = text;
      if (c === 2 || c === 4) td.className = "mono";
      if (c === 5) td.style.cssText = `font-weight:600;color:var(--${good ? "good" : "bad"})`;
      tr.append(td);
    });
    body.append(tr);
  }
  if (!selected.length) verdict($("treeVerdict"), "warn", "Choose at least one field to disclose. The app requires this too.");
  else if (allGood) verdict($("treeVerdict"), "good", `Every revealed field matches the root. ${selected.length} of 9 fields are revealed.`);
  else verdict($("treeVerdict"), "bad", "Tampered: a changed value gives a different root. The real result would be TAMPERED.");
  const hiddenCount = 9 - selected.length;
  $("hiddenNote").textContent = hiddenCount
    ? `There are ${hiddenCount} hidden fields. The verifier sees only hashes from the proofs, and can't recover the values without their salts.`
    : "Nothing is hidden, as every field was revealed.";
  $("presentation").textContent = JSON.stringify({
    version: 1, chainId: 1337, registry: "0x…", batchRoot: "0x…", count: 4, signature: "0x…", certRoot,
    batchProof: ["0x…"],
    disclosed: selected.map((i) => ({ name: CERT_FIELDS[i], value: edits[CERT_FIELDS[i]] ?? fields[CERT_FIELDS[i]].value, salt: fields[CERT_FIELDS[i]].salt, proof: merkleProof(leaves, i) })),
  }, null, 2);
}
CERT_FIELDS.forEach((name) => {
  const label = document.createElement("label");
  const box = document.createElement("input");
  box.type = "checkbox";
  box.checked = chosen.has(name);
  box.onchange = () => { box.checked ? chosen.add(name) : chosen.delete(name); renderCertTree(); };
  const b = document.createElement("b");
  b.textContent = name;
  const val = document.createElement("span");
  val.className = "val";
  val.textContent = VALUES[name].length > 34 ? short(VALUES[name], 8) : VALUES[name];
  const wrap = document.createElement("span");
  wrap.append(b, " ", val);
  label.append(box, wrap);
  $("fieldPicks").append(label);
});

// 3. Batches
let certRoots = Array.from({ length: 16 }, () => randomHex(32));
function renderBatch() {
  const n = Number($("batchN").value);
  $("batchI").max = n;
  if (Number($("batchI").value) > n) $("batchI").value = n;
  const pick = Number($("batchI").value) - 1;
  $("batchNVal").textContent = n;
  $("batchIVal").textContent = `#${pick + 1}`;
  const batchLeaves = certRoots.slice(0, n).map(batchLeaf);
  const lv = treeLevels(batchLeaves);
  drawTree($("batchTree"), lv, [pick], { labels: null, boxW: n > 10 ? 44 : 62, levelGap: 50 });
  const proof = merkleProof(batchLeaves, pick);
  const good = verifyProof(lv[lv.length - 1][0], batchLeaves[pick], proof);
  $("batchNote").textContent = `Student #${pick + 1} needs ${proof.length} hash${proof.length === 1 ? "" : "es"} to prove membership in a batch of ${n}. Check: ${good ? "the proof matches the root." : "the proof failed."}`;
}
$("batchN").oninput = renderBatch;
$("batchI").oninput = renderBatch;
const fmt = (n) => n.toLocaleString("en-US");
[1, 10, 100, 1000, 10000].forEach((n) => {
  const original = 237508 * n, improved = 57074;
  const saved = ((1 - improved / original) * 100);
  const tr = document.createElement("tr");
  [fmt(n), fmt(original), fmt(improved), `${saved.toFixed(saved > 99.99 ? 3 : saved > 99.9 ? 2 : 1)}%`, String(n === 1 ? 0 : Math.ceil(Math.log2(n)))].forEach((text) => {
    const td = document.createElement("td");
    td.textContent = text;
    tr.append(td);
  });
  $("growth").append(tr);
});

// 4. Second preimage
let prefixMode = true;
const keccakHex = (b) => hex(keccak256(b));
const sorted = (a, b) => (BigInt(a) < BigInt(b) ? [a, b] : [b, a]);
const nakedNode = (a, b) => { const [l, h] = sorted(a, b); return keccakHex(concatBytes(unhex(l), unhex(h))); };
const certsForAttack = Array.from({ length: 4 }, () => randomHex(32));
function setPrefix(on) {
  prefixMode = on;
  $("withPrefix").setAttribute("aria-pressed", String(on));
  $("noPrefix").setAttribute("aria-pressed", String(!on));
  renderPrefix(false);
}
function renderPrefix(attack) {
  const leafFn = prefixMode ? batchLeaf : (c) => keccakHex(unhex(c));
  const nodeFn = prefixMode ? hashNode : nakedNode;
  const lv = certsForAttack.map(leafFn);
  const inner = nodeFn(lv[0], lv[1]), sibling = nodeFn(lv[2], lv[3]);
  const root = nodeFn(inner, sibling);
  const [low, high] = sorted(lv[0], lv[1]);
  const fake = low + high.slice(2);
  $("pRoot").textContent = root;
  $("pFake").textContent = fake;
  if (!attack) { $("pVerdict").innerHTML = ""; return; }
  const accepted = nodeFn(leafFn(fake), sibling) === root;
  if (accepted) verdict($("pVerdict"), "bad", "Accepted: a value that was never issued passes as a certificate.");
  else verdict($("pVerdict"), "good", "Rejected: the fake is hashed as a leaf with 0x02, while the real inner node used 0x01, so the hashes differ.");
}
$("withPrefix").onclick = () => setPrefix(true);
$("noPrefix").onclick = () => setPrefix(false);
$("attackGo").onclick = () => renderPrefix(true);

// 5. Odd nodes
function duplicateRoot(list) {
  let level = list;
  while (level.length > 1) {
    const next = [];
    for (let i = 0; i < level.length; i += 2) next.push(hashNode(level[i], level[i + 1] ?? level[i]));
    level = next;
  }
  return level[0];
}
(function renderOdd() {
  const [a, b, c] = ["A", "B", "C"].map((x) => keccakHex(enc.encode(x)));
  const rules = [["Duplicate the odd node", duplicateRoot], ["Promote it (this project)", merkleRoot]];
  for (const [name, fn] of rules) {
    const r3 = fn([a, b, c]), r4 = fn([a, b, c, c]), same = r3 === r4;
    const tr = document.createElement("tr");
    [name, short(r3, 8), short(r4, 8), same ? "Yes: unsafe" : "No: safe"].forEach((text, i) => {
      const td = document.createElement("td");
      td.textContent = text;
      if (i === 1 || i === 2) td.className = "mono";
      if (i === 3) td.style.cssText = `font-weight:600;color:var(--${same ? "bad" : "good"})`;
      tr.append(td);
    });
    $("oddRows").append(tr);
  }
})();

renderSalt();
renderCertTree();
renderBatch();
renderPrefix(false);
