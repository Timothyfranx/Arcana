# Arcana — Hackathon Demo Video Script Outline (3.5 Minutes)

This script provides a step-by-step walkthrough for recording the hackathon submission video for **Arcana: Confidential Intent Relay on iExec Nox**.

---

## Part 1: Introduction & Core Value Proposition (0:00 – 0:30)

*   **Visual**: Screen showing the GitHub repository (`Timothyfranx/Arcana`) and the architecture diagram from `README.md`.
*   **Voiceover**:
    > "Welcome! This is Arcana, a Confidential Intent Relay built on the iExec Nox protocol. 
    > Traditional Web3 intent relays force users to publish target contract addresses and execution calldata to public mempools or on-chain state, exposing users to MEV frontrunning and privacy leaks.
    > Arcana solves this by keeping intent targets, calldata parameters, and execution thresholds fully encrypted inside TEE hardware until trigger conditions are met. Crucially, Arcana routes these encrypted payloads through **existing, unmodified, real-world protocols**."

---

## Part 2: Architecture & How It Works (0:30 – 1:15)

*   **Visual**: Display the `README.md` sequence diagram highlighting the 3 roles (User, Keeper, Relayer).
*   **Voiceover**:
    > "Arcana operates in three distinct phases:
    > First, the **User** encrypts target contract addresses and calldata chunks client-side using our reusable `ArcanaClient` SDK before submitting handles on-chain.
    > Second, a **Keeper** periodically evaluates real-time market conditions by querying live **Chainlink Sepolia Price Feeds**, encrypting the market price, and triggering an off-chain TEE comparison inside iExec Nox enclaves.
    > Third, once the TEE verifies the price threshold, the contract dynamically grants viewer permissions to the **Relayer**, which decrypts the payload off-chain and dispatches the execution transaction directly to the target protocol."

---

## Part 3: Headline Demo — Gnosis Safe Payout on Sepolia (1:15 – 2:30)

*   **Visual**: Terminal window running `npx hardhat run scripts/demo_safe.ts --network sepolia`.
*   **Voiceover**:
    > "Let's look at our headline demonstration. Rather than relying on custom mock contracts, we deploy a standard, unmodified **Gnosis Safe Proxy (v1.3.0)** on Ethereum Sepolia.
    > Here, the user signs a Safe `execTransaction` payload to trigger a treasury payout. The SDK encrypts the Safe target address and signature payload client-side into 16 handles.
    > The keeper queries the live Chainlink ETH/USD aggregator on Sepolia to verify the trigger.
    > Once verified, our relayer decrypts all 16 handles concurrently using our optimized **parallelized decryption architecture**, cutting decryption latency in half from 35.4s down to 18.1s.
    > As you can see on terminal output, the relayer dispatches the transaction to the Gnosis Safe, which executes the payout and increments its internal nonce from 0 to 1!"

---

## Part 4: Web3 Dashboard Walkthrough (2:30 – 3:15)

*   **Visual**: Browser window displaying `http://localhost:5173/` running the Vite dashboard.
*   **Voiceover**:
    > "We also built a clean, production-grade Web3 dashboard. Users can connect their MetaMask wallet, select their target protocol — such as the Gnosis Safe Multisig or an internal swap fixture —, specify transfer parameters, and encrypt them client-side via the SDK.
    > The dashboard renders active intent statuses live, tracking pending, triggered, and executed states without ever exposing plaintext data."

---

## Part 5: Conclusion & Summary (3:15 – 3:30)

*   **Visual**: Display `report.md` key achievements and benchmark latency table.
*   **Voiceover**:
    > "Arcana validates a protocol-agnostic design against a real, unmodified Gnosis Safe deployment, features a 48.7% parallelized decryption speedup, integrates live Chainlink price feeds, and ships with a standalone TypeScript SDK. Thank you for watching!"
