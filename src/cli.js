#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// ProofGuard CLI — off-chain Web3 payment guard for zkVerify Agent Games.
//
//   proofguard setup                      download official circuit artifacts + export vk
//   proofguard guard <task.json>          decide APPROVE/REJECT and prove it (Groth16, local)
//   proofguard verify --proof p --public s
//
// Exit codes: 0 = APPROVE / proof OK, 2 = REJECT (decision made, proof valid),
// 1 = error (bad input, missing artifacts, proof generation/verification failed).
// No network is used at decision time. No private keys, no transactions, no
// on-chain submission — this agent only proves decisions locally.
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { buildCircuitInput } = require('./policy');
const prove = require('./prove');

const REPO_ROOT = path.resolve(__dirname, '..');
const DEFAULT_ARTIFACTS_DIR = path.join(REPO_ROOT, 'artifacts');
const DEFAULT_OUT_DIR = path.join(process.cwd(), 'out');

function usage() {
  return [
    'ProofGuard — off-chain payment guard (Groth16 gatekeeper circuit)',
    '',
    'Usage:',
    '  proofguard setup [--artifacts <dir>]',
    '      Download the official gatekeeper circuit artifacts',
    '      (gatekeeper.wasm, gatekeeper_final.zkey) from',
    '      https://agentgames.zkverify.io/circuits/, verify their sha256,',
    '      and export verification_key.json. Default dir: ./artifacts',
    '',
    '  proofguard guard <task.json> [--out <dir>] [--artifacts <dir>]',
    '      Read a payment task, run the deterministic policy checks, generate',
    '      a Groth16 proof for the decision and verify it locally.',
    '      Writes proof.json, public.json and decision.json to --out',
    '      (default ./out). Exit 0 = APPROVE, 2 = REJECT, 1 = error.',
    '',
    '  proofguard verify --proof <proof.json> --public <public.json> [--vk <vk.json>]',
    '      Verify a proof against the local verification key.',
    '      Default vk: ./artifacts/verification_key.json',
    '',
    '  proofguard --help',
  ].join('\n');
}

function parseFlags(argv) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--out' || a === '--artifacts' || a === '--proof' || a === '--public' || a === '--vk') {
      if (i + 1 >= argv.length) throw new Error(`missing value for ${a}`);
      flags[a.slice(2)] = argv[++i];
    } else if (a.startsWith('--')) {
      throw new Error(`unknown flag: ${a}`);
    } else {
      positional.push(a);
    }
  }
  return { flags, positional };
}

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (err) {
    throw new Error(`cannot read JSON from ${filePath}: ${err.message}`);
  }
}

async function cmdSetup(flags) {
  const dir = path.resolve(flags.artifacts || DEFAULT_ARTIFACTS_DIR);
  console.log(`Downloading official gatekeeper artifacts to ${dir} ...`);
  const r = await prove.setupArtifacts(dir);
  console.log(`  gatekeeper.wasm      ${r.wasmSha256} (sha256 OK)`);
  console.log(`  gatekeeper_final.zkey ${r.zkeySha256} (sha256 OK)`);
  console.log(`  verification key exported to ${r.vkPath}`);
  console.log('Setup complete. Artifacts are public circuit files — no secrets involved.');
}

