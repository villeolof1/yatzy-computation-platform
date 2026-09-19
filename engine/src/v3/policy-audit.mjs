import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { createStateIndex } from '../solver/state-index.mjs';
import { createDiceUniverse } from '../solver/dice.mjs';
import { POLICY_HEADER_SIZE, POLICY_STRIDE, verifyPolicyHeader } from '../solver/policy-format.mjs';

export function auditPolicy(file, rulesHash) {
  const states = createStateIndex(), dice = createDiceUniverse(), header = verifyPolicyHeader(file, states.totalStates, rulesHash); if (!header.passed) throw new Error('Invalid policy header: ' + JSON.stringify(header));
  const fd = fs.openSync(file, 'r'), buffer = Buffer.allocUnsafe(POLICY_STRIDE * 256), policyHeader = Buffer.alloc(POLICY_HEADER_SIZE); fs.readSync(fd, policyHeader, 0, policyHeader.length, 0); const hash = createHash('sha256'); hash.update(policyHeader); let illegal = null, scanned = 0;
  try {
    while (scanned < states.totalStates) {
      const n = Math.min(256, states.totalStates - scanned), bytes = n * POLICY_STRIDE; fs.readSync(fd, buffer, 0, bytes, POLICY_HEADER_SIZE + scanned * POLICY_STRIDE); hash.update(buffer.subarray(0, bytes));
      for (let q = 0; q < n && !illegal; q += 1) {
        const state = scanned + q, mask = states.stateMask[state]; if (mask === 0x7fff) continue;
        for (let stage = 0; stage < 3 && !illegal; stage += 1) for (let roll = 0; roll < 252; roll += 1) {
          const code = buffer[q * POLICY_STRIDE + stage * 252 + roll];
          if (code < 16) { if (code >= 15 || (mask & (1 << code))) { illegal = { state, mask, stage, roll, code, reason: 'illegal category' }; break; } }
          else if (stage === 0 || code - 16 >= dice.legalOffsets[roll + 1] - dice.legalOffsets[roll]) { illegal = { state, mask, stage, roll, code, reason: 'illegal keeper' }; break; }
        }
      }
      scanned += n;
    }
  } finally { fs.closeSync(fd); }
  if (illegal) throw new Error('Illegal policy action: ' + JSON.stringify(illegal));
  return { passed: true, header, scannedStates: scanned, scannedActionBytes: scanned * POLICY_STRIDE, sha256: hash.digest('hex') };
}
