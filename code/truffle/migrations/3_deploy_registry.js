let CertificateRegistry = artifacts.require("./CertificateRegistry.sol");

module.exports = async function (deployer, network, accounts) {
  await deployer.deploy(CertificateRegistry);
  const registry = await CertificateRegistry.deployed();

  // The deployer is the admin, and is also approved as a demo issuer
  await registry.addIssuer(accounts[0], "Demo University");

  console.log(`CertificateRegistry contract deployed at address: ${registry.address}`);
};
