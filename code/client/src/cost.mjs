// Gas measured on Ganache with the deployed contracts (solc 0.8.18).
// publishBatch costs the same at any batch size, because only one root is stored.
// baselinePerCertificate is the paper's generateCertificate with typical short values;
// it grows with the length of the strings, so the batch screen estimates it live instead.
export const GAS = {
  publishBatch: 57074,
  baselinePerCertificate: 237508,
  revokeBatch: 75499,
  revokeCertificateBase: 78142,
  revokeCertificatePerLevel: 1750,
  addIssuer: 73041,
  registryDeploy: 2793307,
  baselineDeploy: 1421842,
};

// Example values only: there's no live price feed, and users can change both
export const DEFAULT_GAS_PRICE_GWEI = 20;
export const DEFAULT_ETH_USD = 3000;

const GWEI_PER_ETH = 1e9;

export const gasToEth = (gas, gasPriceGwei) => (gas * gasPriceGwei) / GWEI_PER_ETH;
export const gasToUsd = (gas, gasPriceGwei, ethUsd) => gasToEth(gas, gasPriceGwei) * ethUsd;

export function estimateRevokeCertificate(batchSize) {
  const depth = batchSize > 1 ? Math.ceil(Math.log2(batchSize)) : 0;
  return GAS.revokeCertificateBase + depth * GAS.revokeCertificatePerLevel;
}

/** Issuing costs for the registry and the paper's contract. Verifying costs nothing on either. */
export function compareIssuing({ certificates, batchSize, baselinePerCertificate = GAS.baselinePerCertificate }) {
  const batches = certificates > 0 ? Math.ceil(certificates / Math.max(1, batchSize)) : 0;
  const registryGas = batches * GAS.publishBatch;
  const baselineGas = certificates * baselinePerCertificate;
  return {
    batches,
    registryGas,
    baselineGas,
    savedGas: baselineGas - registryGas,
    savedPercent: baselineGas ? ((baselineGas - registryGas) / baselineGas) * 100 : 0,
  };
}

/**
 * The registry costs more to deploy, so this is the certificate count where it has
 * paid that back. Returns null if a batch never costs less than the paper's contract.
 */
export function breakEvenCertificates({ batchSize, baselinePerCertificate = GAS.baselinePerCertificate }) {
  const savedPerCertificate = baselinePerCertificate - GAS.publishBatch / Math.max(1, batchSize);
  if (savedPerCertificate <= 0) return null;
  return Math.ceil((GAS.registryDeploy - GAS.baselineDeploy) / savedPerCertificate);
}
