# ProofGuard

An off-chain Web3 payment guard for the zkVerify **Agent Games** (Wildcard
track). Give it a payment task; it runs deterministic policy checks and then
**proves its decision** with a local Groth16 proof using the official
Agent Games gatekeeper circuit — so a wrong decision cannot be proven at all.

```
payment task (JSON)
      │
      ▼
deterministic policy checks          decision = 1 ⟺ every check passes
  balance · amount · recipient · expiry · verification key
      │
      ▼
Groth16 proof (snarkjs, local)  ──►  verified locally before output
      │
      ▼
APPROVE / REJECT  +  proof.json  +  public.json  +  decision.json
```

## What it proves

For a payment task (`minimum`, `publicBalance`, `amount`, `maxTransfer`,
`expiryBlock`, `currentBlock`, `recipient`, `conditionRecipient`) the agent
decides **APPROVE** only when every check passes:

| check | rule |
|---|---|
| `balance` | `publicBalance >= minimum` |
| `amount` | `amount <= maxTransfer` |
| `recipient` | `recipient == conditionRecipient` |
| `expiry` | `currentBlock < expiryBlock` |
| `vk` | `registeredVkHash == proofVkHash ==` official gatekeeper vk hash |

The decision is then proven with the official gatekeeper circuit
(Groth16 / bn128, 13 input signals). The circuit enforces the same rule:
`decision == 1` **if and only if** all checks pass. That was verified
experimentally — forcing `decision=1` on a trap task makes proof generation
fail, and `decision=0` on a valid task fails too. A correct REJECT
(`decision=0` on a failing task) *does* produce a valid proof, so a
rejection is evidence as well, not just an absence of approval.

## Quick demo (3 steps)

```bash
npm install          # snarkjs only
npm run setup        # downloads the official circuit artifacts, checks sha256
npm test             # valid case -> APPROVE, 4 trap cases -> REJECT, enforcement checks
```

Or run the guard yourself:

```bash
npm run setup
node src/cli.js guard examples/task-valid.json
```

Expected output (exit code 0):

```
ProofGuard — payment guard (Groth16, gatekeeper circuit)
Task: examples/task-valid.json (taskId 42)
Checks:
  [PASS] balance: publicBalance 1460 >= minimum 1000
  [PASS] amount: amount 500 <= maxTransfer 1000
  [PASS] recipient: recipient == conditionRecipient
  [PASS] expiry: currentBlock 8420000 < expiryBlock 8430000
  [PASS] vk: registeredVkHash == proofVkHash == official gatekeeper vk hash
Decision: APPROVE (decision=1)
Proof: generated + verified locally (snarkjs groth16 verify: OK)
Files:
  proof:           out/proof.json
  public signals:  out/public.json
  summary:         out/decision.json
```

A trap task prints the same shape with `[FAIL]` on the broken check and
`Decision: REJECT (decision=0)` (exit code 2). See
[`examples/expected-output.md`](examples/expected-output.md) for all five cases.

Verify any proof later without re-running the guard:

```bash
node src/cli.js verify --proof out/proof.json --public out/public.json
# Proof verification: OK
```

## Commands

| command | what it does |
|---|---|
| `proofguard setup [--artifacts <dir>]` | Download `gatekeeper.wasm` + `gatekeeper_final.zkey` from `https://agentgames.zkverify.io/circuits/`, verify sha256 against the known official hashes, export `verification_key.json`. Default dir: `./artifacts`. |
| `proofguard guard <task.json> [--out <dir>] [--artifacts <dir>]` | Decide + prove + verify. Writes `proof.json`, `public.json`, `decision.json` to `--out` (default `./out`). Exit 0 = APPROVE, 2 = REJECT, 1 = error. |
| `proofguard verify --proof <p> --public <s> [--vk <vk.json>]` | Verify a proof against the local verification key. Exit 0 = OK, 1 = failed. |

## Task format

```json
{
  "taskId": "42",
  "minimum": "1000",
  "publicBalance": "1460",
  "amount": "500",
  "maxTransfer": "1000",
  "expiryBlock": "8430000",
  "currentBlock": "8420000",
  "recipient": "0x1234567890abcdef1234567890abcdef12345678",
  "conditionRecipient": "0x1234567890abcdef1234567890abcdef12345678",
  "salt": "123456789"
}
```

Numbers are decimal strings (hex `0x…` also accepted). `registeredVkHash` /
`proofVkHash` default to the official gatekeeper vk hash
(`0x6b79c6…d77b0`); supplying a different one is a `vk` failure. `salt` is
optional: when omitted it is derived deterministically (sha256 of the
canonical task, mod the bn128 field prime), so the same task always gives
the same public signals. `salt` is a *private* input — it never appears in
`public.json`.

## How it works

1. **`src/policy.js`** — validates the task, runs the five checks, builds the
   13-signal circuit input (`registeredVkHash`, `proofVkHash`, `minimum`,
   `publicBalance`, `expiryBlock`, `currentBlock`, `recipient`,
   `conditionRecipient`, `amount`, `maxTransfer`, `decision`, `taskId`,
   `salt`).
2. **`src/prove.js`** — snarkjs wrapper: `setupArtifacts` (download +
   sha256 + export vk), `generateProof` (`groth16.fullProve`),
   `verifyProof` (`groth16.verify`).
3. **`src/cli.js`** — the CLI. `guard` fails closed: if proof generation or
   local verification fails, no decision is emitted (exit 1).

Public signals order:
`[commitment, registeredVkHash, proofVkHash, minimum, publicBalance,
expiryBlock, currentBlock, recipient, conditionRecipient, amount,
maxTransfer, decision, taskId]`. The first element is a commitment bound to
`salt` + `taskId`.

## Honest limitations

- **Proofs are verified locally with snarkjs only.** Nothing is submitted to
  zkVerify mainnet (no Kurier, no API key) — this agent produces proofs, it
  does not settle them on-chain. Submitting a proof to Kurier is a separate
  step and is intentionally not included.
- **No HTTP endpoint.** This is an off-chain CLI, not a live Proof
  Gatekeeper endpoint — it does not implement the platform's HMAC/preflight
  protocol and cannot receive tasks from the Agent Games platform.
- **Inputs are claims, not on-chain facts.** `publicBalance`, `currentBlock`
  and the rest come from the task file you feed it. The proof shows the
  decision follows from those inputs; it does not show the inputs are true
  on-chain. Feeding it false inputs produces a valid proof of a false
  premise — garbage in, proven garbage out.
- **No secrets of any kind.** The agent holds no private key, seed, wallet
  or API key, and never makes a transaction. The only network use is
  `setup`, which downloads two public circuit files and checks their hashes.
- **One circuit, one job.** Only the gatekeeper circuit is supported; the
  vfy-policy circuit (Steal the VFY) is out of scope.

## Testing

See [`TESTING.md`](TESTING.md). `npm test` runs the valid case, all four
trap cases, the decision-forcing enforcement checks, and a determinism
check — all end-to-end through the real CLI.

## License

MIT — see [LICENSE](LICENSE).
