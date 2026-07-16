# skill.md — Nox protocol ground truth

Everything below was verified directly from official Nox sources (docs.noxprotocol.io,
github.com/iExec-Nox) as of this project's research. **Do not use any Nox function, endpoint,
or parameter not listed here without checking the source first.** If unsure, fetch the linked
doc page rather than guessing — a plausible-sounding but wrong Nox API call is a common and
costly failure mode.

## Core concepts

- **Handle**: 32-byte identifier referencing an encrypted value stored in the Handle Gateway.
  Does not contain ciphertext itself.
- **Three phases**: Input (user encrypts, submits handle to a contract) → Compute (off-chain,
  async — Runner picks up event, computes, re-encrypts, posts result) → Output (authorized
  party requests decryption delegation, decrypts locally).
- **Async, not atomic.** A contract call using `NoxCompute` ends before the result exists. The
  result handle is populated later, off-chain, by the Runner. Design around this — don't assume
  a result is available in the same transaction.
- **KMS never sees plaintext.** It does decryption delegation only (computes ECDH shared
  secret, encrypts it to the requester's key). Actual decryption happens client-side or
  Runner-side.

## Access Control (ACL)

| Permission | Granted by | Capability |
|---|---|---|
| Admin | `ACL.allow()` | Use handle as computation input, manage permissions |
| Transient | Automatic (NoxCompute) | One-time use within current tx, cleared after |
| Viewer | `ACL.addViewer()` | Decrypt the data via Handle Gateway |
| Public | `ACL.allowPublicDecryption()` | Anyone can decrypt |

Result handles get automatic **Transient** access for the calling contract only. To use a
result handle in a later transaction, the contract must call `ACL.allow()` to persist access.

## Runner — confirmed supported operators (from `nox-runner` README, source-verified)

**Encryption**
| Type | Description |
|---|---|
| `wrap_as_public_handle` | Marks a handle as publicly decryptable |

**Arithmetic**
| Type | Fields |
|---|---|
| `add`, `sub`, `mul`, `div` | `leftHandOperand`, `rightHandOperand`, `result` |
| `safe_add`, `safe_sub`, `safe_mul`, `safe_div` | same + `success` bool (overflow/underflow/div-by-zero detection) |

**Boolean comparisons** — all return a single `bool` result handle
| Type | Meaning |
|---|---|
| `eq` | equal |
| `ne` | not equal |
| `ge` | greater than or equal |
| `gt` | greater than |
| `le` | less than or equal |
| `lt` | less than |

**Control flow**
| Type | Fields | Behavior |
|---|---|---|
| `select` | `condition`, `ifTrue`, `ifFalse`, `result` | Ternary: returns `ifTrue` if condition non-zero, else `ifFalse` |

**Token operations**
| Type | Fields |
|---|---|
| `transfer` | `balanceFrom`, `balanceTo`, `amount` → `success`, `newBalanceFrom`, `newBalanceTo` |
| `mint` | `balanceTo`, `amount`, `totalSupply` → `success`, `newBalanceTo`, `newTotalSupply` |
| `burn` | `balanceFrom`, `amount`, `totalSupply` → `success`, `newBalanceFrom`, `newTotalSupply` |

**Supported types**: `bool`, `uint16`, `uint256`, `int16`, `int256` (32-byte big-endian encoded).

## Runner output path (why Arcana needs its own relayer)
Confirmed: once all events in a transaction are computed, the Runner submits all result
handles to the Handle Gateway in **one** `POST /v0/compute/results` call. That is its entire
output responsibility — no callback, no webhook, no arbitrary contract execution. Any
"decrypt and then act on a public protocol" step is application-level infrastructure you
build (see `design.md`'s relayer service).

## Solidity Library — core primitives (reference names, verify signatures before use)
- Wrap as Public Handle
- `fromExternal` — validates a user-submitted handle + EIP-712 proof
- Arithmetic / Safe Arithmetic
- Comparisons
- `select`
- Access Control (`ACL.allow`, `ACL.addViewer`, `ACL.allowPublicDecryption`)
- Token Operations (advanced)

Full reference: https://docs.iex.ec/nox-protocol/references/solidity-library/getting-started

## JS SDK — methods (reference names, verify signatures before use)
- `encryptInput` — encrypt a plaintext value, get back a handle + EIP-712 proof
- `decrypt` — Output-phase decrypt request (this is what your relayer calls)
- `publicDecrypt` — decrypt a publicly-decryptable handle
- `viewACL` — check ACL state on a handle

Full reference: https://docs.iex.ec/nox-protocol/references/js-sdk/getting-started

## Confidential token reference (not core to Arcana, but useful pattern)
ERC-20 ↔ ERC-7984 wrapper: wrap is a single atomic tx; unwrap requires a burn + off-chain
decrypt + `finalizeUnwrap()` with a decryption proof (two-step, same async pattern as above).
Guide: https://docs.iex.ec/nox-protocol/guides/build-confidential-tokens/erc20-to-erc7984-wrapper

## Network
Ethereum Sepolia confirmed live/operational on Nox status page (status.noxprotocol.io) as of
this project's research. Re-check before deploying if picking this up after a gap — infra
status can change.

## If you need something not in this file
Stop. Fetch the relevant page from docs.iex.ec / docs.noxprotocol.io or check
github.com/iExec-Nox source directly. Do not guess a function name or endpoint shape.
