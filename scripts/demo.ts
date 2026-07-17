import hre from "hardhat";
import { ArcanaClient } from "../src/sdk/index.js";
import dotenv from "dotenv";

dotenv.config();

const MOCK_SWAP_ABI = [
  "function swap(uint256 amount) external",
  "event SwapExecuted(address indexed executor, uint256 amount)"
];

async function main() {
  if (!process.env.PRIVATE_KEY) {
    console.error("Error: PRIVATE_KEY environment variable is required in .env for Sepolia execution.");
    process.exit(1);
  }

  const targetNetwork = "sepolia";
  const connection = await hre.network.getOrCreate(targetNetwork);
  const { ethers } = connection;
  const [wallet] = await ethers.getSigners();
  const userAddress = await wallet.getAddress();

  const intentRelayAddress = "0x9BF3f5db0442a59A074B728cD23F719D57375A9b";
  const mockSwapAddress = "0xdAC574e3B378dEdd3B8C76CAd3424d5b42283791";
  const noxComputeAddress = "0x24ef36ec5b626d7dcd09a98f3083c2758f0f77bf";
  const gatewayUrl = "https://gateway-testnets.noxprotocol.dev";
  const subgraphUrl = "https://thegraph.ethereum-sepolia-testnet.noxprotocol.io/api/subgraphs/id/9CsccKwvgYFo72zZeU4k4wj2NEBLdWhVE3EUandgmzgo";

  console.log("=== Starting End-to-End Sepolia Demo ===");
  console.log(`User/Oracle/Relayer Wallet: ${userAddress}`);
  console.log(`IntentRelay Address: ${intentRelayAddress}`);
  console.log(`MockSwapContract Address: ${mockSwapAddress}`);

  const mockSwap = new ethers.Contract(mockSwapAddress, MOCK_SWAP_ABI, wallet);

  // Initialize Arcana SDK Client
  const client = new ArcanaClient(wallet, {
    intentRelayAddress,
    noxComputeAddress,
    gatewayUrl,
    subgraphUrl
  });

  // 1. Encrypt Swap parameters
  console.log("\n[Step 1] Encrypting Swap parameters client-side...");
  const triggerPrice = 100n;
  
  const swapAmount = 333n;
  const rawCalldata = mockSwap.interface.encodeFunctionData("swap", [swapAmount]);

  const t0 = Date.now();
  console.log(`Encrypting trigger price: [redacted for confidentiality]`);
  console.log(`Encrypting target contract: ${mockSwapAddress.slice(0, 6)}...${mockSwapAddress.slice(-4)}`);
  console.log(`Encrypting calldata chunks: [redacted for confidentiality]`);

  const encryptedParams = await client.encryptIntentParameters(mockSwapAddress, rawCalldata, triggerPrice);
  const t1 = Date.now();
  console.log(`Client encryption complete in ${t1 - t0}ms.`);

  // 2. Submit Intent on-chain
  console.log("\n[Step 2] Submitting Intent to IntentRelay on-chain...");
  const intentId = await client.intentRelayContract.nextIntentId();
  console.log(`Submitting intent... Expected Intent ID: ${intentId}`);

  const nonce1 = Number(await wallet.provider.send("eth_getTransactionCount", [userAddress, "latest"]));
  const submitTx = await client.submitIntent({
    ...encryptedParams,
    nonce: nonce1
  });
  console.log(`Submission tx sent: ${submitTx.hash}. Waiting for confirmation...`);
  await submitTx.wait();
  console.log(`Intent submitted successfully. Resolved Intent ID: ${intentId}`);

  // 3. Keeper price update (Current price = 110 >= 100, trigger met)
  console.log("\n[Step 3] Keeper encrypting current market price and submitting price check...");
  const currentPrice = 110n;
  const nonce2 = Number(await wallet.provider.send("eth_getTransactionCount", [userAddress, "latest"]));
  const { tx: checkTx } = await client.requestTriggerCheck(
    intentId,
    currentPrice,
    userAddress,
    nonce2
  );
  console.log(`requestTriggerCheck tx sent: ${checkTx.hash}. Waiting for confirmation...`);
  await checkTx.wait();
  console.log("Trigger check requested successfully.");

  const intentInfo = await client.intentRelayContract.intents(intentId);
  const activeCheckHandle = intentInfo.activeCheckHandle;
  console.log(`Active check handle: ${activeCheckHandle}`);

  // 4. Poll handle status to measure Sepolia TEE computation latency
  console.log("\n[Step 4] Polling handle Gateway for evaluation result (Unwrap Phase latency check)...");
  const checkStart = Date.now();
  const decryptionProof = await client.pollDecryptionProof(activeCheckHandle);
  const checkEnd = Date.now();
  const evaluationLatency = checkEnd - checkStart;
  console.log(`TEE computation completed! Latency: ${evaluationLatency}ms.`);

  // 5. Keeper submits verifyTrigger
  console.log("\n[Step 5] Keeper verifying trigger on-chain with decryption proof...");
  const nonce3 = Number(await wallet.provider.send("eth_getTransactionCount", [userAddress, "latest"]));
  const verifyTx = await client.verifyTrigger(intentId, decryptionProof, nonce3);
  console.log(`verifyTrigger tx sent: ${verifyTx.hash}. Waiting for confirmation...`);
  await verifyTx.wait();
  console.log("Trigger verified successfully.");

  const triggeredIntent = await client.intentRelayContract.intents(intentId);
  console.log(`Intent status after verification: ${triggeredIntent.status} (expected: 1 = Triggered)`);

  // 6. Relayer Decrypts and Executes Swap
  console.log("\n[Step 6] Relayer fetching and decrypting confidential execution payload...");
  const tDecStart = Date.now();
  const { targetAddress: decryptedTargetAddress, calldata: reassembledCalldata } = await client.decryptExecutionPayload(intentId);
  const tDecEnd = Date.now();
  console.log(`Payload decrypted in ${tDecEnd - tDecStart}ms.`);
  console.log(`Decrypted target address: ${decryptedTargetAddress.slice(0, 6)}...${decryptedTargetAddress.slice(-4)}`);
  console.log(`Reassembled calldata length: ${reassembledCalldata.length - 2} hex chars.`);

  // 7. Relayer submitting execution tx to MockSwapContract
  console.log("\n[Step 7] Relayer submitting execution tx to MockSwapContract...");
  const nonce4 = Number(await wallet.provider.send("eth_getTransactionCount", [userAddress, "latest"]));
  const executeTx = await wallet.sendTransaction({
    to: decryptedTargetAddress,
    data: reassembledCalldata,
    nonce: nonce4
  });
  console.log(`Execution tx sent: ${executeTx.hash}. Waiting for confirmation...`);
  await executeTx.wait();
  console.log("Execution tx confirmed!");

  // Mark executed
  console.log("Calling markExecuted on-chain...");
  const nonce5 = Number(await wallet.provider.send("eth_getTransactionCount", [userAddress, "latest"]));
  const markTx = await client.markExecuted(intentId, nonce5);
  console.log(`markExecuted tx sent: ${markTx.hash}. Waiting for confirmation...`);
  await markTx.wait();
  console.log("Intent marked as Executed!");

  const finalIntent = await client.intentRelayContract.intents(intentId);
  console.log(`Final intent status: ${finalIntent.status} (expected: 2 = Executed)`);

  console.log("\n=== Sepolia Demo Run Complete ===");
  console.log(`- Off-chain Price Encryption: ${t1 - t0}ms`);
  console.log(`- TEE Async Comparison Latency: ${evaluationLatency}ms`);
  console.log(`- Off-chain Execution Payload Decryption: ${tDecEnd - tDecStart}ms`);
}

main().catch(console.error);
