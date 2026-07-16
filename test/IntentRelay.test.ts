import { expect } from "chai";
import { network } from "hardhat";
import { nox, NOX_COMPUTE_ADDRESS } from "@iexec-nox/nox-hardhat-plugin";
import { createEthersHandleClient } from "@iexec-nox/handle";

// Helper to chunk calldata into uint256 variables
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

describe("IntentRelay Integration Test", function () {
  it("Should execute a full confidential intent lifecycle: submit -> trigger -> decrypt -> execute", async function () {
    const connection = await network.getOrCreate("noxLocal");
    const { ethers } = connection;
    const [user, relayer, keeper] = await ethers.getSigners();

    console.log(`User: ${await user.getAddress()}`);
    console.log(`Relayer: ${await relayer.getAddress()}`);
    console.log(`Keeper: ${await keeper.getAddress()}`);

    // 1. Deploy IntentRelay and MockSwapContract
    console.log("Deploying IntentRelay...");
    const IntentRelayFactory = await ethers.getContractFactory("IntentRelay");
    const intentRelay = await IntentRelayFactory.deploy(
      NOX_COMPUTE_ADDRESS,
      await relayer.getAddress(),
      await keeper.getAddress()
    );
    await intentRelay.waitForDeployment();
    const intentRelayAddress = await intentRelay.getAddress();
    console.log(`IntentRelay deployed at: ${intentRelayAddress}`);

    console.log("Deploying MockSwapContract...");
    const MockSwapFactory = await ethers.getContractFactory("MockSwapContract");
    const mockSwapContract = await MockSwapFactory.deploy();
    await mockSwapContract.waitForDeployment();
    const mockSwapContractAddress = await mockSwapContract.getAddress();
    console.log(`MockSwapContract deployed at: ${mockSwapContractAddress}`);

    // 2. Encrypt parameters client-side
    const triggerPrice = 100n;
    const solidityType = "uint256";

    console.log(`Encrypting trigger price: ${triggerPrice}`);
    const triggerSecret = await nox.encryptInput(
      triggerPrice,
      solidityType,
      intentRelayAddress
    );

    // Encrypt target contract address as a uint256
    const targetAddressBigInt = BigInt(mockSwapContractAddress);
    console.log(`Encrypting target contract address: ${mockSwapContractAddress} (${targetAddressBigInt})`);
    const targetSecret = await nox.encryptInput(
      targetAddressBigInt,
      solidityType,
      intentRelayAddress
    );

    // Encode swap calldata
    const swapAmount = 999n;
    const rawCalldata = mockSwapContract.interface.encodeFunctionData("swap", [swapAmount]);
    const calldataBytesLength = (rawCalldata.length - 2) / 2;
    console.log(`Raw calldata: ${rawCalldata} (length: ${calldataBytesLength} bytes)`);

    const calldataChunks = chunkCalldata(rawCalldata);
    console.log(`Calldata chunked into ${calldataChunks.length} uint256 chunk(s):`, calldataChunks);

    const calldataHandles: string[] = [];
    const calldataProofs: string[] = [];

    for (let i = 0; i < calldataChunks.length; i++) {
      console.log(`Encrypting calldata chunk #${i}: ${calldataChunks[i]}`);
      const chunkSecret = await nox.encryptInput(
        calldataChunks[i],
        solidityType,
        intentRelayAddress
      );
      calldataHandles.push(chunkSecret.handle);
      calldataProofs.push(chunkSecret.handleProof);
    }

    // 3. User submits the intent
    console.log("Submitting intent to IntentRelay...");
    const submitTx = await intentRelay.connect(user).submitIntent(
      triggerSecret.handle,
      0, // CompareOp.GE (Greater than or equal)
      targetSecret.handle,
      calldataHandles,
      calldataBytesLength,
      triggerSecret.handleProof,
      targetSecret.handleProof,
      calldataProofs
    );
    await submitTx.wait();
    console.log("Intent submitted successfully!");

    const intentId = 0n;

    // 4. Keeper evaluates the condition with current price = 110 (trigger condition met)
    const currentPrice = 110n;
    console.log(`Keeper encrypting current market price: ${currentPrice}`);
    const currentPriceSecret = await nox.encryptInput(
      currentPrice,
      solidityType,
      intentRelayAddress
    );

    console.log("Keeper requesting trigger check...");
    const checkTx = await intentRelay.connect(keeper).requestTriggerCheck(
      intentId,
      currentPriceSecret.handle,
      await user.getAddress(),
      currentPriceSecret.handleProof
    );
    const checkReceipt = await checkTx.wait();
    console.log("Trigger check requested.");

    // Retrieve active check handle
    const intent = await intentRelay.intents(intentId);
    const activeCheckHandle = intent.activeCheckHandle;
    console.log(`Active check handle: ${activeCheckHandle}`);

    // 5. Decrypt comparison result using the public unwrap flow
    console.log("Waiting for TEE computation and fetching public decryption proof...");
    const publicDecryption = await nox.publicDecrypt(activeCheckHandle);
    console.log(`Decrypted comparison result value: ${publicDecryption.value}`);
    expect(publicDecryption.value).to.equal(true); // 110 >= 100 should be true

    // 6. Keeper calls verifyTrigger with the decryption proof
    console.log("Verifying trigger on-chain...");
    const verifyTx = await intentRelay.connect(keeper).verifyTrigger(
      intentId,
      publicDecryption.decryptionProof
    );
    await verifyTx.wait();
    console.log("Trigger verified successfully!");

    // Verify status is Triggered
    const updatedIntent = await intentRelay.intents(intentId);
    expect(updatedIntent.status).to.equal(1n); // Status.Triggered

    // 7. Relayer executes the triggered intent
    console.log("Relayer fetching and decrypting target and calldata handles...");
    
    // Connect as relayer to decrypt
    const gatewayUrl = `http://127.0.0.1:${process.env.NOX_HANDLE_GATEWAY_HOST_PORT}`;
    const relayerClient = await createEthersHandleClient(relayer, {
      smartContractAddress: NOX_COMPUTE_ADDRESS,
      gatewayUrl,
      subgraphUrl: "https://example.com/subgraphs/id/none",
    });

    // Decrypt target contract address
    const targetDecryption = await relayerClient.decrypt(updatedIntent.targetHandle);
    const decryptedTargetAddress = "0x" + targetDecryption.value.toString(16).padStart(40, "0");
    console.log(`Decrypted target address: ${decryptedTargetAddress}`);
    expect(decryptedTargetAddress.toLowerCase()).to.equal(mockSwapContractAddress.toLowerCase());

    // Decrypt calldata chunks
    const decryptedChunks: bigint[] = [];
    const storedCalldataHandles = await intentRelay.getCalldataHandles(intentId);
    
    for (const handle of storedCalldataHandles) {
      const chunkDecryption = await relayerClient.decrypt(handle);
      decryptedChunks.push(chunkDecryption.value as bigint);
    }

    const decryptedCalldata = rebuildCalldata(decryptedChunks, Number(updatedIntent.calldataLength));
    console.log(`Decrypted calldata: ${decryptedCalldata}`);
    expect(decryptedCalldata).to.equal(rawCalldata);

    // Forward the transaction to the decrypted target contract with decrypted calldata
    console.log("Forwarding transaction to the target protocol...");
    const forwardTx = await relayer.sendTransaction({
      to: decryptedTargetAddress,
      data: decryptedCalldata,
    });
    const forwardReceipt = await forwardTx.wait();
    console.log("Transaction executed on target contract!");

    // Check that target contract emitted event
    const swapEventSignature = mockSwapContract.interface.getEvent("SwapExecuted")!.topicHash;
    const log = forwardReceipt!.logs.find((l) => l.topics[0] === swapEventSignature);
    expect(log).to.not.be.undefined;
    console.log("SwapExecuted event detected in target transaction receipt!");

    // Mark intent as executed on-chain
    console.log("Marking intent as executed on-chain...");
    const markTx = await intentRelay.connect(relayer).markExecuted(intentId);
    await markTx.wait();

    const finalIntent = await intentRelay.intents(intentId);
    expect(finalIntent.status).to.equal(2n); // Status.Executed
    console.log("Intent marked as Executed on-chain!");
  });
});
