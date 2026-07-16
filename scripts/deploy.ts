import hre from "hardhat";

async function main() {
  const targetNetworkName = (hre as any).globalOptions?.network || hre.network?.name || "default";
  console.log(`Resolved target network name: ${targetNetworkName}`);

  const connection = await hre.network.getOrCreate(targetNetworkName);
  const { ethers } = connection;
  const [deployer] = await ethers.getSigners();
  const deployerAddress = await deployer.getAddress();
  console.log(`Deploying contracts with deployer: ${deployerAddress} on network: ${targetNetworkName}`);

  let noxComputeAddress = "";
  if (targetNetworkName === "arbitrumSepolia") {
    noxComputeAddress = "0xd464B198f06756a1d00be223634b85E0a731c229";
  } else if (targetNetworkName === "sepolia") {
    noxComputeAddress = "0x24ef36ec5b626d7dcd09a98f3083c2758f0f77bf";
  } else if (targetNetworkName === "noxLocal" || targetNetworkName === "localhost" || targetNetworkName === "default") {
    noxComputeAddress = "0x75C6AF4430cc474b1bb9b8540b7E46D6f8e1C685";
  } else {
    throw new Error(`Unsupported network: ${targetNetworkName}. Please configure noxComputeAddress.`);
  }

  console.log(`Using NoxCompute at: ${noxComputeAddress}`);

  // Deploy MockSwapContract
  console.log("Deploying MockSwapContract...");
  const MockSwapContract = await ethers.getContractFactory("MockSwapContract");
  const mockSwapContract = await MockSwapContract.deploy();
  await mockSwapContract.waitForDeployment();
  const mockSwapAddress = await mockSwapContract.getAddress();
  console.log(`MockSwapContract deployed at: ${mockSwapAddress}`);

  // Deploy IntentRelay
  console.log("Deploying IntentRelay...");
  const IntentRelay = await ethers.getContractFactory("IntentRelay");
  const intentRelay = await IntentRelay.deploy(
    noxComputeAddress,
    deployerAddress, // relayer
    deployerAddress  // priceOracle
  );
  await intentRelay.waitForDeployment();
  const intentRelayAddress = await intentRelay.getAddress();
  console.log(`IntentRelay deployed at: ${intentRelayAddress}`);

  console.log("\nDeployment complete!");
  console.log("-------------------");
  console.log(`IntentRelay: ${intentRelayAddress}`);
  console.log(`MockSwapContract: ${mockSwapAddress}`);
  console.log(`NoxCompute: ${noxComputeAddress}`);
}

main().catch(console.error);
