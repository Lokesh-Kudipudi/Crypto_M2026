import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Contract, JsonRpcProvider } from "ethers";

const here = path.dirname(fileURLToPath(import.meta.url));
const ARTIFACTS = path.resolve(here, "../../client/src/contracts");

const REGISTRY_ABI = [
  "function owner() view returns (address)",
  "function issuers(address) view returns (string name, bool active)",
  "function batches(bytes32) view returns (address issuer, uint64 publishedAt, uint32 count)",
  "function revocations(bytes32) view returns (uint64 revokedAt, string reason)",
];

function artifactAddress(name, networkId) {
  try {
    const artifact = JSON.parse(readFileSync(path.join(ARTIFACTS, `${name}.json`), "utf8"));
    return artifact.networks[networkId]?.address ?? null;
  } catch {
    return null;
  }
}

/**
 * The server only reads the chain, to check what clients report. It holds no keys.
 * Addresses come from the Truffle artifacts unless set by environment variables,
 * and are read on each call so a redeploy doesn't need a server restart.
 */
export function createChain({ rpcUrl, registryAddress, baselineAddress }) {
  const provider = new JsonRpcProvider(rpcUrl, undefined, { batchMaxCount: 1, polling: false });

  async function addresses() {
    const [chainId, networkId] = await Promise.all([provider.send("eth_chainId", []), provider.send("net_version", [])]);
    return {
      chainId: Number(chainId),
      registry: registryAddress || artifactAddress("CertificateRegistry", networkId),
      baseline: baselineAddress || artifactAddress("AcademicCertificates", networkId),
    };
  }

  async function registry() {
    const { registry: address } = await addresses();
    if (!address) throw new Error("CertificateRegistry is not deployed on this chain");
    return new Contract(address, REGISTRY_ABI, provider);
  }

  return {
    addresses,
    getIssuer: async (address) => {
      const issuer = await (await registry()).issuers(address);
      return { name: issuer.name, active: issuer.active };
    },
    getBatch: async (root) => {
      const batch = await (await registry()).batches(root);
      return { issuer: batch.issuer, publishedAt: Number(batch.publishedAt), count: Number(batch.count) };
    },
    getRevocation: async (root) => {
      const revocation = await (await registry()).revocations(root);
      return { revokedAt: Number(revocation.revokedAt), reason: revocation.reason };
    },
    /** Gas used by a transaction, only if it was sent to the registry and succeeded. */
    getGasUsed: async (txHash) => {
      const receipt = await provider.getTransactionReceipt(txHash);
      const { registry: address } = await addresses();
      if (!receipt || receipt.status !== 1 || receipt.to?.toLowerCase() !== address?.toLowerCase()) return null;
      return Number(receipt.gasUsed);
    },
  };
}
