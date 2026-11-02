// Certificate cryptography. Used by the React app (Main.jsx), the contract tests
// and scripts/e2e-registry.mjs, so all of them exercise exactly the same code.
//
//   field leaf  = keccak256(0x00 || abi.encode(name, value, salt))
//   tree node   = keccak256(0x01 || low || high)   (children sorted)
//   batch leaf  = keccak256(0x02 || certRoot)
//
// The prefixes stop a node being passed off as a leaf (second-preimage attack), and an
// odd node is promoted unchanged rather than paired with itself.
// The node and batch leaf rules must match CertificateRegistry.sol.
import { AbiCoder, concat, hexlify, keccak256, verifyTypedData } from "ethers";

export const CERT_FIELDS = [
  "certificateId", "uid", "candidateName", "courseName", "organizationName",
  "cgpa", "completionYear", "pdfSha256", "pdfCid",
];
export const PDF_FIELDS = ["pdfSha256", "pdfCid"];

export const STATUS = {
  VALID: "VALID",
  TAMPERED: "TAMPERED",
  REVOKED: "REVOKED",
  UNKNOWN_ISSUER: "UNKNOWN_ISSUER",
  NOT_ANCHORED: "NOT_ANCHORED",
};

const FORMAT_VERSION = 1;
const PDF_AAD = new TextEncoder().encode("academic-certificate-pdf-v1");
const IV_BYTES = 12;

const randomHex = (bytes) => hexlify(crypto.getRandomValues(new Uint8Array(bytes)));
const toBytes = (hex) => Uint8Array.from(hex.slice(2).match(/../g), (b) => parseInt(b, 16));

// ---- Merkle tree

export const fieldLeaf = (name, value, salt) =>
  keccak256(concat(["0x00", AbiCoder.defaultAbiCoder().encode(["string", "string", "bytes32"], [name, value, salt])]));

export const batchLeaf = (certRoot) => keccak256(concat(["0x02", certRoot]));

export const hashNode = (a, b) =>
  keccak256(concat(["0x01", ...(BigInt(a) < BigInt(b) ? [a, b] : [b, a])]));

function treeLevels(leaves) {
  if (!leaves.length) throw new Error("A Merkle tree needs at least one leaf");
  const levels = [leaves];
  while (levels[levels.length - 1].length > 1) {
    const level = levels[levels.length - 1];
    const next = [];
    for (let i = 0; i < level.length; i += 2) {
      next.push(i + 1 < level.length ? hashNode(level[i], level[i + 1]) : level[i]);
    }
    levels.push(next);
  }
  return levels;
}

export const merkleRoot = (leaves) => treeLevels(leaves).pop()[0];

export function merkleProof(leaves, index) {
  const proof = [];
  for (const level of treeLevels(leaves).slice(0, -1)) {
    const sibling = index ^ 1;
    if (sibling < level.length) proof.push(level[sibling]);
    index >>= 1;
  }
  return proof;
}

export const verifyProof = (root, leaf, proof) => proof.reduce(hashNode, leaf) === root;

// ---- Certificates and batches

const certLeaves = (fields) => CERT_FIELDS.map((n) => fieldLeaf(n, fields[n].value, fields[n].salt));

/** Commit to a certificate's values, with a fresh random salt per field. */
export function buildCertificate(values) {
  const fields = {};
  for (const name of CERT_FIELDS) {
    const value = values[name];
    if (typeof value !== "string" || !value) throw new Error(`Certificate field "${name}" is required`);
    fields[name] = { value, salt: randomHex(32) };
  }
  return { fields, certRoot: merkleRoot(certLeaves(fields)) };
}

export function buildBatch(certRoots) {
  const leaves = certRoots.map(batchLeaf);
  return {
    batchRoot: merkleRoot(leaves),
    count: certRoots.length,
    proofs: certRoots.map((_, i) => merkleProof(leaves, i)),
  };
}

// ---- EIP-712

const BATCH_TYPES = {
  Batch: [
    { name: "root", type: "bytes32" },
    { name: "count", type: "uint32" },
  ],
};

const batchDomain = (chainId, registry) => ({
  name: "AcademicCertificates", version: "1", chainId: Number(chainId), verifyingContract: registry,
});

