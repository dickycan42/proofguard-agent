// SPDX-License-Identifier: MIT
// ProofGuard policy engine — deterministic, no network, no randomness.
// Mirrors the checks the official Agent Games gatekeeper circuit enforces, so
// that the computed decision is always the decision the circuit can prove:
//   decision == 1  <=>  every check passes.
// A wrong decision cannot be proven: asking the circuit for decision=1 on a
// failing task (or decision=0 on a passing task) makes proof generation fail.
'use strict';

const { createHash } = require('node:crypto');

// Official gatekeeper verification-key hash, registered on zkVerify mainnet
// (also served at https://agentgames.zkverify.io/api/circuit-info).
const OFFICIAL_VK_HASH = '0x6b79c6012a6d8651f3e13bc4d2a20370280ab49700c90c5316d4168bfbad77b0';

// bn128 scalar-field prime. A salt must be a valid field element (< p).
const FIELD_PRIME = BigInt(
  '21888242871839275222246405745257275088548364400416034343698204186575808495617'
);

function fail(message) {
  throw new Error(message);
}

// Accept a decimal string ("1460"), a 0x hex string, or a safe JS number.
// Returns the value as a decimal string. Rejects negatives and non-integers.
function parseUint(value, name) {
  let n;
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || value < 0) fail(`${name}: expected a non-negative integer, got ${value}`);
    n = BigInt(value);
  } else if (typeof value === 'string') {
    const s = value.trim();
    try {
      n = s.startsWith('0x') || s.startsWith('0X') ? BigInt(s) : BigInt(s);
    } catch {
      fail(`${name}: expected a non-negative integer, got ${JSON.stringify(value)}`);
    }
    if (n < 0n) fail(`${name}: expected a non-negative integer, got ${JSON.stringify(value)}`);
    if (!/^(0x[0-9a-fA-F]+|[0-9]+)$/.test(s)) fail(`${name}: expected a non-negative integer, got ${JSON.stringify(value)}`);
  } else {
    fail(`${name}: expected a non-negative integer, got ${JSON.stringify(value)}`);
  }
  return n.toString(10);
}

function parseAddress(value, name) {
  if (typeof value !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(value.trim())) {
    fail(`${name}: expected an Ethereum address (0x + 40 hex chars), got ${JSON.stringify(value)}`);
  }
  return value.trim().toLowerCase();
}

function parseVkHash(value, name) {
  if (typeof value !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(value.trim())) {
    fail(`${name}: expected a 0x + 64 hex chars verification-key hash, got ${JSON.stringify(value)}`);
  }
  return value.trim().toLowerCase();
}

// Validate a raw task object and return normalized string fields.
// registeredVkHash / proofVkHash default to the official gatekeeper hash.
// salt is optional: when omitted it is derived deterministically (see deriveSalt).
function normalizeTask(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    fail('task: expected a JSON object');
  }
  const t = {
    taskId: parseUint(raw.taskId, 'taskId'),
    minimum: parseUint(raw.minimum, 'minimum'),
    publicBalance: parseUint(raw.publicBalance, 'publicBalance'),
    amount: parseUint(raw.amount, 'amount'),
    maxTransfer: parseUint(raw.maxTransfer, 'maxTransfer'),
    expiryBlock: parseUint(raw.expiryBlock, 'expiryBlock'),
    currentBlock: parseUint(raw.currentBlock, 'currentBlock'),
    recipient: parseAddress(raw.recipient, 'recipient'),
    conditionRecipient: parseAddress(raw.conditionRecipient, 'conditionRecipient'),
    registeredVkHash: raw.registeredVkHash === undefined
      ? OFFICIAL_VK_HASH
      : parseVkHash(raw.registeredVkHash, 'registeredVkHash'),
    proofVkHash: raw.proofVkHash === undefined
      ? OFFICIAL_VK_HASH
      : parseVkHash(raw.proofVkHash, 'proofVkHash'),
  };
  if (raw.salt !== undefined) {
    const salt = parseUint(raw.salt, 'salt');
    if (BigInt(salt) >= FIELD_PRIME) fail('salt: must be smaller than the bn128 field prime');
    t.salt = salt;
  }
  return t;
}

