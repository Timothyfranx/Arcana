import { expect } from "chai";
import { network } from "hardhat";
import { spawn } from "child_process";
import { nox, NOX_COMPUTE_ADDRESS } from "@iexec-nox/nox-hardhat-plugin";

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
});
