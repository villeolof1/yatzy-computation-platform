import { createDiceUniverse, keeperTransform } from './dice.mjs';
import { buildScoreMatrix } from './scoring.mjs';

function encodeCounts(counts) {
  let x = 0, p = 1;
  for (let i = 0; i < 6; i += 1) { x += counts[i] * p; p *= 6; }
  return x;
}

export class PolicyEngine {
  constructor({ values, lower = values, upper = values, stateIndex, cacheSize = 12000, continuation = 'full' }) {
    this.values = values; this.lower = lower; this.upper = upper; this.stateIndex = stateIndex;
    this.cacheSize = cacheSize; this.continuation = continuation;
    this.universe = createDiceUniverse();
    this.scores = buildScoreMatrix(this.universe.rolls);
    this.cache = new Map();
    this.rollIdByCode = new Int16Array(6 ** 6); this.rollIdByCode.fill(-1);
    for (let r = 0; r < this.universe.rolls.length; r += 1) this.rollIdByCode[encodeCounts(this.universe.rolls[r])] = r;
  }

  stateKey(mask, upper) { return mask * 64 + upper; }
  getPolicy(mask, upper) {
    const key = this.stateKey(mask, upper);
    const cached = this.cache.get(key);
    if (cached) { this.cache.delete(key); this.cache.set(key, cached); return cached; }
    const built = this.buildPolicy(mask, upper);
    this.cache.set(key, built);
    if (this.cache.size > this.cacheSize) this.cache.delete(this.cache.keys().next().value);
    return built;
  }

  buildPolicy(mask, u) {
    const scoreMid = new Float64Array(252);
    const scoreBestCat = new Uint8Array(252);
    const scoreSecond = new Float64Array(252);
    const scoreActions = Array.from({ length: 252 }, () => []);
    for (let r = 0; r < 252; r += 1) {
      let best = -Infinity, second = -Infinity, bestCat = 0;
      for (let c = 0; c < 15; c += 1) {
        if (mask & (1 << c)) continue;
        const immediate = this.scores[r * 15 + c];
        const nextU = Math.min(63, u + (c < 6 ? immediate : 0));
        const bonus = c < 6 && u < 63 && nextU === 63 ? 50 : 0;
        const nextIndex = this.stateIndex.indexOf(mask | (1 << c), nextU);
        const continuation = this.continuation === 'full' ? this.values[nextIndex] : 0;
        const value = immediate + bonus + continuation;
        scoreActions[r].push({ type: 'score', id: c, value, immediate, bonus, nextU, nextIndex });
        if (value > best) { second = best; best = value; bestCat = c; }
        else if (value > second) second = value;
      }
      scoreActions[r].sort((a, b) => b.value - a.value || a.id - b.id);
      scoreMid[r] = best; scoreSecond[r] = second; scoreBestCat[r] = bestCat;
    }

    const h0 = keeperTransform(scoreMid, this.universe);
    const roll1 = new Float64Array(252);
    const action1 = new Uint16Array(252);
    const margin1 = new Float32Array(252);
    for (let r = 0; r < 252; r += 1) {
      let best = { code: scoreBestCat[r], value: scoreMid[r] };
      let second = scoreSecond[r];
      for (let p = this.universe.legalOffsets[r]; p < this.universe.legalOffsets[r + 1]; p += 1) {
        const k = this.universe.legalKeepers[p], v = h0[k];
        if (v > best.value) { second = best.value; best = { code: 0x8000 | k, value: v }; }
        else if (v > second) second = v;
      }
      roll1[r] = best.value; action1[r] = best.code; margin1[r] = Math.max(0, best.value - second);
    }

    const h1 = keeperTransform(roll1, this.universe);
    const action2 = new Uint16Array(252);
    const margin2 = new Float32Array(252);
    for (let r = 0; r < 252; r += 1) {
      let best = { code: scoreBestCat[r], value: scoreMid[r] };
      let second = scoreSecond[r];
      for (let p = this.universe.legalOffsets[r]; p < this.universe.legalOffsets[r + 1]; p += 1) {
        const k = this.universe.legalKeepers[p], v = h1[k];
        if (v > best.value) { second = best.value; best = { code: 0x8000 | k, value: v }; }
        else if (v > second) second = v;
      }
      action2[r] = best.code; margin2[r] = Math.max(0, best.value - second);
    }

    const action0 = Uint16Array.from(scoreBestCat);
    const margin0 = new Float32Array(252);
    for (let r = 0; r < 252; r += 1) margin0[r] = Number.isFinite(scoreSecond[r]) ? Math.max(0, scoreMid[r] - scoreSecond[r]) : Infinity;
    return { actions: [action0, action1, action2], margins: [margin0, margin1, margin2], scoreActions };
  }

  decide(mask, upper, rollId, rerolls) {
    const policy = this.getPolicy(mask, upper);
    const code = policy.actions[rerolls][rollId];
    const margin = policy.margins[rerolls][rollId];
    if (code & 0x8000) return { type: 'reroll', keeperId: code & 0x7fff, margin };
    const action = policy.scoreActions[rollId].find(a => a.id === code);
    return { ...action, category: code, margin };
  }

  allActions(mask, upper, rollId, rerolls) {
    const policy = this.getPolicy(mask, upper);
    const actions = [...policy.scoreActions[rollId]];
    if (rerolls > 0) {
      const base = rerolls === 1 ? (() => {
        const score = new Float64Array(252);
        for (let r = 0; r < 252; r += 1) score[r] = policy.scoreActions[r][0].value;
        return keeperTransform(score, this.universe);
      })() : null;
      // Full alternative reconstruction is intentionally performed only for interactive queries.
      const nextRoll = rerolls === 2 ? (() => {
        const score = new Float64Array(252);
        for (let r = 0; r < 252; r += 1) score[r] = policy.scoreActions[r][0].value;
        const h0 = keeperTransform(score, this.universe);
        const roll1 = new Float64Array(252);
        for (let r = 0; r < 252; r += 1) {
          let best = score[r];
          for (let p = this.universe.legalOffsets[r]; p < this.universe.legalOffsets[r + 1]; p += 1) best = Math.max(best, h0[this.universe.legalKeepers[p]]);
          roll1[r] = best;
        }
        return keeperTransform(roll1, this.universe);
      })() : base;
      for (let p = this.universe.legalOffsets[rollId]; p < this.universe.legalOffsets[rollId + 1]; p += 1) {
        const keeperId = this.universe.legalKeepers[p];
        actions.push({ type: 'reroll', keeperId, value: nextRoll[keeperId] });
      }
    }
    return actions.sort((a, b) => b.value - a.value || (a.type === 'score' ? -1 : 1));
  }

  rollId(counts) { return this.rollIdByCode[encodeCounts(counts)]; }
}
