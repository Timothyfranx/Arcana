# Nox Protocol & iExec Developer Experience Feedback

## Executive Summary

Building **Arcana** on top of the Nox TEE stack has been an extremely rewarding experience. The capability to perform arithmetic comparison and conditional selection inside hardware enclaves on-chain is a game-changer for confidential DeFi. 

Below is constructive developer feedback gathered during live testnet deployment on Ethereum Sepolia and local Hardhat integration testing.

---

## 1. Developer Experience & Documentation

### A. ACL & Handle Attribute Visibility
* **Insight**: Understanding the difference between input handles (`ATTR_IS_UNIQUE`, attribute byte `0x01` / `0x23`) and TEE-computed result handles (attribute byte `0x00`) was crucial during debugging.
* **Suggestion**: Adding an explicit handle inspection guide or SDK helper method (e.g. `client.inspectHandleAttributes(handle)`) in the documentation will help developers instantly identify whether a handle is an encrypted input vs. a TEE-computed output.

### B. Persistent vs. Transient Access Patterns
* **Insight**: Computed result handles require explicit `INoxCompute.allow(resultHandle, address(this))` authorization before calling `allowPublicDecryption(resultHandle)`.
* **Suggestion**: Documenting the explicit lifecycle requirement of calling `allow()` prior to `allowPublicDecryption()` in the core smart contract integration guides will save developers time during initial setup.

---

## 2. JavaScript / TypeScript SDK (`@iexec-nox/nox-sdk`)

### A. Arbitrary-Length Bytes Encryption Support
* **Current Limitation**: The SDK currently encrypts 32-byte numeric types (`uint256`). For generic DeFi calldata (such as Gnosis Safe multisig executions or Uniswap swap payloads), applications must manually chunk, pad, and reconstruct multi-segment payloads.
* **Feature Request**: Native SDK support for encrypting arbitrary-length byte arrays (`bytes`) by automatically chunking and reassembling them under the hood.

### B. Built-In RPC Batching & Retry Backoff
* **Insight**: High-frequency SDK calls over public RPC endpoints can trigger batch size limits (`error -32014: too many RPC calls in batch request`).
* **Suggestion**: Incorporate configurable batching options (`batchMaxCount: 1`) and linear backoff into the SDK's internal `JsonRpcProvider` wrappers.

---

## 3. Testnet Gateway & KMS Infrastructure

### A. Gateway Status Messages
* **Insight**: When polling public decryption proofs via `https://gateway-testnets.noxprotocol.dev/v0/public/{handle}`, transient KMS queue delays return generic HTTP errors or timeouts.
* **Suggestion**: Provide detailed JSON status responses (e.g., `{"status": "QUEUED", "estimatedSeconds": 5}`) to allow client applications to render progress indicators to users.

---

## 4. Highlights & Praise

* **Local Hardhat Plugin (`@iexec-nox/nox-hardhat-plugin`)**: The Docker-backed local TEE stack is **top-tier**. Being able to test full TEE enclaves, handle registration, and public unwrapping in `< 500ms` during `npx hardhat test` made local integration testing smooth and reliable.
* **Solidity TEE Primitives**: The `_evaluateOp`, `select`, and `wrapAsPublicHandle` interface design is intuitive and elegant for composing complex logic on secret data.

---

*Thank you to the Nox and iExec core engineering teams for building powerful confidential compute tools and supporting developers throughout this hackathon!*
