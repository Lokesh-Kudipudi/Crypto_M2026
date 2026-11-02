#!/usr/bin/env node
// Creates demo accounts, publishes a sample batch to the local chain, and writes demo documents.
// Goes through the real API, certcrypto.mjs and contract, so the data is like anything issued by hand.
//
//   npm run seed:demo             needs Ganache (chain 1337), the deployed contract and IPFS
//   npm run seed:demo -- --reset  replaces the demo data and leaves other accounts alone
//
// Env overrides: DATA_DIR, RPC_URL, IPFS_API, REGISTRY_ADDRESS, BASELINE_ADDRESS, DEMO_DIR
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Interface, hexlify, randomBytes, toUtf8Bytes } from "ethers";
import { createApp } from "../src/app.js";
import { createChain } from "../src/chain.js";
import { openDatabase, transaction } from "../src/db.js";
import { loadOrCreateKey } from "../src/security.js";
import { certificatePdf } from "./demo-pdf.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../..");
const dataDir = process.env.DATA_DIR || path.join(root, "server/data");
const demoDir = process.env.DEMO_DIR || path.join(root, "client/public/demo");
const rpcUrl = process.env.RPC_URL || "http://127.0.0.1:8545";
const ipfsApi = process.env.IPFS_API || "http://127.0.0.1:5001";

const lib = await import(path.join(root, "client/src/certcrypto.mjs"));
const ipfs = await import(path.join(root, "client/src/ipfs.mjs"));
const { GAS } = await import(path.join(root, "client/src/cost.mjs"));
const { toCsv } = await import(path.join(root, "client/src/csv.mjs"));
const { abi } = JSON.parse(readFileSync(path.join(root, "client/src/contracts/CertificateRegistry.json"), "utf8"));

const LOCAL_CHAIN_ID = 1337;
const ORGANIZATION = "Demo University";
const ACCOUNTS = {
  admin: { name: "Demo Admin", email: "admin@demo.certchain.test" },
  issuer: { name: "Demo Registrar", email: "registrar@demo.certchain.test" },
  student: { name: "Demo Student", email: "student@demo.certchain.test" },
  verifier: { name: "Demo Verifier", email: "verifier@demo.certchain.test" },
};
const CERTIFICATES = [
  { certificateId: "DEMO-2026-0001", uid: "DM22CS001", candidateName: "Demo Student", courseName: "B.Tech Computer Science", cgpa: "8.70", completionYear: "2024" },
  { certificateId: "DEMO-2026-0002", uid: "DM24IS002", candidateName: "Demo Student", courseName: "M.Tech Information Security", cgpa: "9.10", completionYear: "2026" },
  { certificateId: "DEMO-2026-0003", uid: "DM22EC003", candidateName: "Priya Example", courseName: "B.Tech Electronics", cgpa: "8.25", completionYear: "2026" },
  { certificateId: "DEMO-2026-0004", uid: "DM22ME004", candidateName: "Arjun Sample", courseName: "B.Tech Mechanical", cgpa: "7.90", completionYear: "2026" },
];
// Left unissued, so they can be imported by hand from the New batch page
const IMPORT_ROWS = [
  { certificateId: "IMPORT-2026-0001", uid: "DM23CS101", candidateName: "Kavya Placeholder", courseName: "B.Tech Computer Science", cgpa: "9.05", completionYear: "2026", pdfFile: "import-kavya-placeholder.pdf" },
  { certificateId: "IMPORT-2026-0002", uid: "DM23CS102", candidateName: "Rohan Testcase", courseName: "B.Tech Computer Science", cgpa: "8.15", completionYear: "2026", pdfFile: "import-rohan-testcase.pdf" },
  { certificateId: "IMPORT-2026-0003", uid: "DM23DS103", candidateName: "Meera Mock", courseName: "B.Sc Data Science", cgpa: "8.80", completionYear: "2026", pdfFile: "import-meera-mock.pdf" },
];

const fail = (message) => {
  console.error(`\n${message}`);
  process.exit(1);
};

