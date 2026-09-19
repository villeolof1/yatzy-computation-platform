import { diceToCounts, scoreCategory } from './scoring.mjs';

function sortedKey(dice) { return [...dice].sort((a,b)=>a-b).join(''); }
function allOrderedRolls(n) {
  const out = [];
  const current = new Uint8Array(n);
  function rec(i) {
    if (i === n) { out.push(Array.from(current)); return; }
    for (let d = 1; d <= 6; d += 1) { current[i] = d; rec(i + 1); }
  }
  rec(0); return out;
}
const orderedBySize = Array.from({length: 6}, (_, n) => allOrderedRolls(n));

export class OrderedReferenceSolver {
  constructor() { this.turnMemo = new Map(); this.rollMemo = new Map(); }
  turnValue(mask, upper) {
    if (mask === 0x7fff) return 0;
    const key = `${mask}:${upper}`;
    if (this.turnMemo.has(key)) return this.turnMemo.get(key);
    let sum = 0;
    for (const roll of orderedBySize[5]) sum += this.rolledValue(mask, upper, roll, 2);
    const value = sum / 7776;
    this.turnMemo.set(key, value);
    return value;
  }
  rolledValue(mask, upper, dice, rerolls) {
    const sorted = [...dice].sort((a,b)=>a-b);
    const key = `${mask}:${upper}:${rerolls}:${sorted.join('')}`;
    if (this.rollMemo.has(key)) return this.rollMemo.get(key);
    const counts = diceToCounts(sorted);
    let best = -Infinity;
    for (let c = 0; c < 15; c += 1) {
      if (mask & (1 << c)) continue;
      const immediate = scoreCategory(counts, c);
      const nextUpper = Math.min(63, upper + (c < 6 ? immediate : 0));
      const bonus = c < 6 && upper < 63 && nextUpper === 63 ? 50 : 0;
      best = Math.max(best, immediate + bonus + this.turnValue(mask | (1 << c), nextUpper));
    }
    if (rerolls > 0) {
      const keepers = new Map();
      for (let bits = 0; bits < 32; bits += 1) {
        if (bits === 31) continue;
        const kept = [];
        for (let i = 0; i < 5; i += 1) if (bits & (1 << i)) kept.push(sorted[i]);
        keepers.set(kept.join(''), kept);
      }
      for (const kept of keepers.values()) {
        const outcomes = orderedBySize[5 - kept.length];
        let sum = 0;
        for (const outcome of outcomes) sum += this.rolledValue(mask, upper, kept.concat(outcome), rerolls - 1);
        best = Math.max(best, sum / outcomes.length);
      }
    }
    this.rollMemo.set(key, best);
    return best;
  }
}
