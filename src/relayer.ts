import { ethers } from "ethers";
import { createEthersHandleClient } from "@iexec-nox/handle";
import dotenv from "dotenv";

dotenv.config();

// ABI for IntentRelay
const INTENT_RELAY_ABI = [
  "event IntentTriggered(uint256 indexed intentId, bytes32 indexed targetHandle, bytes32[] calldataHandles)",
  "function intents(uint256) view returns (address owner, bytes32 triggerConditionHandle, uint8 compareOp, bytes32 targetHandle, uint256 calldataLength, uint8 status, bytes32 activeCheckHandle)",
  "function getCalldataHandles(uint256) view returns (bytes32[] memory)",
  "function markExecuted(uint256) external"
];

// Helper to rebuild calldata from decrypted uint256 chunks
function rebuildCalldata(chunks: bigint[], originalLength: number): string {
  let hex = "";
  for (const chunk of chunks) {
    let chunkHex = chunk.toString(16);
    chunkHex = chunkHex.padStart(64, "0");
    hex += chunkHex;
  }
  return "0x" + hex.slice(0, originalLength * 2);
}

async function main() {
  const rpcUrl = process.env.RPC_URL || "http://127.0.0.1:8545";
  const privateKey = process.env.RELAYER_PRIVATE_KEY;
  const intentRelayAddress = process.env.INTENT_RELAY_ADDRESS;
  const noxComputeAddress = process.env.NOX_COMPUTE_ADDRESS;
  const gatewayUrl = process.env.GATEWAY_URL || (process.env.NOX_HANDLE_GATEWAY_HOST_PORT ? `http://127.0.0.1:${process.env.NOX_HANDLE_GATEWAY_HOST_PORT}` : undefined);

  if (!privateKey) {
    console.error("Error: RELAYER_PRIVATE_KEY environment variable is required.");
    process.exit(1);
  }
  if (!intentRelayAddress) {
    console.error("Error: INTENT_RELAY_ADDRESS environment variable is required.");
    process.exit(1);
  }
  if (!noxComputeAddress) {
    console.error("Error: NOX_COMPUTE_ADDRESS environment variable is required.");
    process.exit(1);
  }
  if (!gatewayUrl) {
    console.error("Error: GATEWAY_URL or NOX_HANDLE_GATEWAY_HOST_PORT environment variable is required.");
    process.exit(1);
  }

  console.log("Starting Arcana Relayer Service...");
  console.log(`RPC URL: ${rpcUrl}`);
  console.log(`IntentRelay Contract: ${intentRelayAddress}`);
  console.log(`NoxCompute Contract: ${noxComputeAddress}`);
  console.log(`Handle Gateway: ${gatewayUrl}`);

  const provider = new ethers.JsonRpcProvider(rpcUrl);
  const wallet = new ethers.Wallet(privateKey, provider);
  const relayerAddress = await wallet.getAddress();
  console.log(`Relayer Wallet Address: ${relayerAddress}`);

  // Instantiate contract
  const intentRelay = new ethers.Contract(intentRelayAddress, INTENT_RELAY_ABI, wallet);

  // Instantiate handle client
  const handleClient = await createEthersHandleClient(wallet, {
    smartContractAddress: noxComputeAddress,
    gatewayUrl,
    subgraphUrl: "https://example.com/subgraphs/id/none"
  });

  console.log("Listening for IntentTriggered events...");

  intentRelay.on("IntentTriggered", async (intentId: bigint, targetHandle: string, calldataHandles: string[], event: any) => {
    const txHash = event.log.transactionHash;
    console.log(`\n[Event] IntentTriggered detected: Intent ID ${intentId} (Tx: ${txHash})`);

    try {
      // 1. Fetch intent details to get calldataLength
      console.log(`Fetching details for intent ID ${intentId}...`);
      const intentDetails = await intentRelay.intents(intentId);
      // Struct returns fields in order: owner, triggerConditionHandle, compareOp, targetHandle, calldataLength, status, activeCheckHandle
      const calldataLength = Number(intentDetails[4]);
      console.log(`Expected calldata length: ${calldataLength} bytes`);

      // 2. Decrypt target contract address
      console.log("Decrypting target address handle...");
      const targetDecryption = await handleClient.decrypt(targetHandle);
      const decryptedTargetAddress = "0x" + targetDecryption.value.toString(16).padStart(40, "0");
      console.log(`Decrypted target address: ${decryptedTargetAddress.slice(0, 6)}...${decryptedTargetAddress.slice(-4)}`);

      // 3. Decrypt calldata chunks
      console.log(`Decrypting ${calldataHandles.length} calldata chunk(s)...`);
      const decryptedChunks: bigint[] = [];
      for (let i = 0; i < calldataHandles.length; i++) {
        console.log(`Decrypting chunk #${i}...`);
        const chunkDecryption = await handleClient.decrypt(calldataHandles[i]);
        decryptedChunks.push(chunkDecryption.value as bigint);
      }

      // Reassemble original calldata bytes
      const rebuiltCalldata = rebuildCalldata(decryptedChunks, calldataLength);
      console.log(`Reassembled calldata: [redacted for confidentiality, length: ${rebuiltCalldata.length - 2} hex chars]`);

      // 4. Forward transaction to the target protocol
      console.log(`Submitting execution transaction to target: ${decryptedTargetAddress.slice(0, 6)}...${decryptedTargetAddress.slice(-4)}...`);
      const nonce1 = Number(await provider.send("eth_getTransactionCount", [relayerAddress, "latest"]));
      const executionTx = await wallet.sendTransaction({
        to: decryptedTargetAddress,
        data: rebuiltCalldata,
        nonce: nonce1,
      });
      console.log(`Transaction sent: ${executionTx.hash}. Waiting for confirmation...`);
      const receipt = await executionTx.wait();
      console.log(`Transaction confirmed in block ${receipt!.blockNumber}!`);

      // 5. Mark intent as executed on-chain
      console.log(`Calling markExecuted for intent ID ${intentId} on-chain...`);
      const nonce2 = Number(await provider.send("eth_getTransactionCount", [relayerAddress, "latest"]));
      const markTx = await intentRelay.markExecuted(intentId, { nonce: nonce2 });
      console.log(`Mark transaction sent: ${markTx.hash}. Waiting for confirmation...`);
      await markTx.wait();
      console.log(`Intent ID ${intentId} marked as Executed successfully!`);

    } catch (err: any) {
      console.error(`Error processing trigger for intent ID ${intentId}:`, err.message || err);
    }
  });

  // Keep process alive
  process.on("SIGINT", () => {
    console.log("Shutting down relayer service...");
    process.exit(0);
  });
}

main().catch((err) => {
  console.error("Fatal error in relayer service:", err);
  process.exit(1);
});