/** The JSON that eth_signTypedData_v4 expects. */
export const batchTypedData = (chainId, registry, batchRoot, count) => ({
  types: {
    EIP712Domain: [
      { name: "name", type: "string" },
      { name: "version", type: "string" },
      { name: "chainId", type: "uint256" },
      { name: "verifyingContract", type: "address" },
    ],
    ...BATCH_TYPES,
  },
  primaryType: "Batch",
  domain: batchDomain(chainId, registry),
  message: { root: batchRoot, count },
});

export const recoverBatchSigner = (chainId, registry, batchRoot, count, signature) =>
  verifyTypedData(batchDomain(chainId, registry), BATCH_TYPES, { root: batchRoot, count }, signature);

// ---- PDF encryption (AES-256-GCM) and hashing

export async function sha256Hex(bytes) {
  return hexlify(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)));
}

/** Returns the ciphertext (IV prepended) and the key that only the student receives. */
export async function encryptPdf(bytes) {
  const key = randomHex(32);
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const cryptoKey = await crypto.subtle.importKey("raw", toBytes(key), "AES-GCM", false, ["encrypt"]);
  const body = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: PDF_AAD }, cryptoKey, bytes);
  const ciphertext = new Uint8Array(IV_BYTES + body.byteLength);
  ciphertext.set(iv);
  ciphertext.set(new Uint8Array(body), IV_BYTES);
  return { ciphertext, key };
}

/** Throws if the key is wrong or the ciphertext was altered. */
export async function decryptPdf(ciphertext, key) {
  const cryptoKey = await crypto.subtle.importKey("raw", toBytes(key), "AES-GCM", false, ["decrypt"]);
  const body = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: ciphertext.slice(0, IV_BYTES), additionalData: PDF_AAD },
    cryptoKey,
    ciphertext.slice(IV_BYTES)
  );
  return new Uint8Array(body);
}

// ---- Credentials (held by the student) and presentations (given to a verifier)

export function buildCredentials(certs, { chainId, registry, signature }) {
  const { batchRoot, count, proofs } = buildBatch(certs.map((c) => c.certRoot));
  return certs.map((c, i) => ({
    version: FORMAT_VERSION,
    chainId: Number(chainId),
    registry,
    batchRoot,
    count,
    signature,
    certRoot: c.certRoot,
    batchProof: proofs[i],
    fields: c.fields,
    pdfKey: c.pdfKey,
  }));
}

/** Reveal only the named fields. Sharing the PDF also reveals everything printed in it. */
export function createPresentation(credential, names, { includePdf = false } = {}) {
  const disclosed = new Set(includePdf ? [...names, ...PDF_FIELDS] : names);
  if (!disclosed.size) throw new Error("Choose at least one field to disclose");
  const leaves = certLeaves(credential.fields);
  const presentation = {
    version: FORMAT_VERSION,
    chainId: credential.chainId,
    registry: credential.registry,
    batchRoot: credential.batchRoot,
    count: credential.count,
    signature: credential.signature,
    certRoot: credential.certRoot,
    batchProof: credential.batchProof,
    disclosed: CERT_FIELDS.filter((n) => disclosed.has(n)).map((name) => ({
      name,
      ...credential.fields[name],
      proof: merkleProof(leaves, CERT_FIELDS.indexOf(name)),
    })),
  };
  if (includePdf) presentation.pdfKey = credential.pdfKey;
  return presentation;
}

/** Adapts a web3 contract, so verification only needs these three reads. */
export const registryReader = (contract) => ({
  getBatch: async (root) => {
    const b = await contract.methods.batches(root).call();
    return { issuer: b.issuer, publishedAt: Number(b.publishedAt), count: Number(b.count) };
  },
  getIssuer: async (address) => {
    const i = await contract.methods.issuers(address).call();
    return { name: i.name, active: i.active };
  },
  getRevocation: async (root) => {
    const r = await contract.methods.revocations(root).call();
    return { revokedAt: Number(r.revokedAt), reason: r.reason };
  },
});

async function checkPdf(p, values, { pdfBytes, fetchCiphertext }) {
  if (!pdfBytes && !p.pdfKey) return { checked: false, note: "No PDF was supplied, so the file was not checked." };
  if (!values.pdfSha256) return { checked: false, note: "The PDF hash was not disclosed, so the file could not be checked." };
  let bytes = pdfBytes;
  if (!bytes) {
    if (!values.pdfCid || !fetchCiphertext) return { checked: false, note: "The encrypted PDF could not be located." };
    let ciphertext;
    try {
      ciphertext = await fetchCiphertext(values.pdfCid);
    } catch (e) {
      return { checked: false, note: `The encrypted PDF could not be retrieved (${e.message}).` };
    }
    try {
      bytes = await decryptPdf(ciphertext, p.pdfKey);
    } catch (e) {
      return { checked: true, match: false, note: "The stored PDF failed authenticated decryption." };
    }
  }
  const match = (await sha256Hex(bytes)) === values.pdfSha256;
  return { checked: true, match, note: match ? "The PDF matches the signed hash." : "The PDF does not match the signed hash." };
}

