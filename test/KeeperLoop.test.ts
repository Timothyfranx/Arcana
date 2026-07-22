import { expect } from "chai";
import { network } from "hardhat";
import { spawn } from "child_process";
import { nox, NOX_COMPUTE_ADDRESS } from "@iexec-nox/nox-hardhat-plugin";
import { createEthersHandleClient } from "@iexec-nox/handle";

import { chunkCalldata } from "../src/sdk/index.js";

describe("Keeper Loop and Relayer Integration Test", function () {
  it("Should evaluate price checks, fail when mock price is below trigger, and execute automatically when mock price is met", async function () {
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

    const relayerPrivateKey = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
    const keeperPrivateKey = "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a";
    const gatewayUrl = `http://127.0.0.1:${process.env.NOX_HANDLE_GATEWAY_HOST_PORT}`;

    // 2. Submit user intent (Trigger condition >= 100)
    const triggerPrice = 100n;
    const solidityType = "uint256";

    const triggerSecret = await nox.encryptInput(triggerPrice, solidityType, intentRelayAddress);
    
    const targetAddressBigInt = BigInt(mockSwapContractAddress);
    const targetSecret = await nox.encryptInput(targetAddressBigInt, solidityType, intentRelayAddress);

    const swapAmount = 888n;
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

    // 3. Keeper price check at Price = 90 (below trigger threshold 100) -> MUST NOT trigger!
    const price90Secret = await nox.encryptInput(90n, solidityType, intentRelayAddress);
    const checkTx90 = await intentRelay.connect(keeper).requestTriggerCheck(
      intentId,
      price90Secret.handle,
      await user.getAddress(),
      price90Secret.handleProof
    );
    await checkTx90.wait();

    const intentInfo90 = await intentRelay.intents(intentId);
    const publicDecryption90 = await nox.publicDecrypt(intentInfo90.activeCheckHandle);
    expect(publicDecryption90.value).to.equal(false); // 90 >= 100 is False!

    // Verify trigger attempt on-chain for False result: status remains Pending (0)
    await intentRelay.connect(keeper).verifyTrigger(intentId, publicDecryption90.decryptionProof);
    const updatedIntent90 = await intentRelay.intents(intentId);
    expect(updatedIntent90.status).to.equal(0n); // Status.Pending!

    // 4. Keeper price check at Price = 110 (meets trigger threshold 100) -> MUST trigger!
    const price110Secret = await nox.encryptInput(110n, solidityType, intentRelayAddress);
    const checkTx110 = await intentRelay.connect(keeper).requestTriggerCheck(
      intentId,
      price110Secret.handle,
      await user.getAddress(),
      price110Secret.handleProof
    );
    await checkTx110.wait();

    const intentInfo110 = await intentRelay.intents(intentId);
    const publicDecryption110 = await nox.publicDecrypt(intentInfo110.activeCheckHandle);
    expect(publicDecryption110.value).to.equal(true); // 110 >= 100 is True!

    // Verify trigger on-chain: status becomes Triggered (1)
    await intentRelay.connect(keeper).verifyTrigger(intentId, publicDecryption110.decryptionProof);
    const updatedIntent110 = await intentRelay.intents(intentId);
    expect(updatedIntent110.status).to.equal(1n); // Status.Triggered!

    // 5. Relayer decrypts payload and executes on target protocol
    const relayerClient = await createEthersHandleClient(relayer, {
      smartContractAddress: NOX_COMPUTE_ADDRESS,
      gatewayUrl,
      subgraphUrl: "https://example.com/subgraphs/id/none",
    });

    const targetDecryption = await relayerClient.decrypt(updatedIntent110.targetHandle);
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
    console.log("Keeper Loop and Relayer successfully executed the intent automatically on price trigger!");
  });

  it("Should revert if markExecuted is called by an unauthorized non-relayer account", async function () {
    const connection = await network.getOrCreate("noxLocal");
    const { ethers } = connection;
    const [user, relayer, stranger] = await ethers.getSigners();

    const IntentRelayFactory = await ethers.getContractFactory("IntentRelay", user);
    const intentRelay = await IntentRelayFactory.deploy(NOX_COMPUTE_ADDRESS, user.address, relayer.address);
    await intentRelay.waitForDeployment();

    const strangerRelay = intentRelay.connect(stranger);
    await expect(strangerRelay.markExecuted(0n)).to.be.revertedWithCustomError(intentRelay, "OnlyRelayer");
  });

  it("Should evaluate multi-condition composed encrypted triggers (AND) inside TEE enclaves on-chain", async function () {
    const connection = await network.getOrCreate("noxLocal");
    const { ethers } = connection;
    const [user, relayer, oracle] = await ethers.getSigners();
    const userAddr = await user.getAddress();

    const IntentRelayFactory = await ethers.getContractFactory("IntentRelay", user);
    const intentRelay = await IntentRelayFactory.deploy(NOX_COMPUTE_ADDRESS, relayer.address, oracle.address);
    await intentRelay.waitForDeployment();
    const intentRelayAddress = await intentRelay.getAddress();

    // User encrypts Condition 1: Price >= 100
    const { handle: cond1, handleProof: proofCond1 } = await nox.encryptInput(100n, "uint256", intentRelayAddress);

    // User encrypts Condition 2: Volatility <= 50
    const { handle: cond2, handleProof: proofCond2 } = await nox.encryptInput(50n, "uint256", intentRelayAddress);

    // User encrypts target address & calldata
    const { handle: target, handleProof: proofTarget } = await nox.encryptInput(12345n, "uint256", intentRelayAddress);
    const { handle: calldataChunk, handleProof: proofCalldata } = await nox.encryptInput(9999n, "uint256", intentRelayAddress);

    // Submit multi-condition intent: (Price >= 100) AND (Volatility <= 50)
    await intentRelay.connect(user).submitIntentMultiCondition(
      cond1,
      0, // CompareOp.GE
      cond2,
      1, // CompareOp.LE
      1, // LogicOp.AND
      target,
      [calldataChunk],
      32,
      proofCond1,
      proofCond2,
      proofTarget,
      [proofCalldata]
    );

    // 1. Guard check: calling single-condition requestTriggerCheck on a multi-condition intent MUST revert InvalidLogicOp
    const { handle: valCheck1, handleProof: proofCheck1 } = await nox.encryptInput(110n, "uint256", intentRelayAddress);
    await expect(
      intentRelay.connect(oracle).requestTriggerCheck(0n, valCheck1, userAddr, proofCheck1)
    ).to.be.revertedWithCustomError(intentRelay, "InvalidLogicOp");

    // 2. Case A: Price = 110 (passes GE 100), but Volatility = 999 (violates LE 50!) -> AND MUST NOT trigger!
    const { handle: val1A, handleProof: proofVal1A } = await nox.encryptInput(110n, "uint256", intentRelayAddress);
    const { handle: val2A, handleProof: proofVal2A } = await nox.encryptInput(999n, "uint256", intentRelayAddress);

    const txA = await intentRelay.connect(oracle).requestTriggerCheckMulti(
      0n,
      val1A,
      userAddr,
      proofVal1A,
      val2A,
      userAddr,
      proofVal2A
    );
    await txA.wait();

    const intentA = await intentRelay.intents(0n);
    const publicDecryptionA = await nox.publicDecrypt(intentA.activeCheckHandle);
    expect(publicDecryptionA.value).to.equal(false); // (True AND False) MUST evaluate to False!

    // Verify trigger attempt on-chain for False result: status remains Pending (0)
    await intentRelay.connect(oracle).verifyTrigger(0n, publicDecryptionA.decryptionProof);
    const updatedIntentA = await intentRelay.intents(0n);
    expect(updatedIntentA.status).to.equal(0n); // Status.Pending!

    // 3. Case B: Price = 110 (passes GE 100), AND Volatility = 40 (passes LE 50!) -> Both conditions met -> MUST trigger!
    const { handle: val1B, handleProof: proofVal1B } = await nox.encryptInput(110n, "uint256", intentRelayAddress);
    const { handle: val2B, handleProof: proofVal2B } = await nox.encryptInput(40n, "uint256", intentRelayAddress);

    const txB = await intentRelay.connect(oracle).requestTriggerCheckMulti(
      0n,
      val1B,
      userAddr,
      proofVal1B,
      val2B,
      userAddr,
      proofVal2B
    );
    await txB.wait();

    const intentB = await intentRelay.intents(0n);
    const publicDecryptionB = await nox.publicDecrypt(intentB.activeCheckHandle);
    expect(publicDecryptionB.value).to.equal(true); // (True AND True) MUST evaluate to True!

    // Verify trigger on-chain for True result: status becomes Triggered (1)
    await intentRelay.connect(oracle).verifyTrigger(0n, publicDecryptionB.decryptionProof);
    const updatedIntentB = await intentRelay.intents(0n);
    expect(updatedIntentB.status).to.equal(1n); // Status.Triggered!
  });
});
