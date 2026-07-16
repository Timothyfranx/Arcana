import hre from "hardhat";
import { createEthersHandleClient, type SolidityType } from "@iexec-nox/handle";
import dotenv from "dotenv";

dotenv.config();

// Helper to chunk calldata
function chunkCalldata(calldataHex: string): bigint[] {
  const clean = calldataHex.startsWith("0x") ? calldataHex.slice(2) : calldataHex;
  const remainder = clean.length % 64;
  const padded = remainder === 0 ? clean : clean + "0".repeat(64 - remainder);
  const chunks: bigint[] = [];
  for (let i = 0; i < padded.length; i += 64) {
    const chunkHex = padded.slice(i, i + 64);
    chunks.push(BigInt("0x" + chunkHex));
  }
  return chunks;
}

// Helper to rebuild calldata
function rebuildCalldata(chunks: bigint[], originalLength: number): string {
  let hex = "";
  for (const chunk of chunks) {
    let chunkHex = chunk.toString(16);
    chunkHex = chunkHex.padStart(64, "0");
    hex += chunkHex;
  }
  return "0x" + hex.slice(0, originalLength * 2);
}

// ABI for IntentRelay and MockSwapContract
const INTENT_RELAY_ABI = [
  "function nextIntentId() view returns (uint256)",
  "function submitIntent(bytes32 triggerConditionHandle, uint8 compareOp, bytes32 targetHandle, bytes32[] calldataHandles, uint256 calldataLength, bytes triggerProof, bytes targetProof, bytes[] calldataProofs) external",
  "function requestTriggerCheck(uint256 intentId, bytes32 currentValueHandle, address currentValueOwner, bytes calldata currentValueProof) external",
  "function verifyTrigger(uint256 intentId, bytes calldata decryptionProof) external",
  "function markExecuted(uint256 intentId) external",
  "function intents(uint256) view returns (address owner, bytes32 triggerConditionHandle, uint8 compareOp, bytes32 targetHandle, uint256 calldataLength, uint8 status, bytes32 activeCheckHandle)",
  "function getCalldataHandles(uint256) view returns (bytes32[] memory)"
];

const MOCK_SWAP_ABI = [
  "function swap(uint256 amount) external",
  "event SwapExecuted(address indexed executor, uint256 amount)"
];

