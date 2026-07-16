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

