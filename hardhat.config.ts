import { defineConfig } from "hardhat/config";
import hardhatToolboxMochaEthers from "@nomicfoundation/hardhat-toolbox-mocha-ethers";
import noxPlugin from "@iexec-nox/nox-hardhat-plugin";
import dotenv from "dotenv";

dotenv.config();

export default defineConfig({
  plugins: [hardhatToolboxMochaEthers, noxPlugin],
  solidity: {
    version: "0.8.35",
    settings: {
      optimizer: {
        enabled: true,
        runs: 200,
      },
    },
  },
  networks: {
    default: {
      type: "edr-simulated",
      chainType: "op",
      allowUnlimitedContractSize: true,
    },
    sepolia: {
      type: "http",
      url: "https://ethereum-sepolia-rpc.publicnode.com",
      accounts: [process.env.PRIVATE_KEY || "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"],
    },
  },
});
