// SPDX-License-Identifier: MIT
// ProofGuard end-to-end tests (run with `npm test`).
// Requires artifacts first: `npm run setup`.
//
// Covers:
//   1. Valid task -> APPROVE (exit 0), proof verifies, and the public signals
//      are EXACTLY the ones from the independently verified proof demo
//      (same inputs must give the same public signals).
//   2. Each of the 4 trap tasks -> REJECT (exit 2), the broken check is named,
//      and the rejection proof still verifies (a correct REJECT is provable).
//   3. Enforcement: forcing decision=1 on any trap task MUST make proof
//      generation fail — the circuit refuses to prove a wrong APPROVE.
//   4. Determinism: the same task twice gives identical public signals
//      (the proof itself is randomized, the statement is not).
'use strict';

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { buildCircuitInput } = require('../src/policy');
const prove = require('../src/prove');

const REPO_ROOT = path.resolve(__dirname, '..');
const CLI = path.join(REPO_ROOT, 'src', 'cli.js');
const EXAMPLES = path.join(REPO_ROOT, 'examples');
const ARTIFACTS = path.join(REPO_ROOT, 'artifacts');

// Public signals of the verified demo (proof-demo/public.json) for the valid
// task. Same inputs -> same public signals, whatever the proof randomness.
const EXPECTED_VALID_PUBLIC_SIGNALS = [
  '12323340925438738127420192643565448825530862059055456170353074110991211222301',
  '4836144126773920907502496244340012141761656471453348073975163706578152814510',
  '4836144126773920907502496244340012141761656471453348073975163706578152814510',
  '1000',
  '1460',
  '8430000',
  '8420000',
  '103929005307927756724354605802047639613112342136',
  '103929005307927756724354605802047639613112342136',
  '500',
  '1000',
  '1',
  '42',
];

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok });
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${name}${detail ? ` — ${detail}` : ''}`);
  return ok;
}

function runCli(args, cwd) {
  return spawnSync(process.execPath, [CLI, ...args], { cwd, encoding: 'utf8' });
}

async function main() {
  console.log('ProofGuard tests');
  const artifacts = prove.artifactPaths(ARTIFACTS);
  for (const f of Object.values(artifacts)) {
    if (!fs.existsSync(f)) {
      console.error(`Missing artifact: ${f}\nRun "npm run setup" first, then "npm test".`);
      process.exit(1);
    }
  }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'proofguard-test-'));
  let allOk = true;

  // --- 1. valid task ---
  console.log('1. valid task (examples/task-valid.json)');
  const validOut = path.join(tmp, 'valid');
  let r = runCli(['guard', path.join(EXAMPLES, 'task-valid.json'), '--out', validOut], REPO_ROOT);
  allOk = check('valid: exit code 0 (APPROVE)', r.status === 0, `exit=${r.status}`) && allOk;
  allOk = check('valid: output says APPROVE', r.stdout.includes('Decision: APPROVE')) && allOk;
  const validPublic = JSON.parse(fs.readFileSync(path.join(validOut, 'public.json'), 'utf8'));
  allOk = check(
    'valid: public signals match the verified demo exactly',
    JSON.stringify(validPublic) === JSON.stringify(EXPECTED_VALID_PUBLIC_SIGNALS),
    `commitment=${validPublic[0].slice(0, 20)}...`
  ) && allOk;
  r = runCli(['verify', '--proof', path.join(validOut, 'proof.json'), '--public', path.join(validOut, 'public.json')], REPO_ROOT);
  allOk = check('valid: standalone verify says OK', r.status === 0 && r.stdout.includes('OK')) && allOk;

  // --- 2. trap tasks ---
  const traps = [
    ['task-trap-low-balance.json', 'balance'],
    ['task-trap-amount-over-max.json', 'amount'],
    ['task-trap-recipient-mismatch.json', 'recipient'],
    ['task-trap-expired.json', 'expiry'],
  ];
  for (const [file, failingCheck] of traps) {
    console.log(`2. trap task (${file})`);
    const out = path.join(tmp, file.replace('.json', ''));
    r = runCli(['guard', path.join(EXAMPLES, file), '--out', out], REPO_ROOT);
    allOk = check(`${file}: exit code 2 (REJECT)`, r.status === 2, `exit=${r.status}`) && allOk;
    allOk = check(`${file}: output says REJECT`, r.stdout.includes('Decision: REJECT')) && allOk;
    allOk = check(`${file}: names the failing check`, r.stdout.includes(`[FAIL] ${failingCheck}:`)) && allOk;
    const decision = JSON.parse(fs.readFileSync(path.join(out, 'decision.json'), 'utf8'));
    allOk = check(`${file}: decision.json says REJECT + proofVerified`, decision.decision === 'REJECT' && decision.proofVerified === true) && allOk;
    r = runCli(['verify', '--proof', path.join(out, 'proof.json'), '--public', path.join(out, 'public.json')], REPO_ROOT);
    allOk = check(`${file}: rejection proof verifies OK`, r.status === 0 && r.stdout.includes('OK')) && allOk;
  }

  // --- 3. enforcement: decision=1 on a trap must fail proof generation ---
  console.log('3. enforcement (force decision=1 on trap tasks — must FAIL to prove)');
  for (const [file] of traps) {
    const raw = JSON.parse(fs.readFileSync(path.join(EXAMPLES, file), 'utf8'));
    const { input } = buildCircuitInput(raw, { forceDecision: '1' });
    let threw = false;
    try {
      await prove.generateProof(input, artifacts.wasmPath, artifacts.zkeyPath);
    } catch {
      threw = true;
    }
    allOk = check(`${file}: forced APPROVE proof generation fails`, threw) && allOk;
  }

  // --- 4. determinism ---
  console.log('4. determinism (same valid task twice)');
  const validOut2 = path.join(tmp, 'valid-again');
  r = runCli(['guard', path.join(EXAMPLES, 'task-valid.json'), '--out', validOut2], REPO_ROOT);
  const validPublic2 = JSON.parse(fs.readFileSync(path.join(validOut2, 'public.json'), 'utf8'));
  allOk = check('valid: public signals identical across runs', JSON.stringify(validPublic) === JSON.stringify(validPublic2)) && allOk;

  const passed = results.filter((x) => x.ok).length;
  console.log(`\n${passed}/${results.length} checks passed.`);
  fs.rmSync(tmp, { recursive: true, force: true });
  // Drain stdout before exiting: snarkjs leaves worker handles open, so an
  // explicit exit is required (same reason as in src/cli.js).
  await new Promise((resolve) => process.stdout.write('', resolve));
  process.exit(allOk ? 0 : 1);
}

main().catch(async (err) => {
  console.error(`Test runner crashed: ${err.message}`);
  await new Promise((resolve) => process.stdout.write('', resolve));
  process.exit(1);
});
