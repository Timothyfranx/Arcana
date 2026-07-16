# design.md — Arcana architecture

## One-liner
A generic confidential intent relay: hide a trigger condition and a target-protocol call
until execution, using Nox's encrypted comparisons — no modification to the target protocol.

## Privacy claim — stated precisely, don't overclaim
Arcana hides the intent (trigger price, order amount, target action) from the mempool and
from public view **before** the trigger fires. It does **not** make the final execution
transaction itself invisible or immune to front-running — that tx is a normal plaintext
transaction on the target protocol. Closing that last-mile gap (e.g. via a protected/private
mempool submission) is a stated stretch goal, not a core claim. Say this explicitly in
feedback.md and the demo. Overclaiming "impossible to front-run" is a real risk — don't do it.

## Why a custom relayer is required (verified, not assumed)
`nox-runner`'s documented output path ends with a single `POST /v0/compute/results` call to
the Handle Gateway. There is no built-in callback, webhook, or execution hook to arbitrary
contracts. This is confirmed from the `nox-runner` README (source-level, not marketing docs).
Arcana's relayer service is therefore necessary infrastructure, not a workaround.

## Components

### 1. `IntentRelay.sol`
On-chain contract. Holds encrypted intents as handles, runs the trigger check as an encrypted
comparison, and grants ACL access on trigger.

**`Intent` struct (conceptual — handle-backed fields for anything sensitive):**
- `owner` (plaintext address)
- `triggerConditionHandle` — encrypted comparison operand (e.g. price threshold)
- `targetHandle` — encrypted target contract address
- `calldataHandle` — encrypted calldata to forward
- `status` — plaintext enum: `Pending | Triggered | Executed | Cancelled`

**Functions:**
- `submitIntent(...)` — user encrypts trigger + target + calldata client-side (JS SDK
  `encryptInput`), submits handles. Status → `Pending`.
- `checkTrigger(intentId, currentValueHandle)` — anyone (a keeper, or the relayer itself) can
  call this with a current market-value handle. Runs an encrypted comparison
  (`ge`/`le`/`gt`/`lt` per `skill.md`) between `currentValueHandle` and
  `triggerConditionHandle`. If true: grant the relayer's address `Viewer` ACL on
  `targetHandle` and `calldataHandle` (via `ACL.addViewer()`), set status → `Triggered`,
  emit `IntentTriggered(intentId)`.
- `markExecuted(intentId)` — relayer-only, called after successful forward. Status → `Executed`.
- `cancelIntent(intentId)` — owner-only, before trigger.

### 2. Relayer service (off-chain, Node/TS)
- Listens for `IntentTriggered` events.
- On event: runs the standard Nox **Output** flow — generates ephemeral RSA keypair, sends
  EIP-712-signed decrypt request to the Handle Gateway, receives delegated key material,
  decrypts locally (this is the same flow any Nox user does; nothing special-cased).
- Assembles the real transaction (`target`, `calldata`) and submits it directly to the
  unmodified target protocol.
- Calls `markExecuted(intentId)`.
- Keep decrypt → submit as one tight sequential path in the same process. Don't add a queue
  or delay between them — that gap is exactly the exposure window described above.

### 3. Target integration (MVP: Uniswap)
No modification to Uniswap. The relayer's forwarded transaction is a normal
`swapExactTokensForTokens`-style call (or equivalent for the pool version chosen). The keeper
that calls `checkTrigger` needs a `currentValueHandle` — this can be a simple oracle: encrypt
the current pool price periodically (or on-demand) and feed it in. Keep this piece minimal;
it is not the differentiator, the encrypted trigger + relay pattern is.

### 4. Frontend
Minimal: connect wallet, submit an intent (trigger price + swap params), see intent status
(Pending/Triggered/Executed). No design system needed — function over polish, per judging
weights (end-to-end functionality > UX polish).

## Data flow (end to end)
1. User encrypts trigger price + target + calldata client-side → `submitIntent`.
2. Keeper periodically calls `checkTrigger` with current price (also encrypted).
3. Nox Runner computes the comparison off-chain, posts result handle back — contract logic
   reads that boolean result (via the standard result-handle pattern) and, if true, grants
   ACL Viewer to the relayer and emits `IntentTriggered`.
4. Relayer sees the event, decrypts `targetHandle`/`calldataHandle`, submits the real tx.
5. Contract marked `Executed`.

## Known limitations (be upfront about these)
- Final execution tx is a public, plaintext mempool transaction — no MEV protection unless
  you add private-mempool submission (stretch goal).
- Relayer is a single trusted off-chain component (same trust class as any keeper network —
  Chainlink Automation, Gelato). Not eliminated, just relocated and minimized in exposure time.
- `checkTrigger` needs someone to call it (a keeper) — for the hackathon, polling from your own
  relayer process is fine; don't over-build a decentralized keeper network.
