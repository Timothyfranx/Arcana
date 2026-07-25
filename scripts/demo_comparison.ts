import hre from "hardhat";
import { ArcanaClient, ProtocolAdapter } from "../src/sdk/index.js";
import dotenv from "dotenv";

dotenv.config();

async function main() {
  const targetNetwork = "noxLocal";
  const connection = await hre.network.getOrCreate(targetNetwork);
  const { ethers } = connection;
  const [user, relayer, keeper] = await ethers.getSigners();

  const userAddress = await user.getAddress();
  const relayerAddress = await relayer.getAddress();
  const keeperAddress = await keeper.getAddress();

  console.log("=== Arcana Stop-Loss (LE) vs. Take-Profit (GE) Demonstration ===");
  console.log(`User: ${userAddress}`);
  console.log(`Keeper: ${keeperAddress}`);
  console.log(`Relayer: ${relayerAddress}`);

  // Deploy contracts locally
  const noxComputeAddress = "0x75C6AF4430cc474b1bb9b8540b7E46D6f8e1C685";
  const IntentRelayFactory = await ethers.getContractFactory("IntentRelay", user);
  const intentRelay = await IntentRelayFactory.deploy(noxComputeAddress, relayerAddress, keeperAddress);
  await intentRelay.waitForDeployment();
  const intentRelayAddress = await intentRelay.getAddress();

  const MockSwapFactory = await ethers.getContractFactory("MockSwapContract", user);
  const mockSwap = await MockSwapFactory.deploy();
  await mockSwap.waitForDeployment();
  const targetAddress = await mockSwap.getAddress();

  const gatewayUrl = `http://127.0.0.1:${process.env.NOX_HANDLE_GATEWAY_HOST_PORT || 32769}`;
  const client = new ArcanaClient(user, {
    intentRelayAddress,
    noxComputeAddress,
    gatewayUrl,
  });

  const rawCalldata = ProtocolAdapter.encodeCall(
    ["function swap(uint256 amount)"],
    "swap",
    [1000n]
  );

  // 1. Submit Take-Profit Intent (Price >= 3500, CompareOp.GE = 0)
  console.log("\n[Step 1] Submitting Take-Profit Intent (CompareOp.GE >= 3500)...");
  const tpParams = await client.encryptIntentParameters(targetAddress, rawCalldata, 3500n);
  const tpTx = await client.submitIntent({ ...tpParams, compareOp: 0 }); // 0 = CompareOp.GE
  await tpTx.wait();
  const tpIntentId = 0n;
  console.log(`Take-Profit Intent #0 submitted successfully!`);

  // 2. Submit Stop-Loss Intent (Price <= 2500, CompareOp.LE = 1)
  console.log("\n[Step 2] Submitting Stop-Loss Intent (CompareOp.LE <= 2500)...");
  const slParams = await client.encryptIntentParameters(targetAddress, rawCalldata, 2500n);
  const slTx = await client.submitIntent({ ...slParams, compareOp: 1 }); // 1 = CompareOp.LE
  await slTx.wait();
  const slIntentId = 1n;
  console.log(`Stop-Loss Intent #1 submitted successfully!`);

  // 3. Verify owner-indexed lookup getOwnerIntents(userAddress)
  console.log("\n[Step 3] Verifying indexed getOwnerIntents(userAddress)...");
  const userIntents = await client.intentRelayContract.getOwnerIntents(userAddress);
  console.log(`User owns ${userIntents.length} intents: [${userIntents.join(", ")}]`);

  // 4. Keeper evaluates market price at 2800 (Between 2500 and 3500 -> Neither should trigger)
  console.log("\n[Step 4] Market Price = $2,800. Checking triggers...");
  const price2800Secret = await (hre as any).nox.encryptInput(2800n, "uint256", intentRelayAddress);

  // Check TP Intent #0
  await (await intentRelay.connect(keeper).requestTriggerCheck(
    tpIntentId, price2800Secret.handle, userAddress, price2800Secret.handleProof
  )).wait();
  const tpProof2800 = await (hre as any).nox.publicDecrypt((await intentRelay.intents(tpIntentId)).activeCheckHandle);
  console.log(`  - Take-Profit (>= 3500) check result at $2800: ${tpProof2800.value} (False -> Remains Pending)`);

  // Check SL Intent #1
  await (await intentRelay.connect(keeper).requestTriggerCheck(
    slIntentId, price2800Secret.handle, userAddress, price2800Secret.handleProof
  )).wait();
  const slProof2800 = await (hre as any).nox.publicDecrypt((await intentRelay.intents(slIntentId)).activeCheckHandle);
  console.log(`  - Stop-Loss (<= 2500) check result at $2800: ${slProof2800.value} (False -> Remains Pending)`);

  // 5. Market price drops to 2200 -> Stop-Loss (<= 2500) MUST trigger!
  console.log("\n[Step 5] Market Price drops to $2,200. Checking triggers...");
  const price2200Secret = await (hre as any).nox.encryptInput(2200n, "uint256", intentRelayAddress);

  await (await intentRelay.connect(keeper).requestTriggerCheck(
    slIntentId, price2200Secret.handle, userAddress, price2200Secret.handleProof
  )).wait();
  const slProof2200 = await (hre as any).nox.publicDecrypt((await intentRelay.intents(slIntentId)).activeCheckHandle);
  console.log(`  - Stop-Loss (<= 2500) check result at $2200: ${slProof2200.value} (True -> Triggers!)`);

  await (await intentRelay.connect(keeper).verifyTrigger(slIntentId, slProof2200.decryptionProof)).wait();
  const slIntent = await intentRelay.intents(slIntentId);
  console.log(`Stop-Loss Intent #1 Status on-chain: ${slIntent.status} (1 = Triggered)`);

  console.log("\n=== Stop-Loss (LE) vs. Take-Profit (GE) Demonstration Completed Successfully ===");
}

main().catch((err) => {
  console.error("Demo failed:", err);
  process.exit(1);
});