async function cmdGuard(positional, flags) {
  if (positional.length !== 1) throw new Error('guard needs exactly one task file: proofguard guard <task.json>');
  const taskPath = path.resolve(positional[0]);
  const outDir = path.resolve(flags.out || DEFAULT_OUT_DIR);
  const artifactsDir = path.resolve(flags.artifacts || DEFAULT_ARTIFACTS_DIR);
  const { wasmPath, zkeyPath, vkPath } = prove.assertArtifacts(artifactsDir);

  const rawTask = readJson(taskPath);
  const { input, checks, passed, decision, salt } = buildCircuitInput(rawTask);
  const verdict = decision === '1' ? 'APPROVE' : 'REJECT';

  console.log('ProofGuard — payment guard (Groth16, gatekeeper circuit)');
  console.log(`Task: ${taskPath} (taskId ${input.taskId})`);
  console.log('Checks:');
  for (const c of checks) {
    console.log(`  [${c.passed ? 'PASS' : 'FAIL'}] ${c.id}: ${c.detail}`);
  }

  // The circuit itself enforces decision == 1 <=> all checks pass. If our
  // policy and the circuit ever disagreed, proof generation throws here and
  // we fail closed instead of emitting an unprovable decision.
  let proof, publicSignals;
  try {
    ({ proof, publicSignals } = await prove.generateProof(input, wasmPath, zkeyPath));
  } catch (err) {
    throw new Error(
      `proof generation failed — the circuit rejected decision=${decision} for this task (${err.message}). ` +
      'Failing closed: no decision is emitted.'
    );
  }

  const vk = prove.loadVerificationKey(vkPath);
  const ok = await prove.verifyProof(vk, publicSignals, proof);
  if (!ok) throw new Error('local proof verification FAILED — failing closed, no decision is emitted.');

  fs.mkdirSync(outDir, { recursive: true });
  const proofPath = path.join(outDir, 'proof.json');
  const publicPath = path.join(outDir, 'public.json');
  const summaryPath = path.join(outDir, 'decision.json');
  fs.writeFileSync(proofPath, JSON.stringify(proof, null, 2) + '\n');
  fs.writeFileSync(publicPath, JSON.stringify(publicSignals, null, 2) + '\n');
  fs.writeFileSync(summaryPath, JSON.stringify({
    decision: verdict,
    decisionSignal: decision,
    taskId: input.taskId,
    salt,
    checks: checks.map((c) => ({ id: c.id, passed: c.passed, detail: c.detail })),
    policyPassed: passed,
    proofVerified: true,
    publicSignals,
    files: { proof: proofPath, publicSignals: publicPath },
  }, null, 2) + '\n');

  console.log(`Decision: ${verdict} (decision=${decision})`);
  if (decision === '0') {
    console.log('Note: the rejection itself is proven — the circuit accepts a correct');
    console.log('REJECT (decision=0) for a failing task, so this proof is valid too.');
  }
  console.log('Proof: generated + verified locally (snarkjs groth16 verify: OK)');
  console.log('Files:');
  console.log(`  proof:           ${proofPath}`);
  console.log(`  public signals:  ${publicPath}`);
  console.log(`  summary:         ${summaryPath}`);
  return decision === '1' ? 0 : 2;
}

async function cmdVerify(flags) {
  if (!flags.proof || !flags.public) {
    throw new Error('verify needs --proof <proof.json> and --public <public.json>');
  }
  const vkPath = path.resolve(flags.vk || path.join(DEFAULT_ARTIFACTS_DIR, prove.VK_FILE));
  const vk = prove.loadVerificationKey(vkPath);
  const proof = readJson(path.resolve(flags.proof));
  const publicSignals = readJson(path.resolve(flags.public));
  const ok = await prove.verifyProof(vk, publicSignals, proof);
  console.log(ok ? 'Proof verification: OK' : 'Proof verification: FAILED');
  return ok ? 0 : 1;
}

async function main() {
  const [, , command, ...rest] = process.argv;
  if (!command || command === '--help' || command === '-h' || command === 'help') {
    console.log(usage());
    return 0;
  }
  try {
    if (command === 'setup') {
      const { flags } = parseFlags(rest);
      await cmdSetup(flags);
      return 0;
    }
    if (command === 'guard') {
      const { flags, positional } = parseFlags(rest);
      return await cmdGuard(positional, flags);
    }
    if (command === 'verify') {
      const { flags } = parseFlags(rest);
      return await cmdVerify(flags);
    }
    throw new Error(`unknown command: ${command}\n\n${usage()}`);
  } catch (err) {
    console.error(`Error: ${err.message}`);
    return 1;
  }
}

main().then(async (code) => {
  process.exitCode = code;
  // snarkjs leaves worker threads + sockets open after proving (its internal
  // worker pool), so the process would otherwise never exit on its own.
  // All output above is written synchronously; drain stdout once, then exit.
  await new Promise((resolve) => process.stdout.write('', resolve));
  process.exit(code);
});