// The five policy checks. Each check returns { id, label, passed, detail }.
function evaluatePolicy(t) {
  const checks = [
    {
      id: 'balance',
      label: 'balance sufficient',
      passed: BigInt(t.publicBalance) >= BigInt(t.minimum),
      detail: `publicBalance ${t.publicBalance} >= minimum ${t.minimum}`,
    },
    {
      id: 'amount',
      label: 'amount within limit',
      passed: BigInt(t.amount) <= BigInt(t.maxTransfer),
      detail: `amount ${t.amount} <= maxTransfer ${t.maxTransfer}`,
    },
    {
      id: 'recipient',
      label: 'recipient matches condition',
      passed: t.recipient === t.conditionRecipient,
      detail: t.recipient === t.conditionRecipient
        ? 'recipient == conditionRecipient'
        : `recipient ${t.recipient} != conditionRecipient ${t.conditionRecipient}`,
    },
    {
      id: 'expiry',
      label: 'not expired',
      passed: BigInt(t.currentBlock) < BigInt(t.expiryBlock),
      detail: `currentBlock ${t.currentBlock} < expiryBlock ${t.expiryBlock}`,
    },
    {
      id: 'vk',
      label: 'verification key matches the registered gatekeeper key',
      passed: t.registeredVkHash === OFFICIAL_VK_HASH && t.proofVkHash === OFFICIAL_VK_HASH,
      detail: t.registeredVkHash === t.proofVkHash
        ? (t.registeredVkHash === OFFICIAL_VK_HASH
          ? 'registeredVkHash == proofVkHash == official gatekeeper vk hash'
          : 'registeredVkHash == proofVkHash but NOT the official gatekeeper vk hash')
        : 'registeredVkHash != proofVkHash',
    },
  ];
  return { checks, passed: checks.every((c) => c.passed) };
}

// Deterministic salt: sha256 over the canonical (key-sorted) normalized task,
// reduced modulo the field prime. Same task -> same salt -> same public signals.
function deriveSalt(t) {
  const { salt, ...rest } = t; // eslint-disable-line no-unused-vars
  const canonical = JSON.stringify(rest, Object.keys(rest).sort());
  const hash = createHash('sha256').update(canonical).digest('hex');
  return (BigInt('0x' + hash) % FIELD_PRIME).toString(10);
}

// Build the 13-signal circuit input for a task.
// options.forceDecision ('0' | '1') overrides the computed decision — used by
// tests to demonstrate that a wrong decision cannot be proven.
function buildCircuitInput(raw, options = {}) {
  const t = normalizeTask(raw);
  const { checks, passed } = evaluatePolicy(t);
  const decision = options.forceDecision !== undefined ? options.forceDecision : (passed ? '1' : '0');
  if (decision !== '0' && decision !== '1') fail('forceDecision: must be "0" or "1"');
  const salt = t.salt !== undefined ? t.salt : deriveSalt(t);
  const input = {
    registeredVkHash: t.registeredVkHash,
    proofVkHash: t.proofVkHash,
    minimum: t.minimum,
    publicBalance: t.publicBalance,
    expiryBlock: t.expiryBlock,
    currentBlock: t.currentBlock,
    recipient: t.recipient,
    conditionRecipient: t.conditionRecipient,
    amount: t.amount,
    maxTransfer: t.maxTransfer,
    decision,
    taskId: t.taskId,
    salt,
  };
  return { input, checks, passed, decision, salt, task: t };
}

module.exports = {
  OFFICIAL_VK_HASH,
  FIELD_PRIME,
  normalizeTask,
  evaluatePolicy,
  deriveSalt,
  buildCircuitInput,
};
