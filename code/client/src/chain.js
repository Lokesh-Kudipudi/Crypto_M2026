import Web3 from "web3";
import registryArtifact from "./contracts/CertificateRegistry.json";
import baselineArtifact from "./contracts/AcademicCertificates.json";
import { registryReader } from "./certcrypto.mjs";

/** Reading needs no wallet, so students and verifiers never need MetaMask. */
export function readRegistry(config) {
  if (!config?.registry) throw new Error("The contract isn't deployed on this chain yet. Run truffle migrate.");
  const web3 = new Web3(config.rpcUrl);
  return { web3, contract: new web3.eth.Contract(registryArtifact.abi, config.registry) };
}

export const readReader = (config) => registryReader(readRegistry(config).contract);

export function readBaseline(config) {
  if (!config?.baseline) return null;
  const web3 = new Web3(config.rpcUrl);
  return new web3.eth.Contract(baselineArtifact.abi, config.baseline);
}

/** Connect MetaMask, and refuse any network but the app's so nothing is signed on a real chain. */
export async function connectWallet(config) {
  if (!window.ethereum) throw new Error("MetaMask wasn't found. Install or enable it in this browser, then reload.");
  if (!config?.registry) throw new Error("The contract isn't deployed on this chain yet. Run truffle migrate.");
  const [account] = await window.ethereum.request({ method: "eth_requestAccounts" });
  const chainId = Number(await window.ethereum.request({ method: "eth_chainId" }));
  if (chainId !== config.chainId) {
    throw new Error(`MetaMask is on chain ${chainId}. Switch it to the local Ganache network (chain ${config.chainId}).`);
  }
  const web3 = new Web3(window.ethereum);
  return { web3, account, registry: new web3.eth.Contract(registryArtifact.abi, config.registry) };
}

export const signTypedData = (account, typedData) =>
  window.ethereum.request({ method: "eth_signTypedData_v4", params: [account, JSON.stringify(typedData)] });

export const personalSign = (account, message) =>
  window.ethereum.request({ method: "personal_sign", params: [Web3.utils.utf8ToHex(message), account] });

/** Pull the human-readable reason out of a web3 / MetaMask error. */
export function chainError(e) {
  const m = String((e && (e.message || e)) || "");
  const hit = m.match(/not an approved issuer|Batch already published|Not allowed to revoke this batch|Certificate is not in this batch|Already revoked|Batch does not exist|caller is not the owner|Issuer is not active/);
  if (hit) return hit[0];
  if (e?.code === 4001 || /User denied|rejected/i.test(m)) return "Rejected in MetaMask.";
  if (/Returned values aren't valid/i.test(m)) return "No contract found at this address. Redeploy with truffle migrate --reset.";
  return m.split("\n")[0];
}
