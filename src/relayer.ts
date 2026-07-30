import { ethers } from "ethers";
import { ArcanaClient } from "./sdk/index.js";
import dotenv from "dotenv";

dotenv.config();

async function main() {
  const rpcUrl = process.env.RPC_URL || "http://127.0.0.1:8545";
  const privateKey = process.env.RELAYER_PRIVATE_KEY;
  const intentRelayAddress = process.env.INTENT_RELAY_ADDRESS;
  const noxComputeAddress = process.env.NOX_COMPUTE_ADDRESS;
  const gatewayUrl = process.env.GATEWAY_URL || (process.env.NOX_HANDLE_GATEWAY_HOST_PORT ? `http://127.0.0.1:${process.env.NOX_HANDLE_GATEWAY_HOST_PORT}` : undefined);
  const subgraphUrl = process.env.SUBGRAPH_URL;

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

  const isLocal = rpcUrl.includes("127.0.0.1") || rpcUrl.includes("localhost");
  if (!isLocal && !subgraphUrl) {
    console.error("Error: SUBGRAPH_URL environment variable is required for non-local networks.");
    process.exit(1);
  }

  console.log("Starting Arcana Relayer Service...");
  console.log(`RPC URL: ${rpcUrl}`);
  console.log(`IntentRelay Contract: ${intentRelayAddress}`);
  console.log(`NoxCompute Contract: ${noxComputeAddress}`);
  console.log(`Handle Gateway: ${gatewayUrl}`);

  const providerOptions = { staticNetwork: true, batchMaxCount: 1 };
  const provider = new ethers.JsonRpcProvider(rpcUrl, undefined, providerOptions);

  const wallet = new ethers.Wallet(privateKey, provider);
  const relayerAddress = await wallet.getAddress();
  console.log(`Relayer Wallet Address: ${relayerAddress}`);

  const privateMempoolUrl = isLocal ? undefined : process.env.PRIVATE_MEMPOOL_RPC_URL;
  const dispatchProvider = privateMempoolUrl ? new ethers.JsonRpcProvider(privateMempoolUrl, undefined, providerOptions) : provider;
  const dispatchWallet = new ethers.Wallet(privateKey, dispatchProvider);

  if (privateMempoolUrl) {
    console.log(`Private Mempool Protection Enabled: Routing relayer txs through ${privateMempoolUrl}`);
  }

  // Initialize Arcana SDK Client
  const client = new ArcanaClient(dispatchWallet, {
    intentRelayAddress,
    noxComputeAddress,
    gatewayUrl,
    subgraphUrl
  });

  console.log("Listening for IntentTriggered events & scanning on-chain Triggered intents...");

  const processedIntents = new Set<string>();
  let lastCheckedBlock = await provider.getBlockNumber();

  const processSingleIntent = async (intentId: bigint) => {
    const intentKey = intentId.toString();
    if (processedIntents.has(intentKey)) return;
    processedIntents.add(intentKey);

    console.log(`\n[Relayer] Processing Triggered Intent ID ${intentId}...`);
    try {
      // 1. Fetch, decrypt, and reassemble execution payload using SDK Client
      console.log(`Fetching and decrypting confidential payload for intent ID ${intentId}...`);
      const { targetAddress: decryptedTargetAddress, calldata: rebuiltCalldata } = 
        await client.decryptExecutionPayload(intentId);

      console.log(`Decrypted target address: ${decryptedTargetAddress.slice(0, 6)}...${decryptedTargetAddress.slice(-4)}`);
      console.log(`Reassembled calldata: [redacted for confidentiality, length: ${rebuiltCalldata.length - 2} hex chars]`);

      // 2. Forward transaction to the target protocol
      console.log(`Submitting execution transaction to target: ${decryptedTargetAddress.slice(0, 6)}...${decryptedTargetAddress.slice(-4)}...`);
      const nonce1 = await provider.getTransactionCount(relayerAddress, "pending");
      const executionTx = await dispatchWallet.sendTransaction({
        to: decryptedTargetAddress,
        data: rebuiltCalldata,
        nonce: nonce1,
      });
      console.log(`Transaction sent: ${executionTx.hash}. Waiting for confirmation...`);
      const receipt = await executionTx.wait();
      console.log(`Transaction confirmed in block ${receipt!.blockNumber}!`);

      // 3. Mark intent as executed on-chain using SDK Client
      console.log(`Calling markExecuted for intent ID ${intentId} on-chain...`);
      const nonce2 = await provider.getTransactionCount(relayerAddress, "pending");
      const markTx = await client.markExecuted(intentId, nonce2);
      console.log(`Mark transaction sent: ${markTx.hash}. Waiting for confirmation...`);
      await markTx.wait();
      console.log(`Intent ID ${intentId} marked as Executed successfully!`);

    } catch (err: any) {
      console.error(`Error processing trigger for intent ID ${intentId}:`, err.message || err);
      // Call markExecuted so stale/invalid intents (e.g. expired Safe nonces) do not block the relayer loop
      try {
        console.log(`Cleaning up intent ID ${intentId} on-chain via markExecuted...`);
        const cleanupNonce = await provider.getTransactionCount(relayerAddress, "pending");
        const markTx = await client.markExecuted(intentId, cleanupNonce);
        await markTx.wait();
        console.log(`Intent ID ${intentId} marked as Executed/Cleaned up on-chain!`);
      } catch (markErr: any) {
        console.error(`Failed to mark intent ID ${intentId} as executed:`, markErr.message || markErr);
      }
    }
  };

  const pollTriggerEvents = async () => {
    try {
      // 1. On-Chain State Scan for any intent in Status.Triggered (1)
      const nextId = await client.intentRelayContract.nextIntentId();
      for (let id = 0n; id < nextId; id++) {
        const intent = await client.intentRelayContract.intents(id);
        if (Number(intent.status) === 1) { // Status.Triggered
          await processSingleIntent(id);
        }
      }

      // 2. Event Log Filter Scan
      const currentBlock = await provider.getBlockNumber();
      if (currentBlock >= lastCheckedBlock) {
        const filter = client.intentRelayContract.filters.IntentTriggered();
        const events = await client.intentRelayContract.queryFilter(filter, lastCheckedBlock, currentBlock);

        for (const event of events) {
          const log = event as any;
          const intentId: bigint = log.args[0];
          await processSingleIntent(intentId);
        }
        lastCheckedBlock = currentBlock + 1;
      }
    } catch {
      // Suppress transient RPC network errors during polling
    }
  };

  setInterval(pollTriggerEvents, 2000);
  await pollTriggerEvents();

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
