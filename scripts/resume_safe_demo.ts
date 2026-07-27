import hre from "hardhat";
import dotenv from "dotenv";
import { ArcanaClient } from "../src/sdk/client";

dotenv.config();

async function main() {
  const connection = await hre.network.getOrCreate("sepolia");
  const { ethers } = connection;
  const [wallet] = await ethers.getSigners();

  const intentRelayAddress = "0x33Bc5b4b393653857Dd9c34987187Da695568Ef7";
  const noxComputeAddress = "0x24ef36ec5b626d7dcd09a98f3083c2758f0f77bf";
  const gatewayUrl = "https://gateway-testnets.noxprotocol.dev";
  const subgraphUrl = "https://thegraph.ethereum-sepolia-testnet.noxprotocol.io/api/subgraphs/id/9CsccKwvgYFo72zZeU4k4wj2NEBLdWhVE3EUandgmzgo";
  const safeAddress = "0xC40ec2fD95830F37D5744489018693031c8AC6eE";

  const client = new ArcanaClient(wallet, {
    intentRelayAddress,
    noxComputeAddress,
    gatewayUrl,
    subgraphUrl
  });

  const intentId = 0n;
  const intent = await client.intentRelayContract.intents(intentId);
  console.log(`Intent 0 Active Check Handle: ${intent.activeCheckHandle}`);

  console.log("Polling handle Gateway for TEE decryption proof...");
  const proof = await client.pollDecryptionProof(intent.activeCheckHandle, 120);
  console.log(`Decryption proof retrieved! Length: ${proof.length}`);

  console.log("Submitting verifyTrigger transaction...");
  const verifyTx = await client.verifyTrigger(intentId, proof);
  console.log(`verifyTrigger tx sent: ${verifyTx.hash}. Waiting for confirmation...`);
  await verifyTx.wait();
  console.log("Trigger verified successfully on-chain!");

  console.log("Decrypting execution payload...");
  const { targetAddress, calldata } = await client.decryptExecutionPayload(intentId);
  console.log(`Decrypted target address: ${targetAddress}`);
  console.log(`Decrypted calldata length: ${calldata.length}`);

  console.log("Executing payout transaction on target (Gnosis Safe)...");
  const executionTx = await wallet.sendTransaction({
    to: targetAddress,
    data: calldata,
  });
  console.log(`Execution transaction sent: ${executionTx.hash}. Waiting for confirmation...`);
  await executionTx.wait();
  console.log("Gnosis Safe Payout executed successfully!");

  console.log("Marking intent as executed...");
  const markTx = await client.markExecuted(intentId);
  console.log(`markExecuted tx sent: ${markTx.hash}. Waiting for confirmation...`);
  await markTx.wait();
  console.log("Intent marked as Executed!");

  const SAFE_ABI = ["function nonce() external view returns (uint256)"];
  const safeContract = new ethers.Contract(safeAddress, SAFE_ABI, wallet);
  const postNonce = await safeContract.nonce();
  console.log(`Post-execution Safe nonce: ${postNonce.toString()}`);
}

main().catch(console.error);
