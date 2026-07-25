import { expect } from "chai";
import { network } from "hardhat";
import { nox, NOX_COMPUTE_ADDRESS } from "@iexec-nox/nox-hardhat-plugin";
import { createEthersHandleClient } from "@iexec-nox/handle";

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

describe("Relayer Execution Payload & Decryption Test", function () {
  it("Should decrypt execution payload and execute target transaction", async function () {
    const connection = await network.getOrCreate("noxLocal");
    const { ethers } = connection;
    const [user, relayer, keeper] = await ethers.getSigners();

    const relayerAddress = await relayer.getAddress();
    const keeperAddress = await keeper.getAddress();

    // 1. Deploy IntentRelay and MockSwapContract
    console.log("Deploying IntentRelay...");
    const IntentRelayFactory = await ethers.getContractFactory("IntentRelay");
    const intentRelay = await IntentRelayFactory.deploy(
      NOX_COMPUTE_ADDRESS,
      relayerAddress,
      keeperAddress
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

    // 2. Relayer setup
    const gatewayUrl = `http://127.0.0.1:${process.env.NOX_HANDLE_GATEWAY_HOST_PORT}`;

    // 3. Encrypt swap details
    const triggerPrice = 100n;
    const solidityType = "uint256";

    const triggerSecret = await nox.encryptInput(triggerPrice, solidityType, intentRelayAddress);
    
    const targetAddressBigInt = BigInt(mockSwapContractAddress);
    const targetSecret = await nox.encryptInput(targetAddressBigInt, solidityType, intentRelayAddress);

    const swapAmount = 777n;
    const rawCalldata = mockSwapContract.interface.encodeFunctionData("swap", [swapAmount]);
    const calldataBytesLength = (rawCalldata.length - 2) / 2;

    const calldataChunks = chunkCalldata(rawCalldata);
    const calldataHandles: string[] = [];
    const calldataProofs: string[] = [];

    for (let i = 0; i < calldataChunks.length; i++) {
      const chunkSecret = await nox.encryptInput(calldataChunks[i], solidityType, intentRelayAddress);
      calldataHandles.push(chunkSecret.handle);
      calldataProofs.push(chunkSecret.handleProof);
    }

    // 4. Submit intent
    console.log("Submitting intent...");
    const submitTx = await intentRelay.connect(user).submitIntent(
      triggerSecret.handle,
      0, // GE
      targetSecret.handle,
      calldataHandles,
      calldataBytesLength,
      triggerSecret.handleProof,
      targetSecret.handleProof,
      calldataProofs
    );
    await submitTx.wait();
    console.log("Intent submitted.");

    const intentId = 0n;

    // 5. Keeper evaluates condition (trigger met)
    const currentPrice = 120n;
    const currentPriceSecret = await nox.encryptInput(currentPrice, solidityType, intentRelayAddress);

    console.log("Keeper requesting trigger check...");
    const checkTx = await intentRelay.connect(keeper).requestTriggerCheck(
      intentId,
      currentPriceSecret.handle,
      await user.getAddress(),
      currentPriceSecret.handleProof
    );
    await checkTx.wait();

    const intentInfo = await intentRelay.intents(intentId);
    const activeCheckHandle = intentInfo.activeCheckHandle;

    // Fetch public decryption proof
    const publicDecryption = await nox.publicDecrypt(activeCheckHandle);

    // Verify trigger on-chain
    console.log("Keeper verifying trigger on-chain...");
    const verifyTx = await intentRelay.connect(keeper).verifyTrigger(
      intentId,
      publicDecryption.decryptionProof
    );
    await verifyTx.wait();
    console.log("Trigger verified. Processing relayer execution...");

    const updatedIntent = await intentRelay.intents(intentId);
    expect(updatedIntent.status).to.equal(1n); // Status.Triggered

    // Relayer decrypts payload and executes on target protocol
    const relayerClient = await createEthersHandleClient(relayer, {
      smartContractAddress: NOX_COMPUTE_ADDRESS,
      gatewayUrl,
      subgraphUrl: "https://example.com/subgraphs/id/none",
    });

    const targetDecryption = await relayerClient.decrypt(updatedIntent.targetHandle);
    const decryptedTarget = ethers.getAddress("0x" + targetDecryption.value.toString(16).padStart(40, "0"));

    let calldataHex = "0x";
    for (const chunkHandle of calldataHandles) {
      const chunkDecryption = await relayerClient.decrypt(chunkHandle);
      calldataHex += chunkDecryption.value.toString(16).padStart(64, "0");
    }
    calldataHex = calldataHex.slice(0, 2 + calldataBytesLength * 2);

    const execTx = await relayer.sendTransaction({
      to: decryptedTarget,
      data: calldataHex,
    });
    await execTx.wait();

    await intentRelay.connect(relayer).markExecuted(intentId);
    const finalIntent = await intentRelay.intents(intentId);
    expect(finalIntent.status).to.equal(2n); // Status.Executed!
    console.log("Relayer execution logic successfully decrypted payload and executed intent!");
  });
});
