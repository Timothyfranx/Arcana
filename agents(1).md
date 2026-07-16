# agents.md — Arcana

Rules for any AI coding agent working in this repo. Read this before touching code.

## What Arcana is
A confidential intent relay built on iExec Nox (WTF Hackathon). Users submit encrypted
"intents" (a trigger condition + a target-protocol call, e.g. a Uniswap swap). The trigger
condition is evaluated as an encrypted comparison inside Nox — never decrypted on-chain.
Only once triggered does the contract grant a relayer service ACL Viewer access to the real
order details; the relayer decrypts and executes against the *unmodified* target protocol.

Full architecture: see `design.md`. Nox API ground truth: see `skill.md`. Timeline: see `plan.md`.

## Hard rules

1. **Never invent a Nox API.** Every Nox call (Solidity library function, JS SDK method, Runner
   operator) used in code must appear in `skill.md`'s reference tables. If you need something
   not listed there, STOP and say so explicitly — do not guess a plausible-looking function name,
   endpoint, or parameter. Fabricated APIs are the #1 failure mode on this project.
2. **Verify, don't summarize.** When you finish a task, do not report it "done" or "working"
   unless you have actually run it (compiled, tested, or executed against Sepolia/local) and
   seen the result. If you haven't run it, say "implemented but not yet verified."
3. **No plaintext leakage.** Order trigger values and target calldata must never be logged,
   printed to console, committed to git, or returned in any API response before the intended
   ACL-grant point. Treat any accidental plaintext exposure as a P0 bug, not a style issue.
4. **No secrets in the repo.** Relayer private key, RPC URLs with API keys, Handle Gateway
   credentials all go in `.env` (gitignored). Never hardcode.
5. **Flag scope creep.** If a task starts pulling in a second target protocol, a new chain,
   or a UI feature not in `plan.md`'s MVP list, stop and flag it rather than building it.

## Stack (confirmed choices — don't deviate without discussion)
- Contracts: Solidity, Hardhat, Nox Solidity Library, deployed on Ethereum Sepolia
- Relayer: Node/TypeScript service using the Nox JS SDK
- Frontend: minimal — order placement + status view, no design system needed
- Target integration #1 (MVP): Uniswap (swap trigger)
- Target integration #2 (stretch, only if time remains): Safe payout

## Definition of done for any task
- Code compiles / typechecks
- Ran against real Sepolia deployment or documented why not yet possible (no mock data in
  final submission — see judging criteria in `plan.md`)
- No plaintext of order details anywhere except inside the relayer's brief decrypt→submit window
- Any new Nox API usage is cited against `skill.md` or flagged as unverified

## When reporting status
Use this format, don't just narrate:
- **Claim:** what you're asserting is done
- **Evidence:** what you ran / what output you saw
- **Not yet verified:** anything you're inferring or haven't tested
