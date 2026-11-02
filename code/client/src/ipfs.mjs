// Shared IPFS helpers. Used by the React app (Main.jsx) AND by scripts/e2e.mjs,
// so both exercise exactly the same HTTP calls.

export let IPFS_API = "http://127.0.0.1:5001";
export const setIpfsApi = (url) => { IPFS_API = url; };
export const IPFS_GATEWAY = "http://127.0.0.1:8081"; // Addresses.Gateway in the IPFS config

// Upload and re-hash MUST use identical import parameters, otherwise the same
// bytes can produce a different CID (v0 vs v1, raw leaves, chunk size).
const IMPORT = "cid-version=0&hash=sha2-256&chunker=size-262144&raw-leaves=false";

export class IpfsError extends Error {}

async function ipfsPost(path, body) {
  let res;
  try {
    res = await fetch(`${IPFS_API}/api/v0/${path}`, { method: "POST", body });
  } catch (e) {
    // fetch() only throws a bare TypeError for network AND CORS failures.
    throw new IpfsError(
      `Cannot reach the IPFS API at ${IPFS_API} (${e.message}). Either the daemon is not running, ` +
        `or the browser blocked it (CORS): API.HTTPHeaders must list this page's origin AND the ` +
        `daemon must be restarted afterwards. Run scripts/diagnose-ipfs.ps1.`
    );
  }
  if (res.status === 403) {
    throw new IpfsError(
      "IPFS API answered 403: this page's origin is not in API.HTTPHeaders.Access-Control-Allow-Origin " +
        "(or the daemon was not restarted after the change)."
    );
  }
  if (!res.ok) throw new IpfsError(`IPFS ${path.split("?")[0]} failed: HTTP ${res.status} ${await res.text()}`);
  return res;
}

async function add(file, extra) {
  const body = new FormData();
  body.append("file", file, file.name || "certificate.pdf");
  const res = await ipfsPost(`add?${IMPORT}&${extra}`, body);
  const lines = (await res.text()).trim().split("\n"); // NDJSON, last line = root object
  return JSON.parse(lines[lines.length - 1]).Hash;
}

/** Add + pin the file to the local IPFS node. Returns the CID string. */
export const uploadToIpfs = (file) => add(file, "pin=true");

/** Compute the CID the file WOULD have, without storing anything. */
export const computeCid = (file) => add(file, "only-hash=true");

/** Read the bytes stored under a CID from the local node. */
export async function catBytes(cid) {
  const res = await ipfsPost(`cat?arg=${encodeURIComponent(cid)}&timeout=15s`);
  return new Uint8Array(await res.arrayBuffer());
}

async function sha256Hex(bytes) {
  const d = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Tamper check: does this PDF match the CID stored on-chain?
 *  1. recompute the CID of the PDF and compare with the on-chain CID;
 *  2. if the CIDs differ, compare the actual bytes with what IPFS holds for the
 *     on-chain CID (a CID can differ for identical bytes if it was created with other import settings).
 */
export async function checkPdfAgainstCid(file, onChainCid) {
  const recomputed = await computeCid(file);
  if (recomputed === onChainCid) return { match: true, recomputed, method: "cid" };
  try {
    const stored = await catBytes(onChainCid);
    const mine = new Uint8Array(await file.arrayBuffer());
    if ((await sha256Hex(stored)) === (await sha256Hex(mine))) {
      return { match: true, recomputed, method: "bytes", note: "CID differs only because of import settings; content is byte-identical." };
    }
    return { match: false, recomputed, method: "bytes", note: "Content differs from the PDF stored under the on-chain CID." };
  } catch (e) {
    return { match: false, recomputed, method: "cid", note: `Recomputed CID differs and stored content could not be read (${e.message}).` };
  }
}
