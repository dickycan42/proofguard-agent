// SPDX-License-Identifier: MIT
// Local Groth16 proving with snarkjs + official circuit artifact handling.
// Nothing here touches a network except `setup`, which downloads the public
// circuit artifacts from the official Agent Games URL and checks their sha256.
'use strict';

const { createHash } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const snarkjs = require('snarkjs');

const CIRCUIT_BASE_URL = 'https://agentgames.zkverify.io/circuits';
const WASM_FILE = 'gatekeeper.wasm';
const ZKEY_FILE = 'gatekeeper_final.zkey';
const VK_FILE = 'verification_key.json';

// sha256 of the official artifacts, as published in the verified proof demo
// (~/workspace/agentgames/proof-demo/README.md). Any other bytes are rejected.
const EXPECTED_SHA256 = {
  [WASM_FILE]: 'be00aefe3c8ba910951a242f50e55937bf82a0375ad4b69c2ef10629ab92764f',
  [ZKEY_FILE]: 'adfe95a439a7063a82a4967ef026d2dd6857a4d02c63b3caf63dac02e01af80d',
};

function sha256File(filePath) {
  const hash = createHash('sha256');
  hash.update(fs.readFileSync(filePath));
  return hash.digest('hex');
}

async function downloadFile(url, destPath) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`download failed: ${url} -> HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(destPath, buf);
  return buf.length;
}

// Download the official gatekeeper artifacts into artifactsDir, verify their
// sha256 against the known official hashes, and export verification_key.json
// from the zkey. Returns { wasmPath, zkeyPath, vkPath }.
async function setupArtifacts(artifactsDir) {
  fs.mkdirSync(artifactsDir, { recursive: true });
  const out = {};
  for (const file of [WASM_FILE, ZKEY_FILE]) {
    const dest = path.join(artifactsDir, file);
    const size = await downloadFile(`${CIRCUIT_BASE_URL}/${file}`, dest);
    const hash = sha256File(dest);
    if (hash !== EXPECTED_SHA256[file]) {
      fs.unlinkSync(dest);
      throw new Error(
        `sha256 mismatch for ${file}: got ${hash}, expected ${EXPECTED_SHA256[file]} — refusing to use it`
      );
    }
    out[file] = { path: dest, size, sha256: hash };
  }
  const vkPath = path.join(artifactsDir, VK_FILE);
  const vk = await snarkjs.zKey.exportVerificationKey(out[ZKEY_FILE].path);
  fs.writeFileSync(vkPath, JSON.stringify(vk, null, 2) + '\n');
  return {
    wasmPath: out[WASM_FILE].path,
    zkeyPath: out[ZKEY_FILE].path,
    vkPath,
    wasmSha256: out[WASM_FILE].sha256,
    zkeySha256: out[ZKEY_FILE].sha256,
  };
}

function artifactPaths(artifactsDir) {
  return {
    wasmPath: path.join(artifactsDir, WASM_FILE),
    zkeyPath: path.join(artifactsDir, ZKEY_FILE),
    vkPath: path.join(artifactsDir, VK_FILE),
  };
}

function assertArtifacts(artifactsDir) {
  const p = artifactPaths(artifactsDir);
  for (const [name, file] of Object.entries(p)) {
    if (!fs.existsSync(file)) {
      throw new Error(`missing artifact: ${file} — run "npm run setup" first (${name})`);
    }
  }
  return p;
}

function loadVerificationKey(vkPath) {
  return JSON.parse(fs.readFileSync(vkPath, 'utf8'));
}

// Generate a Groth16 proof for a circuit input. Throws when the circuit
// rejects the input — which is exactly what happens for a wrong decision
// (e.g. decision=1 on a trap task): the witness cannot be built.
async function generateProof(input, wasmPath, zkeyPath) {
  const { proof, publicSignals } = await snarkjs.groth16.fullProve(input, wasmPath, zkeyPath);
  return { proof, publicSignals };
}

async function verifyProof(vk, publicSignals, proof) {
  return snarkjs.groth16.verify(vk, publicSignals, proof);
}

module.exports = {
  CIRCUIT_BASE_URL,
  WASM_FILE,
  ZKEY_FILE,
  VK_FILE,
  EXPECTED_SHA256,
  setupArtifacts,
  artifactPaths,
  assertArtifacts,
  loadVerificationKey,
  generateProof,
  verifyProof,
};
