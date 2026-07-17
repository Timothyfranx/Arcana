# Feedback on iExec Nox Protocol & Developer Experience

## Day 1 — Environment & First Round Trip

### Core Metrics
*   **Local Encryption Latency**: ~252ms
*   **Local Decryption Latency**: ~725ms
*   **Total Round-Trip Overhead**: ~1000ms

### Friction Points & Solutions

#### 1. Hardhat 3 ESM-First Architecture
*   **Friction**: Hardhat 3 strictly enforces ECMAScript Modules (`"type": "module"` in `package.json`). Legacy CommonJS imports for `hardhat` (like `require` or using `hre.ethers` directly) fail because `ethers` is no longer a direct export of the `hardhat` library in ESM mode.
*   **Solution**: Added `"type": "module"` to `package.json`. Used Hardhat 3's new Network Manager to connect/create networks explicitly via `await network.getOrCreate("noxLocal")` to retrieve the correct `ethers` instance.

#### 2. Network Isolation in Hardhat 3 Tests
*   **Friction**: Running `npx hardhat test` with default configurations uses a fresh in-memory EDR simulated network. Meanwhile, the Nox plugin spins up the off-chain Docker stack and injects the `NoxCompute` mock bytecode on `noxLocal` (port 8545). Doing a default connection in tests connects to a network *without* the `NoxCompute` contract, causing transactions calling the library to revert with `function call to a non-contract account`.
*   **Solution**: Retrieve the connection object for the plugin-configured network using `await network.getOrCreate("noxLocal")` in the Mocha test files instead of the generic `network.connect()`.

#### 3. Docker Compose Versioning
*   **Friction**: The `@iexec-nox/nox-hardhat-plugin` depends on the modern `docker compose` CLI plugin rather than the legacy standalone `docker-compose` binary. Systems running standard Docker installations without the compose plugin CLI extension fail during local stack setup.
*   **Solution**: Installed the `docker-compose` binary locally under `$HOME/.docker/cli-plugins/docker-compose` to make it available to the Docker CLI as a plugin.

#### 4. Type Restrictions in JS SDK `encryptInput`
*   **Friction**: The JS SDK's `encryptInput` method strictly validates and rejects types other than the core subset: `bool`, `uint16`, `uint256`, `int16`, `int256`. It is not currently possible to encrypt `address` or `bytes` directly as their respective types, despite their inclusion in the `TEEType` Solidity enum.
*   **Solution**: To build generic intent relays where the target contract address and arbitrary calldata must be private:
    *   Target addresses must be cast to `uint256` (big-endian/bigint) and encrypted as `uint256` handles.
    *   Calldata must be padded to a multiple of 32 bytes, chunked into 32-byte segments, cast to `uint256`, and encrypted as an array of `uint256` handles (`bytes32[]`).
    *   The on-chain contract can store these `bytes32` handles generically, and the off-chain relayer can decrypt and re-assemble them back into addresses and bytes.

#### 5. Stale README in Plugin Repository
*   **Friction**: The source code repository/GitHub README for `@iexec-nox/nox-hardhat-plugin` is stale (it describes itself as a generic template and only mentions the "Hola, Hardhat!" task), which can lead developers to assume the plugin doesn't contain real off-chain provisioning logic.
*   **Solution**: The published npm package is fully functional and includes the actual implementation for Docker Compose and KMS/Gateway setup, but the public documentation should be updated to align with the actual NPM artifact.

---

## Day 2-5 — Contract and Off-Chain Daemon Development

### Core Metrics
*   **Local Daemon Integration E2E Latency**: ~3.5s (full loop: pricing check, trigger verification, relayer event capture, decryption, execution, and execution marking).

### Friction Points & Solutions

#### 1. Dynamic Boolean Parsing in Solidity
*   **Friction**: Boolean decryption results returned by the TEE decryption gateway are serialized as 1-byte values (`0x00` / `0x01`) rather than standard 32-byte EVM words. Using `abi.decode` directly on the decryption result array fails and reverts for 1-byte lengths.
*   **Solution**: Added a utility helper to parse the `decrypted.length` dynamically, resolving both 1-byte, 32-byte, and fallback values safely on-chain.

#### 2. Manual Nonce Tracking in Fast-Mining Nodes
*   **Friction**: When running background daemons in simulated fast-mining chains (such as EDR), Ethers' built-in nonce tracker fails under high-frequency consecutive transactions (e.g., verifying a trigger and immediately marking as executed), leading to `nonce too low` errors.
*   **Solution**: Bypassed local signer nonce caching by manually querying `wallet.provider.send("eth_getTransactionCount", ...)` before submitting each critical transaction.

