# Expected outputs

All runs below assume `npm run setup` has been done once (artifacts in
`./artifacts/`). Exit codes: 0 = APPROVE, 2 = REJECT, 1 = error.

## Valid task — `examples/task-valid.json`

Balance 1460 >= minimum 1000, amount 500 <= max 1000, recipient matches,
current block 8420000 < expiry block 8430000, vk matches the registered
gatekeeper key. Expected: **APPROVE**, exit 0, proof verifies OK.

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

The public signals must be exactly the ones from the independently verified
proof demo (same inputs give the same public signals):

```json
["12323340925438738127420192643565448825530862059055456170353074110991211222301",
 "4836144126773920907502496244340012141761656471453348073975163706578152814510",
 "4836144126773920907502496244340012141761656471453348073975163706578152814510",
 "1000", "1460", "8430000", "8420000",
 "103929005307927756724354605802047639613112342136",
 "103929005307927756724354605802047639613112342136",
 "500", "1000", "1", "42"]
```

## Trap: low balance — `examples/task-trap-low-balance.json`

publicBalance 800 < minimum 1000. Expected: **REJECT**, exit 2, the `balance`
check shows `[FAIL]`, and the rejection proof still verifies OK (a correct
REJECT is provable with decision=0).

## Trap: amount over max — `examples/task-trap-amount-over-max.json`

amount 1500 > maxTransfer 1000. Expected: **REJECT**, exit 2, `[FAIL] amount:`.

## Trap: recipient mismatch — `examples/task-trap-recipient-mismatch.json`

recipient `0x0000…0001` != conditionRecipient `0x1234…5678`. Expected:
**REJECT**, exit 2, `[FAIL] recipient:`.

## Trap: expired — `examples/task-trap-expired.json`

currentBlock 8430001 > expiryBlock 8430000. Expected: **REJECT**, exit 2,
`[FAIL] expiry:`.

## Enforcement (checked by `npm test`)

For every trap task, building a proof with decision forced to `1` (a forged
APPROVE) **must fail** — the circuit refuses to prove a wrong decision.
`npm test` asserts this for all four traps.
