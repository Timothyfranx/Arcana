# Arcana Project Upgrades & Implementation Plan (`upgrades.md`)

This document outlines the strategic roadmap, executed upgrades, and technical verifications implemented across the Arcana project workspace.

---

## 1. Executive Summary & Repositioning Strategy

| Area | Strategic Focus | Status |
| :--- | :--- | :--- |
| **Headline Integration** | Position **Gnosis Safe Multisig Proxy (v1.3.0)** as the primary, real-world integration everywhere (README, scripts, frontend). Frame `MockSwapContract.sol` strictly as an internal development fixture. | ✅ **Completed** |
| **Real-World Price Oracle** | Upgrade Keeper daemon to query live **Chainlink ETH/USD Aggregators** on Sepolia (`0x694AA1769357215DE4FAC081bf1f309aDC325306`) with dynamic `decimals()` resolution. | ✅ **Completed** |
| **Multi-Condition Encrypted Triggers** | Extend `IntentRelay.sol` to perform on-chain boolean composition (`AND` / `OR`) over multiple encrypted handles inside iExec Nox TEE enclaves without exposing intermediate results. | ✅ **Completed** |
| **On-Chain Verification & Proofs** | Verify `IntentRelay` source code on **Blockscout/Sourcify** and embed clickable live Etherscan transaction links in `README.md`. | ✅ **Completed** |

---

## 2. Detailed Technical Upgrade Specs

### Upgrade 1: Gnosis Safe Headline Repositioning
*   **Core Changes**:
    *   Updated [`README.md`](file:///home/replytim/Desktop/Arcana/README.md) to showcase `scripts/demo_safe.ts` and the Gnosis Safe payout flow as the primary integration.
    *   Updated [`frontend/index.html`](file:///home/replytim/Desktop/Arcana/frontend/index.html) and [`frontend/src/main.ts`](file:///home/replytim/Desktop/Arcana/frontend/src/main.ts) with a **Target Protocol Selector** dropdown.
    *   Users can select between **Gnosis Safe Multisig Payout (Real Protocol — Sepolia)** and **Uniswap Swap Mock (Internal Test Fixture)**, generating EOA owner signatures and client-side handle encryptions directly from MetaMask.

### Upgrade 2: Chainlink Price Feed Oracle Integration
*   **Core Changes**:
    *   Integrated Chainlink Sepolia ETH/USD Aggregator (`0x694AA1769357215DE4FAC081bf1f309aDC325306`) into [`src/keeper.ts`](file:///home/replytim/Desktop/Arcana/src/keeper.ts).
    *   Dynamically reads `decimals()` from the feed to calculate unit conversion (`rawPrice / 10**decimals`), eliminating hardcoded divisor assumptions.
    *   Includes fallback handling for local offline testing environments.

### Upgrade 3: Multi-Condition Encrypted Boolean Composition
*   **Core Changes**:
    *   Updated [`contracts/IntentRelay.sol`](file:///home/replytim/Desktop/Arcana/contracts/IntentRelay.sol) with `LogicOp` (`NONE`, `AND`, `OR`) and `_evaluateOp` helper.
    *   Added `submitIntentMultiCondition` and `requestTriggerCheckMulti`.
    *   Executes `INoxCompute(noxCompute).and(res1, res2)` or `or(res1, res2)` inside TEE enclaves to produce a single composite result handle.
    *   Added comprehensive unit test in [`test/KeeperLoop.test.ts`](file:///home/replytim/Desktop/Arcana/test/KeeperLoop.test.ts) validating `AND` boolean composition.

### Upgrade 4: On-Chain Source Verification & Etherscan Linking
*   **Core Changes**:
    *   Verified `IntentRelay` contract on Blockscout and Sourcify at address `0x9BF3f5db0442a59A074B728cD23F719D57375A9b`.
    *   Added clickable Etherscan links for all 7 pipeline transactions in `README.md`.
    *   Added negative-path test for unauthorized `markExecuted` callers.

---

## 3. Verification & Test Matrix

| Component | Test / Verification Command | Result |
| :--- | :--- | :--- |
| **Smart Contracts & Nox** | `npx hardhat test` | ✅ 5 Passing Suites |
| **Contract Verification** | `npx hardhat verify --network sepolia <args>` | ✅ Verified on Blockscout & Sourcify |
| **Frontend Production Build** | `cd frontend && npm run build` | ✅ Built in 9.57s (0 errors) |
| **Frontend Dev Server** | `cd frontend && npm run dev` | ✅ Active at `http://localhost:5173/` |
| **Chainlink Feed** | `npx tsx src/test_chainlink.ts` | ✅ Live Sepolia Price Fetched ($1855.89) |
