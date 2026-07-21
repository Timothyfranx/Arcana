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

    const dummySubgraphUrl = "https://thegraph.ethereum-sepolia-testnet.noxprotocol.io/api/subgraphs/id/9CsccKwvgYFo72zZeU4k4wj2NEBLdWhVE3EUandgmzgo";

    // 3. Start Relayer Daemon in background
    console.log("Spawning Relayer Daemon...");
    const relayerProcess = spawn("node", ["node_modules/tsx/dist/cli.mjs", "src/relayer.ts"], {
      env: {
        ...process.env,
        RPC_URL: "http://127.0.0.1:8545",
        RELAYER_PRIVATE_KEY: relayerPrivateKey,
        INTENT_RELAY_ADDRESS: intentRelayAddress,
        NOX_COMPUTE_ADDRESS: NOX_COMPUTE_ADDRESS,
        GATEWAY_URL: gatewayUrl,
        SUBGRAPH_URL: dummySubgraphUrl,
      },
    });

    relayerProcess.stdout.on("data", (data) => {
      console.log(`[Relayer Daemon] ${data.toString().trim()}`);
    });
    relayerProcess.stderr.on("data", (data) => {
      console.error(`[Relayer Daemon Error] ${data.toString().trim()}`);
    });

    // 4. Spawn Keeper Daemon with Price = 90 (below trigger threshold 100)
    console.log("Spawning Keeper Daemon with price 90...");
    const keeperProcessPrice90 = spawn("node", ["node_modules/tsx/dist/cli.mjs", "src/keeper.ts"], {
      env: {
        ...process.env,
        RPC_URL: "http://127.0.0.1:8545",
        KEEPER_PRIVATE_KEY: keeperPrivateKey,
        INTENT_RELAY_ADDRESS: intentRelayAddress,
        NOX_COMPUTE_ADDRESS: NOX_COMPUTE_ADDRESS,
        GATEWAY_URL: gatewayUrl,
        SUBGRAPH_URL: dummySubgraphUrl,
        MOCK_PRICE: "90",
        POLL_INTERVAL_MS: "3000",
      },
    });

    keeperProcessPrice90.stdout.on("data", (data) => {
      console.log(`[Keeper Daemon (90)] ${data.toString().trim()}`);
    });
    keeperProcessPrice90.stderr.on("data", (data) => {
      console.error(`[Keeper Daemon Error (90)] ${data.toString().trim()}`);
    });

    // Wait for keeper to submit checking logs
    await new Promise((r) => setTimeout(r, 6000));

    // Verify that status remains Pending (0) and active check handle gets reset (or fails)
    let intentInfo = await intentRelay.intents(intentId);
    expect(intentInfo.status).to.equal(0n); // Status.Pending
    console.log("Verified: Keeper check with price 90 did not trigger the intent.");

    // Terminate keeper with price 90
    console.log("Terminating Keeper Daemon (90)...");
    keeperProcessPrice90.kill();

    // 5. Spawn Keeper Daemon with Price = 110 (meets trigger threshold 100)
    console.log("Spawning Keeper Daemon with price 110...");
    const keeperProcessPrice110 = spawn("node", ["node_modules/tsx/dist/cli.mjs", "src/keeper.ts"], {
      env: {
        ...process.env,
        RPC_URL: "http://127.0.0.1:8545",
        KEEPER_PRIVATE_KEY: keeperPrivateKey,
        INTENT_RELAY_ADDRESS: intentRelayAddress,
        NOX_COMPUTE_ADDRESS: NOX_COMPUTE_ADDRESS,
        GATEWAY_URL: gatewayUrl,
        SUBGRAPH_URL: dummySubgraphUrl,
        MOCK_PRICE: "110",
        POLL_INTERVAL_MS: "3000",
      },
    });

    keeperProcessPrice110.stdout.on("data", (data) => {
      console.log(`[Keeper Daemon (110)] ${data.toString().trim()}`);
    });
    keeperProcessPrice110.stderr.on("data", (data) => {
      console.error(`[Keeper Daemon Error (110)] ${data.toString().trim()}`);
    });

    // Poll status on the contract until status is Status.Executed (2)
    let executed = false;
    for (let i = 0; i < 20; i++) {
      const currentIntent = await intentRelay.intents(intentId);
      const status = currentIntent.status;
      console.log(`Polling intent status... Current: ${status} (expected: 2)`);
      if (status === 2n) {
        executed = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 1000));
    }

    // Clean up
    console.log("Terminating daemons...");
    keeperProcessPrice110.kill();
    relayerProcess.kill();

    expect(executed).to.be.true;
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
    const oracleAddr = await oracle.getAddress();

    const IntentRelayFactory = await ethers.getContractFactory("IntentRelay", user);
    const intentRelay = await IntentRelayFactory.deploy(NOX_COMPUTE_ADDRESS, relayer.address, oracle.address);
    await intentRelay.waitForDeployment();
    const intentRelayAddress = await intentRelay.getAddress();

    console.log("Deployed priceOracle:", await intentRelay.priceOracle(), "oracle signer:", oracleAddr);

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

    // Oracle encrypts current market values: Price = 110, Volatility = 40 (Both conditions met!)
    const { handle: val1, handleProof: proofVal1 } = await nox.encryptInput(110n, "uint256", intentRelayAddress);
    const { handle: val2, handleProof: proofVal2 } = await nox.encryptInput(40n, "uint256", intentRelayAddress);

    // Oracle requests multi-condition check
    const tx = await intentRelay.connect(oracle).requestTriggerCheckMulti(
      0n,
      val1,
      userAddr,
      proofVal1,
      val2,
      userAddr,
      proofVal2
    );
    await tx.wait();

    const intent = await intentRelay.intents(0n);
    const checkHandle = intent.activeCheckHandle;
    expect(checkHandle).to.not.equal(ethers.ZeroHash);

    // Poll decryption proof of composite result
    const publicDecryption = await nox.publicDecrypt(checkHandle);

    // Verify trigger on-chain
    await intentRelay.connect(oracle).verifyTrigger(0n, publicDecryption.decryptionProof);

    const updatedIntent = await intentRelay.intents(0n);
    expect(updatedIntent.status).to.equal(1n); // Status.Triggered!
  });
});