---

## Day 6-7 — Live Sepolia Testnet Deployment

### Core Metrics (Ethereum Sepolia)
*   **Client Price Encryption**: ~5.03s
*   **TEE Async Comparison Latency**: ~1.80s (Real unwrap phase time in hardware)
*   **Off-chain Execution Payload Decryption**: ~6.31s
*   **Total Off-chain Latency Overhead**: ~13.14s

### Friction Points & Solutions

#### 1. Testnet Subgraph Indexer Latency
*   **Friction**: Access permissions for off-chain decryption (`decrypt()`) are checked by the Nox Handle Gateway against blockchain state. On live testnets, the gateway uses a subgraph indexer. Because subgraph indexing has a block-level delay, calling `decrypt()` immediately after the `verifyTrigger` transaction confirms returns a `403 Access denied: not a viewer` error.
*   **Solution**: Wrapped all decryption calls in the Relayer daemon and demo script inside a robust retry loop (polling every 4 seconds for up to 15 attempts) to give the subgraph indexer enough time to sync the permission grant event.

#### 2. EDR Simulated Port Conflicts
*   **Friction**: Spawning TypeScript daemons in mocha integration tests using `npx tsx` spawns independent Node processes wrapped under `npx`. If a test crashes or calls `.kill()`, the `npx` wrapper process is terminated but the underlying runner remains orphaned, keeping port handles active and blocking subsequent test runs.
*   **Solution**: Configured child processes to spawn `node` directly with the TSX CLI path (`node_modules/tsx/dist/cli.mjs`), ensuring that calling `.kill()` on the child process terminates the JS runtime directly.

---

## Day 8-13 — SDK Refactoring, Gnosis Safe Integration & Performance Optimization

### Core Metrics (Ethereum Sepolia - 484-byte payload, 16 chunks)
*   **Client Parameters Encryption (16 handles)**: ~18.9s
*   **TEE Async Comparison Latency**: ~12.0s
*   **Off-chain Decryption Latency (Sequential)**: ~35.4s
*   **Off-chain Decryption Latency (Parallel)**: **~18.1s** (50% speedup)

### Friction Points & Solutions

#### 1. Code-absence on Mainnet Singleton Addresses on Sepolia
*   **Friction**: The standard mainnet Gnosis Safe L1 Master Copy address `0xd9db270c1b5e3bd161e8c8503c55ceabee896567` is not deployed or has no code on Ethereum Sepolia. Deploying a proxy pointing to it results in successful transactions (factory deploys the proxy structure), but subsequent calls (e.g. `nonce()`, `execTransaction()`) fail silently and return empty data `0x` because the underlying `delegatecall` targets an empty address.
*   **Solution**: Wrote a diagnostic script to check the contract code existence of Safe Master copies on Sepolia. Discovered that the correct L1 standard singleton address is `0x69f4d1788e39c87893c980c06edf4b7f686e2938` which has code deployed (45,918 bytes). Updated the deployment script to target this address.

#### 2. Sequential Decryption Bottlenecks for Large Data Payloads
*   **Friction**: For large payloads (like Gnosis Safe's `execTransaction` requiring 484 bytes/16 chunks), decrypting the target and each calldata chunk sequentially results in linear network round-trip overhead. With gateway processing and round-trips taking ~1.6s per call, 17 sequential calls stack up to ~27 seconds of network latency.
*   **Solution**: Parallelized the chunk decryption process. Once the first handle (the target address) successfully decrypts (confirming that the subgraph has synchronized), the relayer SDK executes all remaining calldata handle decryption calls in parallel using `Promise.all(...)`. This collapses the 16 sequential network round-trips into a single concurrent batch, reducing the decryption latency from ~35.4s to ~18.1s (which includes the ~12s block indexer delay).

#### 3. Strict Template Literal Address Verification in JS SDK
*   **Friction**: The iExec Nox JS SDK enforces strict template-literal checks on hex addresses (`0x${string}`) and URLs (`https://${string}` / `http://${string}`). Declaring parameters as standard TypeScript `string` types causes compile-time errors during the Vite build.
*   **Solution**: Updated the custom `ArcanaClientOptions` interface properties to match the exact template-literal type signatures expected by the SDK, resolving all Vite bundling compilation errors.
