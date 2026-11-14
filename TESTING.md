# Testing ProofGuard

## Automated suite — `npm test`

`npm test` runs `test/run-tests.js`, which drives the real CLI end to end
(no mocks) and asserts:

1. **Valid task** (`examples/task-valid.json`) → APPROVE, exit 0, proof
   verifies, and the public signals are *exactly* the ones from the
   independently verified proof demo (same inputs give the same public
   signals — commitment
   `12323340925438738127420192643565448825530862059055456170353074110991211222301`).
2. **Four trap tasks** → REJECT, exit 2, the broken check is named, and the
   rejection proof still verifies (a correct REJECT with `decision=0` is
   provable).
3. **Enforcement** — for every trap, building a proof with `decision` forced
   to `1` (a forged APPROVE) must fail. The circuit refuses with
   `Error in template GatekeeperEvaluation_79 line: 102` (snarkjs prints that
   line to stderr; the test treats the throw as a pass).
4. **Determinism** — the same valid task run twice gives identical public
   signals.

## Clean-clone procedure (run before every push)

```bash
# fresh copy with no node_modules / artifacts / .git, as a clone would give you
rm -rf /tmp/proofguard-clean && mkdir -p /tmp/proofguard-clean
cp -r package.json README.md TESTING.md LICENSE .gitignore src examples test /tmp/proofguard-clean/
cd /tmp/proofguard-clean
npm install     # snarkjs only, from the npm registry
npm run setup   # downloads official artifacts, verifies sha256, exports vk
npm test        # full suite above
```

## Observed results — 15 Nov 2026

Environment: Node v24.22.1, npm 10.9.4, snarkjs 0.7.6, Linux x64.

- `npm install`: 35 packages, OK.
- `npm run setup`: `gatekeeper.wasm` sha256
  `be00aefe…92764f` OK, `gatekeeper_final.zkey` sha256 `adfe95a4…af80d` OK,
  verification key exported. OK.
- `npm test`: **29/29 checks passed in ~15 s**, exit 0:
  - valid → APPROVE (exit 0), public signals match the verified demo exactly,
    standalone `verify` says OK;
  - low-balance, amount-over-max, recipient-mismatch, expired → REJECT
    (exit 2) each naming its failing check, each rejection proof verifies OK;
  - forced `decision=1` proof generation fails on all four traps;
  - public signals identical across repeated runs.
- Clean-copy run in `/tmp/proofguard-clean` (no `node_modules`, no
  `artifacts`, no `.git`): install + setup + `npm test` all pass — the repo
  works from a bare clone.

## Known quirk — snarkjs keeps the process alive

`snarkjs` 0.7.6 leaves worker threads + sockets open after proving, so a
Node process that called `fullProve` / `exportVerificationKey` never exits
on its own (diagnosed 15 Nov 2026: after a successful proof, active handles
were 2× `Socket` + 4× `MessagePort`; the process sat idle until killed).
The CLI and the test runner therefore drain stdout and call
`process.exit(code)` explicitly — see the comment at the end of
`src/cli.js`. All output is written synchronously before that point, so
nothing is lost. This is a process-lifecycle workaround, not a change to
any proof logic.
