import hre from "hardhat";
import { ArcanaClient, ProtocolAdapter } from "../src/sdk/index.js";
import dotenv from "dotenv";

dotenv.config();

// ABI for Gnosis Safe Proxy
const SAFE_ABI = [
  "function nonce() view returns (uint256)",
  "function getTransactionHash(address to, uint256 value, bytes calldata data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address refundReceiver, uint256 _nonce) view returns (bytes32)",
  "function execTransaction(address to, uint256 value, bytes calldata data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address payable refundReceiver, bytes calldata signatures) external returns (bool success)",
  "event ExecutionSuccess(bytes32 txHash, uint256 payment)"
];

async function main() {
  if (!process.env.PRIVATE_KEY) {
    console.error("Error: PRIVATE_KEY environment variable is required.");
    process.exit(1);
  }

  const targetNetwork = "sepolia";
  const connection = await hre.network.getOrCreate(targetNetwork);
  const { ethers } = connection;
  const [wallet] = await ethers.getSigners();
  const walletAddress = await wallet.getAddress();

  const intentRelayAddress = "0x9BF3f5db0442a59A074B728cD23F719D57375A9b";
  const noxComputeAddress = "0x24ef36ec5b626d7dcd09a98f3083c2758f0f77bf";
  const gatewayUrl = "https://gateway-testnets.noxprotocol.dev";
  const subgraphUrl = "https://thegraph.ethereum-sepolia-testnet.noxprotocol.io/api/subgraphs/id/9CsccKwvgYFo72zZeU4k4wj2NEBLdWhVE3EUandgmzgo";
  
  const safeAddress = "0xC40ec2fD95830F37D5744489018693031c8AC6eE";

  console.log("=== Starting End-to-End Gnosis Safe Sepolia Demo ===");
  console.log(`Wallet Address: ${walletAddress}`);
  console.log(`Gnosis Safe Proxy Address: ${safeAddress}`);

  const safeContract = new ethers.Contract(safeAddress, SAFE_ABI, wallet);

  // Initialize Arcana SDK Client
  const client = new ArcanaClient(wallet, {
    intentRelayAddress,
    noxComputeAddress,
    gatewayUrl,
    subgraphUrl
  });

  // 1. Fund the Safe Proxy with a small amount of ETH if needed
  console.log("\n[Step 1] Checking Gnosis Safe balance and funding if necessary...");
  const safeBalance = await wallet.provider.getBalance(safeAddress);
  console.log(`Current Gnosis Safe balance: ${ethers.formatEther(safeBalance)} ETH`);

  if (safeBalance < ethers.parseEther("0.003")) {
    console.log("Funding Gnosis Safe with 0.005 ETH...");
    const nonce = Number(await wallet.provider.send("eth_getTransactionCount", [walletAddress, "latest"]));
    const fundTx = await wallet.sendTransaction({
      to: safeAddress,
      value: ethers.parseEther("0.005"),
      nonce
    });
    console.log(`Funding transaction sent: ${fundTx.hash}. Waiting for confirmation...`);
    await fundTx.wait();
    console.log("Gnosis Safe successfully funded!");
  } else {
    console.log("Gnosis Safe already has sufficient balance.");
  }

  // 2. Construct Safe Payout Transaction parameters via SDK ProtocolAdapter
  console.log("\n[Step 2] Constructing Safe transaction and generating EOA owner signature via ProtocolAdapter...");
  const recipient = walletAddress; // Send ETH back to balance
  const transferAmount = ethers.parseEther("0.001");

  const { calldata: execCalldata, safeNonce } = await ProtocolAdapter.buildSafeTransaction({
    safeAddress,
    recipient,
    amount: transferAmount,
    signer: wallet
  });
  console.log(`Generated Safe payout calldata for nonce ${safeNonce}. Size: ${ethers.getBytes(execCalldata).length} bytes`);
  console.log(`Encoded Safe execTransaction calldata size: ${(execCalldata.length - 2) / 2} bytes`);

  // 3. Encrypt Safe parameters via Arcana SDK Client
  console.log("\n[Step 3] Encrypting Safe transaction parameters client-side...");
  const triggerPrice = 100n;
  const t0 = Date.now();
  console.log(`Encrypting trigger price: [redacted]`);
  console.log(`Encrypting Safe address: ${safeAddress.slice(0, 6)}...${safeAddress.slice(-4)}`);
  console.log(`Encrypting Safe execTransaction calldata chunks...`);
  const encryptedParams = await client.encryptIntentParameters(safeAddress, execCalldata, triggerPrice);
  const t1 = Date.now();
  console.log(`Client encryption complete in ${t1 - t0}ms.`);

  // 4. Submit Intent to Arcana relay on-chain
  console.log("\n[Step 4] Submitting Gnosis Safe payout intent to Arcana on-chain...");
  const expectedIntentId = await client.intentRelayContract.nextIntentId();
  console.log(`Expected Intent ID: ${expectedIntentId}`);

  const nonce1 = Number(await wallet.provider.send("eth_getTransactionCount", [walletAddress, "latest"]));
  const submitTx = await client.submitIntent({
    ...encryptedParams,
    nonce: nonce1
  });
  console.log(`submitIntent tx sent: ${submitTx.hash}. Waiting for confirmation...`);
  await submitTx.wait();
  console.log(`Intent submitted successfully. Assigned Intent ID: ${expectedIntentId}`);

  // 5. Keeper Price check submission (Trigger price 110 >= 100)
  console.log("\n[Step 5] Keeper submitting price trigger check...");
  const currentPrice = 110n;
  const nonce2 = Number(await wallet.provider.send("eth_getTransactionCount", [walletAddress, "latest"]));
  const { tx: checkTx } = await client.requestTriggerCheck(
    expectedIntentId,
    currentPrice,
    walletAddress,
    nonce2
  );
  console.log(`requestTriggerCheck tx sent: ${checkTx.hash}. Waiting for confirmation...`);
  await checkTx.wait();
  console.log("Trigger check requested successfully.");

  const intentInfo = await client.intentRelayContract.intents(expectedIntentId);
  const activeCheckHandle = intentInfo.activeCheckHandle;
  console.log(`Active check handle: ${activeCheckHandle}`);

  // 6. Wait for TEE result and verify trigger
  console.log("\n[Step 6] Polling handle Gateway for TEE unwrap verification proof...");
  const checkStart = Date.now();
  const decryptionProof = await client.pollDecryptionProof(activeCheckHandle);
  const checkEnd = Date.now();
  const evaluationLatency = checkEnd - checkStart;
  console.log(`TEE computation completed! Latency: ${evaluationLatency}ms.`);

  console.log("Submitting verifyTrigger proof on-chain...");
  const nonce3 = Number(await wallet.provider.send("eth_getTransactionCount", [walletAddress, "latest"]));
  const verifyTx = await client.verifyTrigger(expectedIntentId, decryptionProof, nonce3);
  console.log(`verifyTrigger tx sent: ${verifyTx.hash}. Waiting for confirmation...`);
  await verifyTx.wait();
  console.log("Trigger verified successfully.");

  // 7. Relayer decryps, forwards execution to Gnosis Safe
  console.log("\n[Step 7] Relayer decrypting Gnosis Safe payload...");
  const tDecStart = Date.now();
  const { targetAddress: decryptedTargetAddress, calldata: reassembledCalldata } = 
    await client.decryptExecutionPayload(expectedIntentId);
  const tDecEnd = Date.now();
  console.log(`Payload decrypted in ${tDecEnd - tDecStart}ms.`);
  console.log(`Decrypted Safe address: ${decryptedTargetAddress.slice(0, 6)}...${decryptedTargetAddress.slice(-4)}`);

  console.log("\n[Step 8] Relayer dispatching transaction to Gnosis Safe Proxy...");
  const nonce4 = Number(await wallet.provider.send("eth_getTransactionCount", [walletAddress, "latest"]));
  const executeTx = await wallet.sendTransaction({
    to: decryptedTargetAddress,
    data: reassembledCalldata,
    nonce: nonce4
  });
  console.log(`Safe execution tx sent: ${executeTx.hash}. Waiting for confirmation...`);
  const executeReceipt = await executeTx.wait();
  console.log("Safe execution tx confirmed!");

  // Call markExecuted
  console.log("Calling markExecuted on-chain...");
  const nonce5 = Number(await wallet.provider.send("eth_getTransactionCount", [walletAddress, "latest"]));
  const markTx = await client.markExecuted(expectedIntentId, nonce5);
  console.log(`markExecuted tx sent: ${markTx.hash}. Waiting for confirmation...`);
  await markTx.wait();
  console.log("Intent marked as Executed!");

  // 8. Final Verification
  const postSafeNonce = await safeContract.nonce();
  console.log(`Post-execution Safe nonce: ${postSafeNonce} (expected increment: ${Number(safeNonce) + 1})`);
  
  console.log("\n=== Gnosis Safe Sepolia Demo Complete ===");
  console.log(`- TEE Async Latency: ${evaluationLatency}ms`);
  console.log(`- Decryption Latency: ${tDecEnd - tDecStart}ms`);
}

main().catch(console.error);
