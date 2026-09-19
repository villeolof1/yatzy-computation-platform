import { parentPort, workerData } from 'node:worker_threads';
import { createDiceUniverse } from './dice.mjs';
import { buildScoreMatrix } from './scoring.mjs';
import { createStateLookup, popcount15 } from './state-index.mjs';
import { nextDown, nextUp } from '../util/float.mjs';

const stateMask = new Uint16Array(workerData.stateMaskBuffer);
const stateUpper = new Uint8Array(workerData.stateUpperBuffer);
const allValues = new Float64Array(workerData.valuesBuffer);
const universe = createDiceUniverse();
const scoreMatrix = buildScoreMatrix(universe.rolls, workerData.scoringOptions || {});
const lookup = createStateLookup();
const ALL_MASK = 0x7fff;

// Reused fixed-size scratch arrays. Avoiding per-state allocations is the main
// performance requirement for the 1,430,528-state solve.
const score = new Float64Array(252);
const roll1 = new Float64Array(252);
const roll2 = new Float64Array(252);
const keep0 = new Float64Array(462);
const keep1 = new Float64Array(462);
const scoreCat = new Uint8Array(252);
const action1 = new Uint8Array(252);
const action2 = new Uint8Array(252);

function transform(input, output) {
  for (let r = 0; r < 252; r += 1) output[universe.rollKeeperIds[r]] = input[r];
  for (let size = 4; size >= 0; size -= 1) {
    for (let id = universe.sizeOffsets[size]; id < universe.sizeOffsets[size + 1]; id += 1) {
      const p = id * 6;
      output[id] = (output[universe.children[p]] + output[universe.children[p + 1]] + output[universe.children[p + 2]] + output[universe.children[p + 3]] + output[universe.children[p + 4]] + output[universe.children[p + 5]]) / 6;
    }
  }
}

function computeState(index, policyOut, policyOffset) {
  const mask = stateMask[index], u = stateUpper[index];
  if (mask === ALL_MASK) return [0, 0, 0];
  for (let r = 0; r < 252; r += 1) {
    let best = -Infinity, bestCat = 0;
    const base = r * 15;
    for (let c = 0; c < 15; c += 1) {
      if (mask & (1 << c)) continue;
      const immediate = scoreMatrix[base + c];
      const nextU = c < 6 ? Math.min(63, u + immediate) : u;
      const bonus = c < 6 && u < 63 && nextU === 63 ? 50 : 0;
      const next = lookup.indexOf(mask | (1 << c), nextU);
      const value = immediate + bonus + allValues[next];
      if (value > best) { best = value; bestCat = c; }
    }
    score[r] = best; scoreCat[r] = bestCat;
  }
  transform(score, keep0);
  for (let r = 0; r < 252; r += 1) {
    let best = score[r], code = scoreCat[r];
    const begin = universe.legalOffsets[r];
    for (let p = begin; p < universe.legalOffsets[r + 1]; p += 1) {
      const v = keep0[universe.legalKeepers[p]];
      if (v > best) { best = v; code = 16 + (p - begin); }
    }
    roll1[r] = best; action1[r] = code;
  }
  transform(roll1, keep1);
  for (let r = 0; r < 252; r += 1) {
    let best = score[r], code = scoreCat[r];
    const begin = universe.legalOffsets[r];
    for (let p = begin; p < universe.legalOffsets[r + 1]; p += 1) {
      const v = keep1[universe.legalKeepers[p]];
      if (v > best) { best = v; code = 16 + (p - begin); }
    }
    roll2[r] = best; action2[r] = code;
  }
  let sum = 0;
  for (let r = 0; r < 252; r += 1) sum += universe.initialMultiplicity[r] * roll2[r];
  if (policyOut) { policyOut.set(scoreCat, policyOffset); policyOut.set(action1, policyOffset + 252); policyOut.set(action2, policyOffset + 504); }
  const mid = sum / 7776;
  // A deliberately conservative error envelope. Max and expectation are
  // non-expansive; the allowance grows with the remaining finite horizon and
  // is orders of magnitude wider than observed cross-build rounding drift.
  const remaining = 15 - popcount15(mask);
  const eps = Math.max(1e-12, (remaining + 1) * 1e-6);
  return [mid, nextDown(mid - eps), nextUp(mid + eps)];
}

parentPort.on('message', message => {
  if (message.type !== 'compute') return;
  const indices = new Uint32Array(message.indicesBuffer);
  const values = new Float64Array(indices.length), lower = new Float64Array(indices.length), upper = new Float64Array(indices.length);
  const policy = workerData.writePolicy ? new Uint8Array(indices.length * 756) : null;
  const started = performance.now();
  for (let i = 0; i < indices.length; i += 1) {
    const [v, l, h] = computeState(indices[i], policy, i * 756); values[i] = v; lower[i] = l; upper[i] = h;
  }
  const transfer=[indices.buffer,values.buffer,lower.buffer,upper.buffer];if(policy)transfer.push(policy.buffer);parentPort.postMessage({type:'result',taskId:message.taskId,durationMs:performance.now()-started,indicesBuffer:indices.buffer,valuesBuffer:values.buffer,lowerBuffer:lower.buffer,upperBuffer:upper.buffer,policyBuffer:policy?.buffer??null,aggregate:null},transfer);
});
