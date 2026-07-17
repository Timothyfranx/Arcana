import { ethers } from "ethers";
import { ArcanaClient } from "../../src/sdk/index.js";
import "./style.css";

// Ethereum Sepolia Configuration
const INTENT_RELAY_ADDRESS = "0x9BF3f5db0442a59A074B728cD23F719D57375A9b";
const NOX_COMPUTE_ADDRESS = "0x24ef36ec5b626d7dcd09a98f3083c2758f0f77bf";
const GATEWAY_URL = "https://gateway-testnets.noxprotocol.dev";
const SUBGRAPH_URL = "https://thegraph.ethereum-sepolia-testnet.noxprotocol.io/api/subgraphs/id/9CsccKwvgYFo72zZeU4k4wj2NEBLdWhVE3EUandgmzgo";

const MOCK_SWAP_ABI = [
  "function swap(uint256 amount) external"
];

let provider: ethers.BrowserProvider | null = null;
let signer: ethers.Signer | null = null;
let userAddress: string = "";
let client: ArcanaClient | null = null;

// DOM Elements
const btnConnect = document.getElementById("btn-connect") as HTMLButtonElement;
const walletBalance = document.getElementById("wallet-balance") as HTMLSpanElement;
const btnSubmit = document.getElementById("btn-submit") as HTMLButtonElement;
const btnRefresh = document.getElementById("btn-refresh") as HTMLButtonElement;
const intentsList = document.getElementById("intents-list") as HTMLTableSectionElement;

const inputTarget = document.getElementById("input-target") as HTMLInputElement;
const inputAmount = document.getElementById("input-amount") as HTMLInputElement;
const inputThreshold = document.getElementById("input-threshold") as HTMLInputElement;

// Connect Wallet handler
async function connectWallet() {
  if (!(window as any).ethereum) {
    alert("MetaMask or compatible Web3 provider not found. Please install MetaMask to use Arcana.");
    return;
  }

  try {
    btnConnect.disabled = true;
    btnConnect.innerText = "Connecting...";
    
    // Request accounts
    const accounts = await (window as any).ethereum.request({ method: "eth_requestAccounts" });
    userAddress = accounts[0];
    
    // Setup provider and signer
    provider = new ethers.BrowserProvider((window as any).ethereum);
    signer = await provider.getSigner();

    // Setup Arcana SDK Client
    client = new ArcanaClient(signer, {
      intentRelayAddress: INTENT_RELAY_ADDRESS,
      noxComputeAddress: NOX_COMPUTE_ADDRESS,
      gatewayUrl: GATEWAY_URL,
      subgraphUrl: SUBGRAPH_URL
    });

    // Format display balance
    const balance = await provider.getBalance(userAddress);
    walletBalance.innerText = `${parseFloat(ethers.formatEther(balance)).toFixed(4)} ETH`;

    // Update connection button
    const shortAddress = `${userAddress.slice(0, 6)}...${userAddress.slice(-4)}`;
    btnConnect.innerText = shortAddress;
    btnConnect.classList.remove("btn-primary");
    btnConnect.classList.add("btn-secondary");
    btnConnect.disabled = false;

    // Enable submission
    btnSubmit.disabled = false;

    console.log(`Connected wallet: ${userAddress}`);
    
    // Load dashboard
    await loadIntents();

  } catch (err: any) {
    console.error("Connection failed:", err);
    btnConnect.disabled = false;
    btnConnect.innerText = "Connect Wallet";
    alert(`Connection failed: ${err.message || err}`);
  }
}

