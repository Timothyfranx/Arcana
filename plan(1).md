# plan.md — Arcana build plan

Solo, ~1-2 weeks, balanced full-stack. iExec WTF Hackathon.

## Judging criteria (weighted) — keep this visible while prioritizing
- ⭐⭐⭐ Creativity
- ⭐⭐⭐ Works end-to-end, **no mock data**
- ⭐⭐ Deployed on ETH Sepolia
- ⭐⭐ `feedback.md` on the iExec tools, in the repo
- ⭐⭐ 4-min max demo video
- ⭐ Technical implementation quality (Nox leverage)
- ⭐ UX

**Implication:** a working, honestly-scoped core loop beats a broad but flaky one. "No mock
data" and "creativity" are tied for highest weight — don't trade either away for breadth.

## MVP scope (build this, nothing more, until it's solid)
1. `IntentRelay.sol` deployed on Sepolia
2. One working intent lifecycle: submit (encrypted trigger+target+calldata) → encrypted
   trigger check → ACL grant → relayer decrypt → relayer executes against **one** real,
   unmodified target protocol (Uniswap swap) → status updated
3. Minimal frontend: submit intent, watch status change live
4. `feedback.md` — updated daily, not written from memory at the end

## Explicitly out of scope unless MVP is done early
- A second target protocol (Safe payout) — stretch only
- Private/protected mempool submission for the final tx — stretch only, mention as future work
  in the demo even if not built
- Decentralized keeper network — your own relayer polling is fine
- Wallet extension integration
- Multi-chain support
- Generic arbitrary-ABI intent builder — hardcode the Uniswap call shape for the MVP

## Day-by-day

**Day 1 — Environment + first round trip**
- Set up Hardhat + Nox plugin, deploy a trivial NoxCompute-using contract to Sepolia
- Run one real encrypt → compute → decrypt round trip using the JS SDK, time it
- Deliverable: you've personally confirmed the async latency (this de-risks everything else)

**Day 2-3 — `IntentRelay.sol` core**
- `submitIntent`, `checkTrigger` (encrypted comparison), ACL grant on trigger, `markExecuted`
- Unit tests against local/testnet for the comparison logic specifically
- Deliverable: an intent can be submitted and triggered manually (fake current-value input),
  ACL grant is observably correct (viewer can decrypt, non-viewer cannot)

**Day 4-5 — Relayer service**
- Event listener → Output-phase decrypt flow → tx construction
- Test against the Uniswap testnet pool/router directly first (no encryption) to confirm the
  swap call shape works at all, then wire in the decrypt step
- Deliverable: relayer end-to-end on a manually-triggered intent, executes a real Sepolia swap

**Day 6-7 — Keeper + real trigger loop**
- Simple polling keeper that feeds current price and calls `checkTrigger`
- Wire the full loop: submit → wait for real price condition → auto-trigger → auto-execute
- Deliverable: the full loop runs unattended once, start to finish, on Sepolia

**Day 8-9 — Frontend**
- Submit form (trigger price, swap params), live status view
- Deliverable: someone other than you can submit an intent through the UI and watch it execute

**Day 10 — Hardening pass**
- Re-run the full loop 3-5 times, fix flakiness
- Check for accidental plaintext leakage anywhere (logs, API responses, frontend state)
- Confirm `agents.md` rule 3 (no plaintext leakage) actually holds under inspection

**Day 11-12 — Demo, README, feedback.md, buffer**
- Record the 4-min demo showing a real trigger firing live if possible; if timing is too slow
  for live demo, say so honestly and show a recent recorded run — don't fake it
- Finish README (install/deploy/usage), finalize `feedback.md`
- Buffer day for whatever broke

## Daily discipline
- Update `feedback.md` with friction points same day, not retroactively
- At the end of each day, know explicitly what's "implemented" vs "verified end-to-end" — see
  `agents.md` reporting format
- If a day's task balloons past its slot, cut scope (drop the stretch items first), don't
  compress the hardening/demo days
