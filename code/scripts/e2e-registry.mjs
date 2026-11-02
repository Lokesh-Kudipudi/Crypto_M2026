#!/usr/bin/env node
// End-to-end test of the registry pipeline WITHOUT a browser or MetaMask:
//   encrypt PDF -> IPFS -> commit -> batch -> sign -> publish -> present -> verify -> tamper -> revoke
// Uses the same certcrypto.mjs and ipfs.mjs as the React app. Needs: IPFS daemon, Ganache, deployed contract.
//
//   node scripts/e2e-registry.mjs [path/to/certificate.pdf]
//
// Env overrides: GANACHE_URL (http://127.0.0.1:8545)
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const require = createRequire(path.join(root, "client", "package.json"));
const Web3 = require("web3");
const lib = await import(new URL("../client/src/certcrypto.mjs", import.meta.url).href);
const { uploadToIpfs, catBytes } = await import(new URL("../client/src/ipfs.mjs", import.meta.url).href);

const GANACHE = process.env.GANACHE_URL || "http://127.0.0.1:8545";
const artifact = JSON.parse(readFileSync(path.join(root, "client/src/contracts/CertificateRegistry.json"), "utf8"));

let failed = 0;
const check = (cond, name, detail = "") => {
  if (!cond) failed++;
  console.log(`  ${cond ? "PASS" : "FAIL"}  ${name}${detail ? "  -> " + detail : ""}`);
};
const same = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);

const web3 = new Web3(GANACHE);
const chainId = await web3.eth.getChainId();
const [issuer] = await web3.eth.getAccounts();
const address = artifact.networks[await web3.eth.net.getId()]?.address;
check(!!address, `contract address for chain ${chainId}`, address);
const contract = new web3.eth.Contract(artifact.abi, address);
const reader = lib.registryReader(contract);

const pdfBytes = process.argv[2]
  ? new Uint8Array(readFileSync(process.argv[2]))
  : new TextEncoder().encode(`%PDF-1.4\n% e2e test certificate ${Date.now()}-${Math.random()}\n%%EOF\n`);
const { name: issuerName } = await contract.methods.issuers(issuer).call();

console.log("1. Encrypt and upload PDFs");
const certs = [];
for (const candidateName of ["Asha Rao", "Ravi Kumar", "Meera Iyer"]) {
  const { ciphertext, key } = await lib.encryptPdf(pdfBytes);
  const pdfCid = await uploadToIpfs(new File([ciphertext], "certificate.enc"));
  check(same(await catBytes(pdfCid), ciphertext), "IPFS returns the ciphertext unchanged", pdfCid);
  certs.push({
    ...lib.buildCertificate({
      certificateId: `E2E-${Date.now()}-${certs.length}`, uid: "UID-1", candidateName, courseName: "B.Tech",
      organizationName: issuerName, cgpa: "8.5", completionYear: "2025",
      pdfSha256: await lib.sha256Hex(pdfBytes), pdfCid,
    }),
    pdfKey: key,
  });
}

console.log("2. Sign and publish the batch");
const { batchRoot, count } = lib.buildBatch(certs.map((c) => c.certRoot));
const signature = await new Promise((resolve, reject) =>
  web3.currentProvider.send(
    { jsonrpc: "2.0", id: 1, method: "eth_signTypedData_v4", params: [issuer, lib.batchTypedData(chainId, address, batchRoot, count)] },
    (err, res) => (err || res.error ? reject(err || new Error(res.error.message)) : resolve(res.result))
  )
);
const rec = await contract.methods.publishBatch(batchRoot, count, signature).send({ from: issuer, gas: 500000 });
check(rec.status === true, "batch published", `${rec.gasUsed} gas for ${count} certificates`);

const [credential] = lib.buildCredentials(certs, { chainId, registry: address, signature });
const options = { chainId, address };

console.log("3. Verify a presentation");
const partial = lib.createPresentation(credential, ["certificateId", "courseName"]);
const r1 = await lib.verifyPresentation(partial, reader, options);
check(r1.status === lib.STATUS.VALID, "selective disclosure verifies", r1.message);
check(!JSON.stringify(partial).includes("Asha Rao"), "undisclosed name is absent from the file");

console.log("4. Verify the stored PDF");
const withPdf = lib.createPresentation(credential, ["certificateId"], { includePdf: true });
const r2 = await lib.verifyPresentation(withPdf, reader, { ...options, fetchCiphertext: catBytes });
check(r2.status === lib.STATUS.VALID && r2.pdfChecked, "PDF fetched from IPFS, decrypted and matched", r2.message);
const altered = pdfBytes.slice();
altered[altered.length - 2] ^= 1;
const r3 = await lib.verifyPresentation(withPdf, reader, { ...options, pdfBytes: altered });
check(r3.status === lib.STATUS.TAMPERED, "1-byte-modified PDF is rejected", r3.message);

console.log("5. Tampered field");
const forged = lib.createPresentation(credential, ["cgpa"]);
forged.disclosed[0].value = "9.9";
check((await lib.verifyPresentation(forged, reader, options)).status === lib.STATUS.TAMPERED, "altered CGPA is rejected");

console.log("6. Revocation");
await contract.methods.revokeCertificate(batchRoot, credential.certRoot, credential.batchProof, "E2E test").send({ from: issuer, gas: 500000 });
const r4 = await lib.verifyPresentation(partial, reader, options);
check(r4.status === lib.STATUS.REVOKED, "revoked certificate is reported", r4.message);

console.log(failed ? `\n${failed} CHECK(S) FAILED` : "\nALL CHECKS PASSED");
process.exit(failed ? 1 : 0);
