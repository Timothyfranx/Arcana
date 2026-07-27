import hre from "hardhat";
import dotenv from "dotenv";

dotenv.config();

async function main() {
  const connection = await hre.network.getOrCreate("sepolia");
  const { ethers } = connection;
  const [deployer] = await ethers.getSigners();
  const deployerAddress = await deployer.getAddress();

  const noxComputeAddress = "0x24Ef36Ec5b626D7DCD09a98F3083c2758F0F77bF";
  
  // Two separate addresses for relayer and price oracle roles
  // Oracle: Deployer Wallet (0xBDB82a3905a3B22B32885Bad996cbc9917436534)
  // Relayer: Fresh Dedicated Wallet (0x2A331463eff2603e39748B30f2b52820d160B5eA)
  const priceOracleAddress = deployerAddress;
  const relayerAddress = "0x2A331463eff2603e39748B30f2b52820d160B5eA";

  console.log("=== Deploying Fresh IntentRelay Contract to Ethereum Sepolia ===");
  console.log(`Deployer Wallet: ${deployerAddress}`);
  console.log(`NoxCompute Address: ${noxComputeAddress}`);
  console.log(`Price Oracle Role Address: ${priceOracleAddress}`);
  console.log(`Relayer Role Address: ${relayerAddress}`);

  const IntentRelayFactory = await ethers.getContractFactory("IntentRelay", deployer);
  const intentRelay = await IntentRelayFactory.deploy(noxComputeAddress, relayerAddress, priceOracleAddress);
  
  const tx = intentRelay.deploymentTransaction();
  console.log(`Deployment transaction submitted. Hash: ${tx?.hash}`);
  
  await intentRelay.waitForDeployment();
  const deployedAddress = await intentRelay.getAddress();

  console.log("\n=== Deployment Successful ===");
  console.log(`New IntentRelay Contract Address: ${deployedAddress}`);
  console.log(`Deployment Transaction Hash: ${tx?.hash}`);
  console.log(`Verification URL: https://sepolia.etherscan.io/address/${deployedAddress}#code`);
}

main().catch((err) => {
  console.error("Deployment failed:", err);
  process.exit(1);
});