async function main() {
  const targetNetwork = "sepolia";
  const connection = await hre.network.getOrCreate(targetNetwork);
  const { ethers } = connection;
  const [wallet] = await ethers.getSigners();
  const userAddress = await wallet.getAddress();

  const intentRelayAddress = "0x9BF3f5db0442a59A074B728cD23F719D57375A9b";
  const mockSwapAddress = "0xdAC574e3B378dEdd3B8C76CAd3424d5b42283791";
  const noxComputeAddress = "0x24ef36ec5b626d7dcd09a98f3083c2758f0f77bf";
  const gatewayUrl = "https://gateway-testnets.noxprotocol.dev";

  console.log("=== Starting End-to-End Sepolia Demo ===");
  console.log(`User/Oracle/Relayer Wallet: ${userAddress}`);
  console.log(`IntentRelay Address: ${intentRelayAddress}`);
  console.log(`MockSwapContract Address: ${mockSwapAddress}`);

  // Instantiate contracts
  const intentRelay = new ethers.Contract(intentRelayAddress, INTENT_RELAY_ABI, wallet);
  const mockSwap = new ethers.Contract(mockSwapAddress, MOCK_SWAP_ABI, wallet);

  // Instantiate handle client
  const handleClient = await createEthersHandleClient(wallet, {
    smartContractAddress: noxComputeAddress,
    gatewayUrl,
    subgraphUrl: "https://thegraph.ethereum-sepolia-testnet.noxprotocol.io/api/subgraphs/id/9CsccKwvgYFo72zZeU4k4wj2NEBLdWhVE3EUandgmzgo"
  });

  // 1. Encrypt Swap parameters
  console.log("\n[Step 1] Encrypting Swap parameters client-side...");
  const triggerPrice = 100n;
  const solidityType = "uint256";

  const t0 = Date.now();
  console.log(`Encrypting trigger price: [redacted for confidentiality]`);
  const triggerSecret = await handleClient.encryptInput(triggerPrice, solidityType, intentRelayAddress);

  console.log(`Encrypting target contract: ${mockSwapAddress.slice(0, 6)}...${mockSwapAddress.slice(-4)}`);
  const targetSecret = await handleClient.encryptInput(BigInt(mockSwapAddress), solidityType, intentRelayAddress);

  const swapAmount = 333n;
  const rawCalldata = mockSwap.interface.encodeFunctionData("swap", [swapAmount]);
  const calldataBytesLength = (rawCalldata.length - 2) / 2;
  const calldataChunks = chunkCalldata(rawCalldata);

  const calldataHandles: string[] = [];
  const calldataProofs: string[] = [];
  for (let i = 0; i < calldataChunks.length; i++) {
    console.log(`Encrypting calldata chunk #${i}: [redacted for confidentiality]`);
    const chunkSecret = await handleClient.encryptInput(calldataChunks[i], solidityType, intentRelayAddress);
    calldataHandles.push(chunkSecret.handle);
    calldataProofs.push(chunkSecret.handleProof);
  }
  const t1 = Date.now();
  console.log(`Client encryption complete in ${t1 - t0}ms.`);

  // 2. Submit Intent on-chain
  console.log("\n[Step 2] Submitting Intent to IntentRelay on-chain...");
  
  // Resolve intent ID dynamically to support multiple consecutive runs on testnet
  const intentId = await intentRelay.nextIntentId();
  console.log(`Submitting intent... Expected Intent ID: ${intentId}`);

  const nonce1 = Number(await wallet.provider.send("eth_getTransactionCount", [userAddress, "latest"]));
  const submitTx = await intentRelay.submitIntent(
    triggerSecret.handle,
    0, // GE
    targetSecret.handle,
    calldataHandles,
    calldataBytesLength,
    triggerSecret.handleProof,
    targetSecret.handleProof,
    calldataProofs,
    { nonce: nonce1 }
  );
  console.log(`Submission tx sent: ${submitTx.hash}. Waiting for confirmation...`);
  await submitTx.wait();
  console.log(`Intent submitted successfully. Resolved Intent ID: ${intentId}`);

  // 3. Keeper price update (Current price = 110 >= 100, trigger met)
  console.log("\n[Step 3] Keeper encrypting current market price and submitting price check...");
  const currentPrice = 110n;
  const currentPriceSecret = await handleClient.encryptInput(currentPrice, solidityType, intentRelayAddress);

  const nonce2 = Number(await wallet.provider.send("eth_getTransactionCount", [userAddress, "latest"]));
  const checkTx = await intentRelay.requestTriggerCheck(
    intentId,
    currentPriceSecret.handle,
    userAddress,
    currentPriceSecret.handleProof,
    { nonce: nonce2 }
  );
  console.log(`requestTriggerCheck tx sent: ${checkTx.hash}. Waiting for confirmation...`);
  await checkTx.wait();
  console.log("Trigger check requested successfully.");

  const intentInfo = await intentRelay.intents(intentId);
  const activeCheckHandle = intentInfo.activeCheckHandle;
  console.log(`Active check handle: ${activeCheckHandle}`);

  // 4. Poll handle status to measure Sepolia TEE computation latency
  console.log("\n[Step 4] Polling handle Gateway for evaluation result (Unwrap Phase latency check)...");
  const apiService = (handleClient as any).apiService;
  const checkStart = Date.now();
  let decryptionProof = "";
  
  for (let i = 0; i < 180; i++) { // Poll up to 3 minutes
    try {
      const response = await apiService.get({
        endpoint: `/v0/public/${activeCheckHandle}`,
        expectedResponse: {
          types: {
            PublicDecryptionResult: [{ name: "decryptionProof", type: "string" }],
          },
          primaryType: "PublicDecryptionResult",
        },
      });
      if (response.status === 200) {
        decryptionProof = response.data.decryptionProof;
        break;
      }
    } catch {
      // Ignored, wait and retry
    }
    process.stdout.write(".");
    await new Promise((r) => setTimeout(r, 2000));
  }
  process.stdout.write("\n");

  if (!decryptionProof) {
    throw new Error("Timeout waiting for TEE computation to complete.");
  }
  const checkEnd = Date.now();
  const evaluationLatency = checkEnd - checkStart;
  console.log(`TEE computation completed! Latency: ${evaluationLatency}ms.`);

  // 5. Keeper submits verifyTrigger
  console.log("\n[Step 5] Keeper verifying trigger on-chain with decryption proof...");
  const nonce3 = Number(await wallet.provider.send("eth_getTransactionCount", [userAddress, "latest"]));
  const verifyTx = await intentRelay.verifyTrigger(intentId, decryptionProof, { nonce: nonce3 });
  console.log(`verifyTrigger tx sent: ${verifyTx.hash}. Waiting for confirmation...`);
  await verifyTx.wait();
  console.log("Trigger verified successfully.");

  const triggeredIntent = await intentRelay.intents(intentId);
  console.log(`Intent status after verification: ${triggeredIntent.status} (expected: 1 = Triggered)`);

  // 6. Relayer Decrypts and Executes Swap
  console.log("\n[Step 6] Relayer fetching and decrypting confidential execution payload...");
  const tDecStart = Date.now();
  
  // Decrypt target
  console.log("Decrypting target address handle (with retry loop for subgraph sync)...");
  let decryptedTargetAddress = "";
  const maxRetries = 15;
  for (let retry = 1; retry <= maxRetries; retry++) {
    try {
      const targetDecryption = await handleClient.decrypt(triggeredIntent.targetHandle);
      decryptedTargetAddress = "0x" + targetDecryption.value.toString(16).padStart(40, "0");
      console.log(`Decrypted target address successfully!`);
      break;
    } catch (err: any) {
      if (retry === maxRetries) {
        throw new Error(`Failed to decrypt target address after ${maxRetries} retries: ${err.message || err}`);
      }
      console.log(`[Attempt ${retry}/${maxRetries}] Decryption not yet authorized (waiting for subgraph indexing)...`);
      await new Promise((r) => setTimeout(r, 4000));
    }
  }
  console.log(`Decrypted target address: ${decryptedTargetAddress.slice(0, 6)}...${decryptedTargetAddress.slice(-4)}`);

  // Decrypt calldata chunks
  console.log("Decrypting calldata chunks...");
  const storedCalldataHandles = await intentRelay.getCalldataHandles(intentId);
  const decryptedChunks: bigint[] = [];
  for (const handle of storedCalldataHandles) {
    for (let retry = 1; retry <= maxRetries; retry++) {
      try {
        const chunkDecryption = await handleClient.decrypt(handle);
        decryptedChunks.push(chunkDecryption.value as bigint);
        break;
      } catch (err: any) {
        if (retry === maxRetries) {
          throw new Error(`Failed to decrypt calldata handle after ${maxRetries} retries: ${err.message || err}`);
        }
        console.log(`[Attempt ${retry}/${maxRetries}] Decryption not yet authorized for chunk (waiting for subgraph indexing)...`);
        await new Promise((r) => setTimeout(r, 4000));
      }
    }
  }
  const tDecEnd = Date.now();
  console.log(`Payload decrypted in ${tDecEnd - tDecStart}ms.`);

  const reassembledCalldata = rebuildCalldata(decryptedChunks, Number(triggeredIntent.calldataLength));
  console.log(`Reassembled calldata length: ${reassembledCalldata.length - 2} hex chars.`);

  // Forward swap execution
  console.log("\n[Step 7] Relayer submitting execution tx to MockSwapContract...");
  const nonce4 = Number(await wallet.provider.send("eth_getTransactionCount", [userAddress, "latest"]));
  const executeTx = await wallet.sendTransaction({
    to: decryptedTargetAddress,
    data: reassembledCalldata,
    nonce: nonce4
  });
  console.log(`Execution tx sent: ${executeTx.hash}. Waiting for confirmation...`);
  const executeReceipt = await executeTx.wait();
  console.log("Execution tx confirmed!");

  // Mark executed
  console.log("Calling markExecuted on-chain...");
  const nonce5 = Number(await wallet.provider.send("eth_getTransactionCount", [userAddress, "latest"]));
  const markTx = await intentRelay.markExecuted(intentId, { nonce: nonce5 });
  console.log(`markExecuted tx sent: ${markTx.hash}. Waiting for confirmation...`);
  await markTx.wait();
  console.log("Intent marked as Executed!");

  const finalIntent = await intentRelay.intents(intentId);
  console.log(`Final intent status: ${finalIntent.status} (expected: 2 = Executed)`);

  console.log("\n=== Sepolia Demo Run Complete ===");
  console.log(`- Off-chain Price Encryption: ${t1 - t0}ms`);
  console.log(`- TEE Async Comparison Latency: ${evaluationLatency}ms`);
  console.log(`- Off-chain Execution Payload Decryption: ${tDecEnd - tDecStart}ms`);
}

main().catch(console.error);
