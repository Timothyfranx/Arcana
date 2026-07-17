import hre from "hardhat";
import dotenv from "dotenv";

dotenv.config();

// Safe Proxy Factory v1.3.0 address
const SAFE_PROXY_FACTORY_ADDRESS = "0xa6b71e26c5e0845f74c812102ca7114b6a896ab2";
const SAFE_SINGLETON_ADDRESS = "0x69f4d1788e39c87893c980c06edf4b7f686e2938";
// Compatibility Fallback Handler address
const FALLBACK_HANDLER_ADDRESS = "0x017062a1de2fe6b99be3d9d37841fed19f573804";

const SAFE_PROXY_FACTORY_ABI = [
  "function createProxyWithNonce(address _singleton, bytes memory initializer, uint256 saltNonce) public returns (address proxy)",
  "event ProxyCreation(address proxy, address singleton)"
];

const SAFE_ABI = [
  "function setup(address[] calldata _owners, uint256 _threshold, address to, bytes calldata data, address fallbackHandler, address paymentToken, uint256 payment, address payable paymentReceiver) external"
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
  console.log(`Using wallet address: ${walletAddress} to deploy Safe Proxy on ${targetNetwork}`);

  const factory = new ethers.Contract(SAFE_PROXY_FACTORY_ADDRESS, SAFE_PROXY_FACTORY_ABI, wallet);
  const safeInterface = new ethers.Interface(SAFE_ABI);

  // Encode the setup function data
  const owners = [walletAddress];
  const threshold = 1n;
  const setupData = safeInterface.encodeFunctionData("setup", [
    owners,
    threshold,
    ethers.ZeroAddress, // to
    "0x", // data
    FALLBACK_HANDLER_ADDRESS, // fallbackHandler
    ethers.ZeroAddress, // paymentToken
    0n, // payment
    ethers.ZeroAddress // paymentReceiver
  ]);

  console.log("Deploying Safe Proxy via SafeProxyFactory...");
  
  // Use a random salt nonce to ensure uniqueness
  const saltNonce = BigInt(Math.floor(Math.random() * 1000000000));
  const nonce = Number(await wallet.provider.send("eth_getTransactionCount", [walletAddress, "latest"]));

  const tx = await factory.createProxyWithNonce(SAFE_SINGLETON_ADDRESS, setupData, saltNonce, { nonce });
  console.log(`Transaction sent: ${tx.hash}. Waiting for confirmation...`);
  const receipt = await tx.wait();

  // Find the ProxyCreation event log
  let safeAddress = "";
  console.log(`Receipt has ${receipt.logs.length} log(s)`);
  for (const log of receipt.logs) {
    console.log(`Log address: ${log.address}`);
    console.log(`Log topics: ${JSON.stringify(log.topics)}`);
    console.log(`Log data: ${log.data}`);
    try {
      const parsedLog = factory.interface.parseLog(log);
      if (parsedLog) {
        console.log(`Parsed log: ${parsedLog.name}`);
        if (parsedLog.name === "ProxyCreation") {
          safeAddress = parsedLog.args[0] || parsedLog.args.proxy;
          break;
        }
      }
    } catch (err: any) {
      console.log(`Failed to parse log: ${err.message || err}`);
    }
  }

  if (!safeAddress) {
    throw new Error("ProxyCreation event not found in transaction logs.");
  }

  console.log("\n==========================================");
  console.log(`Gnosis Safe Proxy deployed at: ${safeAddress}`);
  console.log("==========================================");
}

main().catch(console.error);