/**
 * Runs every check and returns one status.
 * options: { chainId, address, pdfBytes?, fetchCiphertext? }
 * pdfChecked says whether a file was compared; VALID alone only covers the disclosed fields.
 */
export async function verifyPresentation(p, reader, { chainId, address, pdfBytes, fetchCiphertext }) {
  const result = (status, message, extra = {}) => ({ status, message, disclosed: {}, pdfChecked: false, ...extra });

  const wellFormed = p && p.version === FORMAT_VERSION && Array.isArray(p.disclosed) && p.disclosed.length > 0
    && Array.isArray(p.batchProof) && p.batchRoot && p.certRoot;
  if (!wellFormed) return result(STATUS.TAMPERED, "This is not a valid presentation file.");
  if (Number(p.chainId) !== Number(chainId) || String(p.registry).toLowerCase() !== String(address).toLowerCase()) {
    return result(STATUS.NOT_ANCHORED, "This certificate belongs to a different chain or registry.");
  }

  const disclosed = {};
  try {
    for (const f of p.disclosed) {
      if (!CERT_FIELDS.includes(f.name) || f.name in disclosed) return result(STATUS.TAMPERED, `Unexpected field "${f.name}".`);
      if (!verifyProof(p.certRoot, fieldLeaf(f.name, f.value, f.salt), f.proof)) {
        return result(STATUS.TAMPERED, `Field "${f.name}" does not match the certificate's commitment.`);
      }
      disclosed[f.name] = f.value;
    }
    if (!verifyProof(p.batchRoot, batchLeaf(p.certRoot), p.batchProof)) {
      return result(STATUS.TAMPERED, "The certificate is not part of the claimed batch.");
    }
  } catch (e) {
    return result(STATUS.TAMPERED, "The presentation contains malformed hashes or proofs.");
  }

  const batch = await reader.getBatch(p.batchRoot);
  if (!batch.publishedAt) return result(STATUS.NOT_ANCHORED, "This batch was never published on-chain.", { disclosed });

  let signer;
  try {
    signer = recoverBatchSigner(chainId, address, p.batchRoot, batch.count, p.signature);
  } catch (e) {
    return result(STATUS.UNKNOWN_ISSUER, "The issuer signature is malformed.", { disclosed });
  }
  if (signer.toLowerCase() !== batch.issuer.toLowerCase()) {
    return result(STATUS.UNKNOWN_ISSUER, "The signature was not made by the batch's issuer.", { disclosed });
  }

  const issuer = await reader.getIssuer(batch.issuer);
  if (!issuer.name) return result(STATUS.UNKNOWN_ISSUER, "The issuer is not in the registry.", { disclosed });
  if (disclosed.organizationName && disclosed.organizationName !== issuer.name) {
    return result(STATUS.UNKNOWN_ISSUER, `The certificate names "${disclosed.organizationName}" but was issued by "${issuer.name}".`, { disclosed });
  }

  for (const [root, label] of [[p.batchRoot, "batch"], [p.certRoot, "certificate"]]) {
    const revocation = await reader.getRevocation(root);
    if (revocation.revokedAt) {
      return result(STATUS.REVOKED, `This ${label} was revoked: ${revocation.reason || "no reason given"}.`, { disclosed, issuer: issuer.name });
    }
  }

  const pdf = await checkPdf(p, disclosed, { pdfBytes, fetchCiphertext });
  if (pdf.checked && !pdf.match) return result(STATUS.TAMPERED, pdf.note, { disclosed, issuer: issuer.name, pdfChecked: true });

  const removed = issuer.active ? "" : " This issuer has since been removed from the registry.";
  return result(STATUS.VALID, `Issued by ${issuer.name}. ${pdf.note}${removed}`, {
    disclosed,
    issuer: issuer.name,
    issuerActive: issuer.active,
    pdfChecked: pdf.checked,
    publishedAt: batch.publishedAt,
  });
}