// Load user intents on dashboard
async function loadIntents() {
  if (!client || !userAddress) return;

  try {
    intentsList.innerHTML = `<tr><td colspan="6" class="table-empty">Loading active intents...</td></tr>`;
    
    const nextIntentId = await client.intentRelayContract.nextIntentId();
    const rowsHTML: string[] = [];

    // Loop through all deployed intents and filter by owner
    for (let id = 0n; id < nextIntentId; id++) {
      const intent = await client.intentRelayContract.intents(id);
      
      // Filter by owner (address comparison is case-insensitive)
      if (intent.owner.toLowerCase() === userAddress.toLowerCase()) {
        const statusNum = Number(intent.status);
        let statusBadge = "";
        
        switch (statusNum) {
          case 0:
            statusBadge = `<span class="status-badge pending">Pending</span>`;
            break;
          case 1:
            statusBadge = `<span class="status-badge triggered">Triggered</span>`;
            break;
          case 2:
            statusBadge = `<span class="status-badge executed">Executed</span>`;
            break;
          case 3:
            statusBadge = `<span class="status-badge secondary">Cancelled</span>`;
            break;
          default:
            statusBadge = `<span class="status-badge secondary">Unknown</span>`;
        }

        const targetShort = `${intent.targetHandle.slice(0, 8)}...${intent.targetHandle.slice(-6)}`;
        const checkHandle = intent.activeCheckHandle !== ethers.ZeroHash 
          ? `${intent.activeCheckHandle.slice(0, 8)}...${intent.activeCheckHandle.slice(-6)}` 
          : "None";

        rowsHTML.push(`
          <tr>
            <td>#${id}</td>
            <td><code>${targetShort}</code></td>
            <td>${intent.calldataLength} bytes</td>
            <td>Price &gt;= 100</td>
            <td><code>${checkHandle}</code></td>
            <td>${statusBadge}</td>
          </tr>
        `);
      }
    }

    if (rowsHTML.length === 0) {
      intentsList.innerHTML = `<tr><td colspan="6" class="table-empty">No intents found for your account.</td></tr>`;
    } else {
      intentsList.innerHTML = rowsHTML.reverse().join(""); // Show newest first
    }

  } catch (err: any) {
    console.error("Failed to load intents:", err);
    intentsList.innerHTML = `<tr><td colspan="6" class="table-empty" style="color: #ff6b6b;">Failed to load intents dashboard: ${err.message || err}</td></tr>`;
  }
}

// Submit intent handler
async function submitIntent() {
  if (!client || !signer) return;

  const target = inputTarget.value.trim();
  const amount = BigInt(inputAmount.value);
  const threshold = BigInt(inputThreshold.value);

  if (!ethers.isAddress(target)) {
    alert("Invalid Ethereum target contract address.");
    return;
  }

  try {
    btnSubmit.disabled = true;
    btnSubmit.innerText = "Encrypting parameters...";

    // Encode call on target contract
    const mockSwapInterface = new ethers.Interface(MOCK_SWAP_ABI);
    const rawCalldata = mockSwapInterface.encodeFunctionData("swap", [amount]);

    console.log(`Encrypting parameters client-side for target: ${target}`);
    const encryptedParams = await client.encryptIntentParameters(target, rawCalldata, threshold);

    btnSubmit.innerText = "Submitting to blockchain...";
    console.log("Submitting transaction to IntentRelay...");

    const nonce = Number(await (window as any).ethereum.request({
      method: "eth_getTransactionCount",
      params: [userAddress, "latest"]
    }));

    const tx = await client.submitIntent({
      ...encryptedParams,
      nonce
    });

    btnSubmit.innerText = "Waiting for confirmation...";
    const receipt = await tx.wait();
    console.log(`Transaction confirmed! Hash: ${receipt.hash}`);

    alert(`Intent submitted successfully!\nTransaction hash: ${receipt.hash}`);
    
    // Reset form and reload
    inputAmount.value = "888";
    inputThreshold.value = "100";
    await loadIntents();

  } catch (err: any) {
    console.error("Submission failed:", err);
    alert(`Failed to submit intent: ${err.message || err}`);
  } finally {
    btnSubmit.disabled = false;
    btnSubmit.innerText = "Submit Private Intent";
  }
}

// Event Listeners
btnConnect.addEventListener("click", connectWallet);
btnRefresh.addEventListener("click", loadIntents);
btnSubmit.addEventListener("click", submitIntent);
