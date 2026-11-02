#!/usr/bin/env node
// End-to-end test of the paper pipeline WITHOUT a browser or MetaMask:
//   CORS -> upload PDF -> CID -> generateCertificate(CID) -> getCertificate -> retrieval -> verify
//   -> tamper detection -> duplicate ID -> unknown ID
// Uses the same ipfs.mjs helper as the React app. Needs: IPFS daemon, Ganache, deployed contract.
//
//   node scripts/e2e.mjs [path\to\certificate.pdf]
//
// Env overrides: GANACHE_URL (http://127.0.0.1:8545)  CONTRACT_ADDRESS  ORIGIN (http://localhost:8080)
import { createRequire } from "node:module";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const require = createRequire(path.join(root, "client", "package.json"));
const Web3 = require("web3");
const { IPFS_API, IPFS_GATEWAY, uploadToIpfs, computeCid, catBytes, checkPdfAgainstCid } = await import(
  new URL("../client/src/ipfs.mjs", import.meta.url).href
);

const GANACHE = process.env.GANACHE_URL || "http://127.0.0.1:8545";
const ORIGIN = process.env.ORIGIN || "http://localhost:8080";
const artifact = JSON.parse(readFileSync(path.join(root, "client/src/contracts/AcademicCertificates.json"), "utf8"));

let failed = 0;
const ok = (name, detail = "") => console.log(`  PASS  ${name}${detail ? "  -> " + detail : ""}`);
const bad = (name, detail = "") => { failed++; console.log(`  FAIL  ${name}${detail ? "  -> " + detail : ""}`); };
const check = (cond, name, detail) => (cond ? ok(name, detail) : bad(name, detail));
const same = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);

// --- test PDF: an argument, or a small synthetic PDF made unique with a nonce
let pdfBytes, pdfName;
if (process.argv[2]) {
  pdfBytes = new Uint8Array(readFileSync(process.argv[2])); pdfName = path.basename(process.argv[2]);
} else {
  const nonce = `${Date.now()}-${Math.random()}`;
  pdfBytes = new TextEncoder().encode(`%PDF-1.4\n% e2e test certificate ${nonce}\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n`);
  pdfName = "e2e-test.pdf";
}
const asFile = (bytes) => new File([bytes], pdfName, { type: "application/pdf" });
const certId = `E2E-${Date.now()}`;

console.log(`IPFS API ${IPFS_API} | gateway ${IPFS_GATEWAY} | chain ${GANACHE} | simulated page origin ${ORIGIN}\n`);

// 1. CORS -------------------------------------------------------------------
console.log("1. CORS (what the browser enforces)");
try {
  const pre = await fetch(`${IPFS_API}/api/v0/add`, {
    method: "OPTIONS",
    headers: { Origin: ORIGIN, "Access-Control-Request-Method": "POST" },
  });
  const acao = pre.headers.get("access-control-allow-origin");
  check(acao === ORIGIN, "preflight returns Access-Control-Allow-Origin", `HTTP ${pre.status}, Allow-Origin=${acao}`);
  const post = await fetch(`${IPFS_API}/api/v0/add?only-hash=true`, {
    method: "POST", headers: { Origin: ORIGIN }, body: (() => { const f = new FormData(); f.append("file", new Blob(["cors"]), "c.txt"); return f; })(),
  });
  check(post.status === 200 && post.headers.get("access-control-allow-origin") === ORIGIN, "POST /add accepted for this origin", `HTTP ${post.status}`);
} catch (e) { bad("IPFS API reachable", e.message); }
if (failed) {
  console.log("\nCORS step failed: the browser upload cannot work. Fix: scripts\\fix-ipfs-cors.ps1, then RESTART the IPFS daemon.");
  process.exit(1);
}

// 2. Upload -> CID ----------------------------------------------------------
console.log("2. Upload PDF to IPFS");
const cid = await uploadToIpfs(asFile(pdfBytes));
check(/^Qm[1-9A-HJ-NP-Za-km-z]{44}$/.test(cid), "CID returned (CIDv0)", cid);

