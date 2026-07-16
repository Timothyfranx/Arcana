import { ethers } from "ethers";
import { createEthersHandleClient, type SolidityType } from "@iexec-nox/handle";
import dotenv from "dotenv";

dotenv.config();

// ABI for IntentRelay
const INTENT_RELAY_ABI = [
  "function nextIntentId() view returns (uint256)",
  "function intents(uint256) view returns (address owner, bytes32 triggerConditionHandle, uint8 compareOp, bytes32 targetHandle, uint256 calldataLength, uint8 status, bytes32 activeCheckHandle)",
  "function requestTriggerCheck(uint256 intentId, bytes32 currentValueHandle, address currentValueOwner, bytes calldata currentValueProof) external",
  "function verifyTrigger(uint256 intentId, bytes calldata decryptionProof) external"
];

// Helper to poll gateway for public decryption result
async function waitForHandleResolved(apiService: any, handle: string): Promise<any> {
  const getResult = async () => {
    const response = await apiService.get({
      endpoint: `/v0/public/${handle}`,
      expectedResponse: {
        types: {
          PublicDecryptionResult: [{ name: "decryptionProof", type: "string" }],
        },
        primaryType: "PublicDecryptionResult",
      },
    });
    if (response.status === 404) {
      throw new Error("Handle not yet computed");
    }
    return response.data;
  };

  for (let i = 0; i < 30; i++) {
    try {
      return await getResult();
    } catch {
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
  throw new Error(`Timeout waiting for handle ${handle} to be resolved`);
}

async function main() {
  const rpcUrl = process.env.RPC_URL || "http://127.0.0.1:8545";
  const privateKey = process.env.KEEPER_PRIVATE_KEY;
  const intentRelayAddress = process.env.INTENT_RELAY_ADDRESS;
  const noxComputeAddress = process.env.NOX_COMPUTE_ADDRESS;
  const gatewayUrl = process.env.GATEWAY_URL || (process.env.NOX_HANDLE_GATEWAY_HOST_PORT ? `http://127.0.0.1:${process.env.NOX_HANDLE_GATEWAY_HOST_PORT}` : undefined);
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

  const intentRelay = new ethers.Contract(intentRelayAddress, INTENT_RELAY_ABI, wallet);

  // Instantiate handle client
  const handleClient = await createEthersHandleClient(wallet, {
    smartContractAddress: noxComputeAddress,
    gatewayUrl,
    subgraphUrl: "https://example.com/subgraphs/id/none"
  });

  // Query private api service from handle client for manual polling
  // handleClient contains handleClient.apiService
  const apiService = (handleClient as any).apiService;

  const runLoop = async () => {
    try {
      const nextId = await intentRelay.nextIntentId();
      console.log(`Checking intents (0 to ${nextId - 1n})...`);

      for (let intentId = 0n; intentId < nextId; intentId++) {
        const intent = await intentRelay.intents(intentId);
        // owner, triggerConditionHandle, compareOp, targetHandle, calldataLength, status, activeCheckHandle
        const status = Number(intent[5]);
        const activeCheckHandle = intent[6];

        if (status === 0) { // Status.Pending
          console.log(`\n[Intent #${intentId}] Status: Pending.`);

          if (activeCheckHandle !== ethers.ZeroHash) {
            // There is an active check handle, let's see if we can resolve it
            console.log(`Active check handle exists: ${activeCheckHandle}. Fetching decryption proof...`);
            try {
              const res = await waitForHandleResolved(apiService, activeCheckHandle);
              const proof = res.decryptionProof;
              console.log(`Proof found. Submitting verifyTrigger on-chain...`);
              
              const nonce = Number(await provider.send("eth_getTransactionCount", [keeperAddress, "latest"]));
              const tx = await intentRelay.verifyTrigger(intentId, proof, { nonce });
              console.log(`verifyTrigger sent: ${tx.hash}. Waiting for confirmation...`);
              await tx.wait();
              console.log(`verifyTrigger confirmed!`);
            } catch (err: any) {
              console.log(`Proof not yet available or failed: ${err.message || err}`);
            }
          } else {
            // No active check handle, let's request a trigger check
            console.log(`Encrypting current market price: ${currentPrice}...`);
            const priceSecret = await handleClient.encryptInput(currentPrice, "uint256", intentRelayAddress);
            console.log(`Encrypted. Handle: ${priceSecret.handle}`);

            console.log(`Requesting trigger check for intent #${intentId}...`);
            const nonce = Number(await provider.send("eth_getTransactionCount", [keeperAddress, "latest"]));
            const tx = await intentRelay.requestTriggerCheck(
              intentId,
              priceSecret.handle,
              keeperAddress,
              priceSecret.handleProof,
              { nonce }
            );
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
