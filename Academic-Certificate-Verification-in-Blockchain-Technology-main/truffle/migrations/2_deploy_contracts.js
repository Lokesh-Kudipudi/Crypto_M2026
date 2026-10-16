let AcademicCertificates = artifacts.require("./AcademicCertificates.sol");
const fs = require('fs');

module.exports = async function (deployer) {
  // Deploy the AcademicCertificates contract
  await deployer.deploy(AcademicCertificates);
  const deployedAcademicCertificates = await AcademicCertificates.deployed();

  // Create or update deployment configuration
  let configData = {};

  // Update with the deployed contract address
  configData.AcademicCertificates = deployedAcademicCertificates.address;

  // Save the configuration to a JSON file
  fs.writeFileSync('./deployment_config.json', JSON.stringify(configData, null, 2));

  console.log(`AcademicCertificates contract deployed at address: ${deployedAcademicCertificates.address}`);
};
