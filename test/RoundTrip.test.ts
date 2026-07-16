import { expect } from "chai";
import { network } from "hardhat";
import { nox, NOX_COMPUTE_ADDRESS } from "@iexec-nox/nox-hardhat-plugin";

describe("Nox Round Trip Test", function () {
  it("Should encrypt, register on-chain, and decrypt a uint256 value", async function () {
    // Connect to the noxLocal network explicitly in Hardhat 3
    const connection = await network.getOrCreate("noxLocal");
    const { ethers } = connection;

    // 1. Deploy MockContract
    console.log("Deploying MockContract...");
    const MockContractFactory = await ethers.getContractFactory("MockContract");
    const mockContract = await MockContractFactory.deploy(NOX_COMPUTE_ADDRESS);
    await mockContract.waitForDeployment();
    const mockContractAddress = await mockContract.getAddress();
    console.log(`MockContract deployed at: ${mockContractAddress}`);

    const valueToEncrypt = 12345n;
    const solidityType = "uint256";

    // 2. Encrypt input
    console.log("Starting encryption...");
    const startTime = Date.now();
    const { handle, handleProof } = await nox.encryptInput(
      valueToEncrypt,
      solidityType,
      mockContractAddress // The contract that will validate the proof
    );
    const encryptTime = Date.now();
    console.log(`Encrypted in ${encryptTime - startTime}ms`);
    console.log(`Handle: ${handle}`);

    // 3. Register the handle on-chain
    console.log("Registering handle on-chain...");
    const tx = await mockContract.registerHandle(handle, handleProof);
    await tx.wait();
    console.log("Handle registered!");

    // 4. Decrypt input
    console.log("Starting decryption...");
    const { value, solidityType: decryptedType } = await nox.decrypt(handle);
    const decryptTime = Date.now();
    console.log(`Decrypted in ${decryptTime - encryptTime}ms`);
    console.log(`Decrypted Value: ${value} (type: ${decryptedType})`);

    expect(value).to.equal(valueToEncrypt);
    expect(decryptedType).to.equal(solidityType);
  });
});