async function rpc(method, params = []) {
  const res = await fetch(rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const { result, error } = await res.json();
  if (error) throw new Error(error.message);
  return result;
}

const registryInterface = new Interface(abi);

async function sendRegistry(registry, from, method, args) {
  const hash = await rpc("eth_sendTransaction", [{ from, to: registry, data: registryInterface.encodeFunctionData(method, args), gas: "0x7A120" }]);
  const receipt = await rpc("eth_getTransactionReceipt", [hash]);
  if (!receipt || Number(receipt.status) !== 1) throw new Error(`${method} failed`);
  return hash;
}

async function readRegistry(registry, method, args = []) {
  const data = await rpc("eth_call", [{ to: registry, data: registryInterface.encodeFunctionData(method, args) }, "latest"]);
  return registryInterface.decodeFunctionResult(method, data);
}

function deleteDemoData(db) {
  const ids = db.prepare("SELECT id FROM users WHERE is_demo = 1").all().map((u) => u.id);
  if (!ids.length) return;
  const list = ids.join(",");
  transaction(db, () => {
    db.exec(`
      DELETE FROM verifications WHERE user_id IN (${list});
      DELETE FROM share_links WHERE student_id IN (${list});
      UPDATE certificates SET student_id = NULL WHERE student_id IN (${list});
      DELETE FROM batches WHERE issuer_id IN (${list});
      DELETE FROM audit_log WHERE user_id IN (${list});
      DELETE FROM users WHERE id IN (${list});
    `);
  });
}

function apiClient(base) {
  let cookie = "";
  const call = async (method, route, body) => {
    const res = await fetch(base + route, {
      method,
      headers: { ...(body ? { "content-type": "application/json" } : {}), ...(cookie ? { cookie } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const setCookie = res.headers.get("set-cookie");
    if (setCookie) cookie = setCookie.split(";")[0];
    const text = await res.text();
    const data = text ? JSON.parse(text) : null;
    if (!res.ok) throw new Error(`${method} ${route}: ${data?.error ?? res.status}`);
    return data;
  };
  return { get: (r) => call("GET", r), post: (r, b = {}) => call("POST", r, b) };
}

// ---- Preflight: fail clearly, and never touch anything but the local chain

const db = openDatabase(path.join(dataDir, "app.db"));
const hasDemo = db.prepare("SELECT 1 FROM users WHERE is_demo = 1 LIMIT 1").get();
if (hasDemo && !process.argv.includes("--reset")) {
  console.log("Demo accounts already exist. Use `npm run seed:demo -- --reset` to replace them.");
  process.exit(0);
}

const chain = createChain({ rpcUrl, registryAddress: process.env.REGISTRY_ADDRESS, baselineAddress: process.env.BASELINE_ADDRESS });
const { chainId, registry } = await chain.addresses().catch(() => fail(`Can't reach the chain at ${rpcUrl}. Start it with npm run chain in truffle/.`));
if (chainId !== LOCAL_CHAIN_ID) fail(`This only seeds the local chain (${LOCAL_CHAIN_ID}), but ${rpcUrl} is chain ${chainId}.`);
if (!registry) fail("CertificateRegistry isn't deployed. Run npx truffle migrate --reset in truffle/.");

ipfs.setIpfsApi(ipfsApi);
await fetch(`${ipfsApi}/api/v0/version`, { method: "POST" }).catch(() => fail(`Can't reach IPFS at ${ipfsApi}. Start it with ipfs daemon.`));

const nodeAccounts = (await rpc("eth_accounts")).map((a) => a.toLowerCase());
const [owner] = await readRegistry(registry, "owner");
if (!nodeAccounts.includes(owner.toLowerCase())) fail(`The contract owner ${owner} isn't an account on this node.`);

if (hasDemo) {
  deleteDemoData(db);
  console.log("Removed the old demo data. Its past transactions stay on the chain.");
}

// Prefer the owner's wallet, which is already approved as Demo University, unless someone has linked it
const isFree = (address) => !db.prepare("SELECT 1 FROM users WHERE wallet = ?").get(address);
const issuerWallet = [owner, ...nodeAccounts].find(isFree);
if (!issuerWallet) fail("Every account on this node is already linked to a user.");

const server = await new Promise((resolve) => {
  const app = createApp({ db, chain, sealKey: loadOrCreateKey(path.join(dataDir, "secret.key")), config: { rpcUrl, ipfsApi } });
  const listener = app.listen(0, "127.0.0.1", () => resolve(listener));
});
const base = `http://127.0.0.1:${server.address().port}/api`;

async function createAccount(key, role, extra = {}) {
  const client = apiClient(base);
  const { name, email } = ACCOUNTS[key];
  const password = hexlify(randomBytes(24));
  const { user } = await client.post("/auth/signup", { email, name, password, role, ...extra });
  db.prepare("UPDATE users SET is_demo = 1 WHERE id = ?").run(user.id);
  return { client, user };
}

try {
  // ---- Accounts

  console.log("Creating accounts…");
  const admin = await createAccount("admin", "student");
  db.prepare("UPDATE users SET role = 'admin' WHERE id = ?").run(admin.user.id);

  const issuer = await createAccount("issuer", "issuer", { organization: ORGANIZATION });
  const { message } = await issuer.client.post("/wallet/challenge");
  const walletSignature = await rpc("eth_sign", [issuerWallet, hexlify(toUtf8Bytes(message))]);
  await issuer.client.post("/wallet/link", { address: issuerWallet, signature: walletSignature });

  const [onChainName, onChainActive] = await readRegistry(registry, "issuers", [issuerWallet]);
  if (!onChainActive || onChainName !== ORGANIZATION) {
    await sendRegistry(registry, owner, "addIssuer", [issuerWallet, ORGANIZATION]);
  }
  await admin.client.post(`/admin/users/${issuer.user.id}/approve`);

  const student = await createAccount("student", "student");
  const verifier = await createAccount("verifier", "verifier");

  // ---- Documents

  rmSync(demoDir, { recursive: true, force: true });
  mkdirSync(demoDir, { recursive: true });
  const writeDoc = (name, content) => writeFileSync(path.join(demoDir, name), content);
  const pdfFor = (values) => certificatePdf({ ...values, organizationName: ORGANIZATION });

  for (const row of IMPORT_ROWS) writeDoc(row.pdfFile, pdfFor(row));
  writeDoc("import-batch.csv", toCsv(IMPORT_ROWS, Object.keys(IMPORT_ROWS[0]).map((key) => ({ key, label: key }))));

  // ---- Publish a batch

  console.log("Encrypting PDFs and uploading them to IPFS…");
  const certs = [];
  for (const values of CERTIFICATES) {
    const pdf = pdfFor(values);
    writeDoc(`certificate-${values.certificateId}.pdf`, pdf);
    const { ciphertext, key } = await lib.encryptPdf(new Uint8Array(pdf));
    const pdfCid = await ipfs.uploadToIpfs(new File([ciphertext], "certificate.enc"));
    const cert = lib.buildCertificate({
      ...values,
      organizationName: ORGANIZATION,
      pdfSha256: await lib.sha256Hex(new Uint8Array(pdf)),
      pdfCid,
    });
    certs.push({ ...cert, pdfKey: key, storedBytes: ciphertext.length });
  }

  console.log("Signing and publishing the batch…");
  const { batchRoot, count } = lib.buildBatch(certs.map((c) => c.certRoot));
  const signature = await rpc("eth_signTypedData_v4", [issuerWallet, lib.batchTypedData(chainId, registry, batchRoot, count)]);
  const credentials = lib.buildCredentials(certs, { chainId, registry, signature });
  const { codes } = await issuer.client.post("/issuer/batches", {
    root: batchRoot,
    certificates: credentials.map((credential) => ({ credential })),
    baselineGas: GAS.baselinePerCertificate * count,
    storedBytes: certs.reduce((sum, c) => sum + c.storedBytes, 0),
  });
  const txHash = await sendRegistry(registry, issuerWallet, "publishBatch", [batchRoot, count, signature]);
  await issuer.client.post(`/issuer/batches/${batchRoot}/confirm`, { txHash });

  // ---- Claim two, revoke one, and leave one unclaimed for trying a code

  const [first, second, unclaimed, revoked] = credentials;
  const codeFor = (credential) => codes.find((c) => c.certificateId === credential.fields.certificateId.value).claimCode;
  await student.client.post("/student/claim", { code: codeFor(first) });
  await student.client.post("/student/claim", { code: codeFor(second) });

  const issuerRows = (await issuer.client.get("/issuer/certificates")).certificates;
  const revokedRow = issuerRows.find((c) => c.cert_root === revoked.certRoot);
  await sendRegistry(registry, issuerWallet, "revokeCertificate", [batchRoot, revoked.certRoot, revoked.batchProof, "Issued in error (demo)"]);
  await issuer.client.post(`/issuer/certificates/${revokedRow.id}/revoked`);

  // ---- Presentations, a share link, and some verification history

  const validPresentation = lib.createPresentation(first, ["certificateId", "courseName", "organizationName", "completionYear", "pdfSha256"]);
  const tamperedPresentation = lib.createPresentation(first, ["certificateId", "courseName", "cgpa"]);
  tamperedPresentation.disclosed.find((f) => f.name === "cgpa").value = "10.00";
  const revokedPresentation = lib.createPresentation(revoked, ["certificateId", "courseName"]);
  writeDoc("presentation-valid.json", JSON.stringify(validPresentation, null, 2));
  writeDoc("presentation-tampered.json", JSON.stringify(tamperedPresentation, null, 2));
  writeDoc("presentation-revoked.json", JSON.stringify(revokedPresentation, null, 2));
  writeDoc("certificate-altered.pdf", pdfFor({ ...CERTIFICATES[0], cgpa: "10.00" }));

  const [firstRow] = (await student.client.get("/student/certificates")).certificates.filter((c) => c.certificate_id === CERTIFICATES[0].certificateId);
  const { token } = await student.client.post(`/student/certificates/${firstRow.id}/shares`, {
    presentation: lib.createPresentation(first, ["certificateId", "courseName", "organizationName"]),
    expiresInDays: 365,
  });

  console.log("Checking the results against the chain…");
  const reader = {
    getBatch: async (r) => chain.getBatch(r),
    getIssuer: async (a) => chain.getIssuer(a),
    getRevocation: async (r) => chain.getRevocation(r),
  };
  const check = (presentation, options = {}) => lib.verifyPresentation(presentation, reader, { chainId, address: registry, ...options });
  const expectations = [
    ["valid presentation", validPresentation, lib.STATUS.VALID],
    ["tampered presentation", tamperedPresentation, lib.STATUS.TAMPERED],
    ["revoked presentation", revokedPresentation, lib.STATUS.REVOKED],
  ];
  for (const [label, presentation, expected] of expectations) {
    const result = await check(presentation);
    if (result.status !== expected) throw new Error(`The ${label} gave ${result.status}, expected ${expected}`);
    await verifier.client.post("/verifications", {
      status: result.status,
      certificateRef: result.disclosed.certificateId,
      issuerName: result.issuer,
      batchRoot,
      message: result.message,
    });
  }
  const stored = await check(lib.createPresentation(first, ["certificateId"], { includePdf: true }), { fetchCiphertext: ipfs.catBytes });
  if (stored.status !== lib.STATUS.VALID || !stored.pdfChecked) throw new Error(`The stored PDF check failed: ${stored.message}`);

  writeDoc("manifest.json", JSON.stringify({
    issuerWallet,
    claimCode: codeFor(unclaimed),
    claimCertificate: unclaimed.fields.certificateId.value,
    sharePath: `/verify/${token}`,
    groups: [
      {
        title: "To verify",
        files: [
          { file: "presentation-valid.json", label: "Valid presentation", note: "Shows Valid. Add the matching PDF to check the file too." },
          { file: "certificate-DEMO-2026-0001.pdf", label: "Matching PDF", note: "Use with the valid presentation." },
          { file: "certificate-altered.pdf", label: "Altered PDF", note: "Use with the valid presentation. Shows Tampered." },
          { file: "presentation-tampered.json", label: "Tampered presentation", note: "The CGPA was changed. Shows Tampered." },
          { file: "presentation-revoked.json", label: "Revoked presentation", note: "Shows Revoked." },
        ],
      },
      {
        title: "To issue",
        files: [
          { file: "import-batch.csv", label: "Class list (CSV)", note: "Import under New batch. Each ID can only be issued once." },
          ...IMPORT_ROWS.map((row) => ({ file: row.pdfFile, label: `PDF: ${row.candidateName}`, note: "Select all three with the CSV." })),
        ],
      },
    ],
  }, null, 2));

  console.log(`\nDone. Log in from the login page with "Try a demo account". Documents are in ${demoDir}`);
  server.close();
  process.exit(0);
} catch (e) {
  deleteDemoData(db);
  server.close();
  fail(`Seeding failed, so the demo accounts were removed: ${e.message}`);
}
