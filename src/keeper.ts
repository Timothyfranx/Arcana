import { ethers } from "ethers";
import { ArcanaClient } from "./sdk/index.js";
import dotenv from "dotenv";

dotenv.config();

async function main() {
  const rpcUrl = process.env.RPC_URL || "http://127.0.0.1:8545";
  const privateKey = process.env.KEEPER_PRIVATE_KEY;
  const intentRelayAddress = process.env.INTENT_RELAY_ADDRESS;
  const noxComputeAddress = process.env.NOX_COMPUTE_ADDRESS;
  const gatewayUrl = process.env.GATEWAY_URL || (process.env.NOX_HANDLE_GATEWAY_HOST_PORT ? `http://127.0.0.1:${process.env.NOX_HANDLE_GATEWAY_HOST_PORT}` : undefined);
  const subgraphUrl = process.env.SUBGRAPH_URL;
  const pollInterval = Number(process.env.POLL_INTERVAL_MS || "15000");

  if (!privateKey) {
    console.error("Error: KEEPER_PRIVATE_KEY environment variable is required.");
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

  // Current market price to evaluate
  const currentPrice = BigInt(process.env.MOCK_PRICE || "110");

  console.log("Starting Arcana Keeper Service...");
  console.log(`RPC URL: ${rpcUrl}`);
  console.log(`IntentRelay Contract: ${intentRelayAddress}`);
  console.log(`NoxCompute Contract: ${noxComputeAddress}`);
  console.log(`Handle Gateway: ${gatewayUrl}`);
  console.log(`Mock Price: ${currentPrice}`);

  const provider = new ethers.JsonRpcProvider(rpcUrl);
  const wallet = new ethers.Wallet(privateKey, provider);
  const keeperAddress = await wallet.getAddress();
  console.log(`Keeper Wallet Address: ${keeperAddress}`);

  // Initialize Arcana SDK Client
  const client = new ArcanaClient(wallet, {
    intentRelayAddress,
    noxComputeAddress,
    gatewayUrl,
    subgraphUrl
  });

  const CHAINLINK_ETH_USD_SEPOLIA = "0x694AA1769357215DE4FAC081bf1f309aDC325306";
  const CHAINLINK_ABI = [
    "function latestRoundData() external view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)",
    "function decimals() external view returns (uint8)"
  ];

  const runLoop = async () => {
    try {
      let currentPrice = BigInt(process.env.MOCK_PRICE || "110");
      if (!isLocal || process.env.USE_CHAINLINK === "true") {
        try {
          const chainlink = new ethers.Contract(CHAINLINK_ETH_USD_SEPOLIA, CHAINLINK_ABI, provider);
          const roundData = await chainlink.latestRoundData();
          const decimals = Number(await chainlink.decimals());
          const rawPrice = roundData.answer as bigint;
          const divisor = 10n ** BigInt(decimals);
          currentPrice = rawPrice / divisor; // Dynamically convert decimals to USD integer
          console.log(`[Chainlink Oracle] Fetched real-time Sepolia ETH/USD price: $${currentPrice} (${decimals} decimals)`);
        } catch (err: any) {
          console.warn(`[Chainlink Oracle] Fallback to mock price due to fetch error: ${err.message || err}`);
        }
      }

      const nextId = await client.intentRelayContract.nextIntentId();
      console.log(`Checking intents (0 to ${nextId - 1n})...`);

      for (let intentId = 0n; intentId < nextId; intentId++) {
        const intent = await client.intentRelayContract.intents(intentId);
        // owner, triggerConditionHandle, compareOp, targetHandle, calldataLength, status, activeCheckHandle
        const status = Number(intent.status);
        const activeCheckHandle = intent.activeCheckHandle;

        if (status === 0) { // Status.Pending
          console.log(`\n[Intent #${intentId}] Status: Pending.`);

          if (activeCheckHandle !== ethers.ZeroHash) {
            // There is an active check handle, let's see if we can resolve it
            console.log(`Active check handle exists: ${activeCheckHandle}. Fetching decryption proof...`);
            try {
              // Poll for decryption proof (max 3 attempts to avoid blocking the main interval loop)
              const proof = await client.pollDecryptionProof(activeCheckHandle, 3);
              console.log(`Proof found. Submitting verifyTrigger on-chain...`);
              
              const nonce = Number(await provider.send("eth_getTransactionCount", [keeperAddress, "latest"]));
              const tx = await client.verifyTrigger(intentId, proof, nonce);
              console.log(`verifyTrigger sent: ${tx.hash}. Waiting for confirmation...`);
              await tx.wait();
              console.log(`verifyTrigger confirmed!`);
            } catch (err: any) {
              console.log(`Proof not yet available or failed: ${err.message || err}`);
            }
          } else {
            // No active check handle, let's request a trigger check
            console.log(`Encrypting current market price: ${currentPrice}...`);
            const nonce = Number(await provider.send("eth_getTransactionCount", [keeperAddress, "latest"]));
            const { tx, currentPriceSecret } = await client.requestTriggerCheck(
              intentId,
              currentPrice,
              keeperAddress,
              nonce
            );
            console.log(`Encrypted. Handle: ${currentPriceSecret.handle}`);
            console.log(`Requesting trigger check for intent #${intentId}...`);
            console.log(`requestTriggerCheck sent: ${tx.hash}. Waiting for confirmation...`);
            await tx.wait();
            console.log(`Trigger check requested successfully!`);
          }
        }
      }
    } catch (err: any) {
      console.error("Error in keeper loop execution:", err.message || err);
    }
  };

  // Run immediately then on interval
  await runLoop();
  const interval = setInterval(runLoop, pollInterval);

  process.on("SIGINT", () => {
    console.log("Shutting down keeper service...");
    clearInterval(interval);
    process.exit(0);
  });
}

main().catch((err) => {
  console.error("Fatal error in keeper service:", err);
  process.exit(1);
});
