# Arcana — Confidential Intent Relay on iExec Nox

Arcana is a **Confidential Intent Relay** built on the iExec Nox protocol. It allows users to submit private DeFi intents (such as encrypted limit orders, stop-losses, and yield-farming triggers) where the target protocol address, transaction calldata, and price thresholds remain completely encrypted inside TEE hardware until execution conditions are met. 

The target protocol remains completely unmodified. Once a whitelisted price oracle updates the trigger condition on-chain, the relay contract dynamically grants decryption viewer permissions to a dedicated relayer service. The relayer decrypts the execution payload off-chain and forwards it directly to the target contract in a single sequential block execution.

---

## Architecture

The system consists of three main roles: the **User** (intent owner), the **Oracle/Keeper** (price feed), and the **Relayer** (executor).

```mermaid
sequenceDiagram
    autonumber
    actor User
    actor Oracle as Price Oracle / Keeper
    participant Contract as IntentRelay
    participant Nox as iExec Nox TEE
    actor Relayer

    User->xUser: Encrypts Target Address & Calldata Chunks
    User->>Contract: submitIntent(targetHandle, calldataHandles, triggerThresholdHandle)
    Note over Contract: Persists contract access to handles (INoxCompute.allow)
    
    loop Periodically
        Oracle->>Oracle: Encrypts Current Market Price
        Oracle->>Contract: requestTriggerCheck(currentPriceHandle)
        Contract->>Nox: ge(currentPriceHandle, triggerThresholdHandle)
        Nox-->>Contract: resultHandle (Publicly Decryptable)
    end

    Oracle->>Oracle: Fetches Public Decryption Proof from Nox Gateway
    Oracle->>Contract: verifyTrigger(intentId, decryptionProof)
    Note over Contract: validateDecryptionProof matches TEE result
    
    rect rgb(240, 248, 255)
        Note over Contract, Relayer: If Condition is Met (True)
        Contract->>Contract: Grant Relayer Decryption Viewer Access (addViewer)
        Contract-->>Relayer: Emit IntentTriggered Event
        Relayer->>Nox: requestDecryption(targetHandle, calldataHandles)
        Nox-->>Relayer: Plaintext target address & reassembled calldata bytes
        Relayer->>Contract: Forward transaction to target protocol & call markExecuted()
    end
```

---

## Repository Contents

*   **[`contracts/IntentRelay.sol`](file:///home/replytim/Desktop/Arcana/contracts/IntentRelay.sol)**: The main smart contract managing confidential intent submissions, TEE comparison requests, decryption verification, and relayer access control.
*   **[`src/sdk/`](file:///home/replytim/Desktop/Arcana/src/sdk/)**: The reusable Javascript/Typescript client SDK (`ArcanaClient`) encapsulating padding, chunking, EIP-712 credential signing, on-chain submission, and decryption logic.
*   **[`frontend/`](file:///home/replytim/Desktop/Arcana/frontend/)**: A responsive dark-themed Web3 single-page Vite dashboard allowing users to connect MetaMask, submit private intents, and track their execution status live.
*   **[`src/relayer.ts`](file:///home/replytim/Desktop/Arcana/src/relayer.ts)**: A standalone off-chain Relayer daemon service refactored to use the client SDK to monitor events, decrypt payloads, and dispatch execution.
*   **[`src/keeper.ts`](file:///home/replytim/Desktop/Arcana/src/keeper.ts)**: A standalone off-chain Keeper daemon service refactored to use the SDK to check pending intents and request trigger validations.
*   **[`test/KeeperLoop.test.ts`](file:///home/replytim/Desktop/Arcana/test/KeeperLoop.test.ts)**: Integration tests simulating unsuccessful checks (price below trigger) and successful checks.
*   **[`scripts/deploy_safe.ts`](file:///home/replytim/Desktop/Arcana/scripts/deploy_safe.ts)**: Deploys a standard Gnosis Safe Proxy (v1.3.0) on Ethereum Sepolia controlled by the burner wallet.
*   **[`scripts/demo_safe.ts`](file:///home/replytim/Desktop/Arcana/scripts/demo_safe.ts)**: End-to-end Sepolia execution demo routing a private payout transaction through the Gnosis Safe.

---

## Latency Metrics (Live Ethereum Sepolia Testnet)

### 1. Minimal Swap Demo (72 bytes calldata, 2 chunks)
*   **Client Price Encryption**: **5.03s** (EIP-712 credential signing & off-chain encryption).
*   **TEE Async Comparison Latency**: **1.80s** (Unwrap phase where Sepolia TEE hardware evaluates the comparison).
*   **Relayer Decryption Latency**: **6.31s** (EIP-712 decryption verification & key retrieval).

### 2. Gnosis Safe Payout Demo (484 bytes calldata, 16 chunks)
*   **Client Parameters Encryption**: **18.94s** (Encrypting trigger condition, target address, and 16 calldata chunks).
*   **TEE Async Comparison Latency**: **12.04s** (TEE worker enclave execution on testnet).
*   **Relayer Decryption Latency (Optimized parallelized)**: **18.18s** (Reduced from **35.45s** using parallel `Promise.all` decryption; includes ~12s subgraph indexer delay and ~6s parallel TEE API requests).

---

## Setup & Local Development

### 1. Prerequisites
Ensure you have the modern `docker compose` CLI plugin installed rather than the legacy standalone `docker-compose` binary:
```bash
docker compose version
```

### 2. Installation
Clone the repository and install dependencies:
```bash
npm install
```

### 3. Running Local Integration Tests
The project uses the `@iexec-nox/nox-hardhat-plugin` to spin up the local off-chain stack (Nox KMS, handle gateway, ingestor, runner, NATS) inside Docker:
```bash
npx hardhat test
```

### 4. Running the Web Frontend Dashboard
Scaffolded under the `frontend` folder. To run locally:
```bash
cd frontend
npm install
npm run dev
```

### 5. Running the Gnosis Safe Sepolia Demo
Create a `.env` file in the root directory:
```env
PRIVATE_KEY=your_sepolia_private_key
```

Deploy the Gnosis Safe proxy on Sepolia:
```bash
npx hardhat run scripts/deploy_safe.ts --network sepolia
```

Run the end-to-end Safe payout demo:
```bash
npx hardhat run scripts/demo_safe.ts --network sepolia
```

---

## Design Choices & Tradeoffs

1. **Whitelisted Price Oracles**: Gated `requestTriggerCheck` to prevent arbitrary price manipulation. Gated by a whitelisted `priceOracle` address.
2. **Parallelized Decryption**: Safe execution calldata is split into multiple 32-byte chunks. The SDK decrypts all chunks concurrently in parallel (`Promise.all`) once the subgraph indexes the permission change, eliminating linear network latency.
3. **Calldata Chunking**: Because the current Nox JS SDK only supports encrypting 32-byte numeric types (`uint256`), generic swap/multisig calldata of arbitrary length is padded, divided into 32-byte chunks, and encrypted client-side. The relayer decrypts these chunks off-chain and trims the padding dynamically using the on-chain stored `calldataLength`.