// 3. On-chain store ---------------------------------------------------------
console.log("3. generateCertificate(CID) on Ganache");
const web3 = new Web3(GANACHE);
const chainId = await web3.eth.getChainId();
const accounts = await web3.eth.getAccounts();
const address = process.env.CONTRACT_ADDRESS || artifact.networks[chainId]?.address;
check(!!address, `contract address for chain ${chainId}`, address);
check((await web3.eth.getCode(address)).length > 2, "contract code present at that address");
const contract = new web3.eth.Contract(artifact.abi, address);
const rec = await contract.methods
  .generateCertificate(certId, "UID-1", "Test Candidate", "B.Tech", "Test University", cid, "8.5", 2025)
  .send({ from: accounts[0], gas: 3000000 });
check(rec.status === true || rec.status === 1n, "transaction mined", `tx ${rec.transactionHash}`);

// 4. Fetch ------------------------------------------------------------------
console.log("4. getCertificate shows the CID");
const got = await contract.methods.getCertificate(certId).call();
check(got[4] === cid, "on-chain CID equals uploaded CID", got[4]);
check(got[1] === "Test Candidate" && Number(got[6]) === 2025, "other fields stored correctly");

// 5. Retrieval --------------------------------------------------------------
console.log("5. Retrieve the PDF by on-chain CID");
check(same(await catBytes(got[4]), pdfBytes), "API /cat returns identical bytes");
const gw = await fetch(`${IPFS_GATEWAY}/ipfs/${got[4]}`);
check(gw.status === 200 && same(new Uint8Array(await gw.arrayBuffer()), pdfBytes), "gateway returns identical bytes", `HTTP ${gw.status}`);

// 6. Verify -----------------------------------------------------------------
console.log("6. verifyCertificate");
const v = await contract.methods.verifyCertificate(certId).call();
check(v[0] === true, "valid certificate reported valid");

// 7/8. Hash verification + tamper ------------------------------------------
console.log("7. Hash verification (recompute CID with only-hash)");
check((await computeCid(asFile(pdfBytes))) === cid, "only-hash CID equals stored CID");
const r1 = await checkPdfAgainstCid(asFile(pdfBytes), got[4]);
check(r1.match === true, "original PDF passes the check", r1.method);
console.log("8. Tamper detection");
const tampered = pdfBytes.slice(); tampered[tampered.length - 2] ^= 0x01;
const r2 = await checkPdfAgainstCid(asFile(tampered), got[4]);
check(r2.match === false, "1-byte-modified PDF is rejected", `recomputed ${r2.recomputed}`);
check(r2.recomputed !== cid, "tampered PDF hashes to a different CID");

// 9. Duplicate ID -----------------------------------------------------------
console.log("9. Duplicate certificate ID");
const dupArgs = [certId, "U", "Attacker", "X", "X", "QmOverwriteAttempt", "1", 2000];
try {
  await contract.methods.generateCertificate(...dupArgs).call({ from: accounts[0] });
  bad("duplicate ID rejected by eth_call");
} catch (e) {
  check(/already exists/.test(e.message), "eth_call reverts with contract reason", (e.message.match(/Certificate with this ID already exists/) || [e.message.split("\n")[0]])[0]);
}
try {
  await contract.methods.generateCertificate(...dupArgs).send({ from: accounts[0], gas: 3000000 });
  bad("duplicate ID rejected on-chain", "second generateCertificate unexpectedly succeeded");
} catch (e) {
  check(/revert/i.test(e.message), "duplicate transaction is reverted on-chain");
}
const after = await contract.methods.getCertificate(certId).call();
check(after[4] === cid && after[1] === "Test Candidate", "original record unchanged after duplicate attempt", after[4]);

// 10. Unknown ID ------------------------------------------------------------
console.log("10. Unknown ID");
check((await contract.methods.verifyCertificate("NO-SUCH-ID").call())[0] === false, "verify returns invalid for unknown ID");
try { await contract.methods.getCertificate("NO-SUCH-ID").call(); bad("getCertificate reverts for unknown ID"); }
catch (e) { ok("getCertificate reverts for unknown ID"); }

console.log(failed ? `\n${failed} CHECK(S) FAILED` : "\nALL CHECKS PASSED");
process.exit(failed ? 1 : 0);
