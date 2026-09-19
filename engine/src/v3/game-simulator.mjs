import { createDiceUniverse } from '../solver/dice.mjs';
import { buildScoreMatrix } from '../solver/scoring.mjs';
import { heuristicDecision } from '../solver/policies.mjs';
import { CounterStream, potentialDie } from './counter-rng.mjs';

const universe = createDiceUniverse();
const rollByCode = new Int16Array(6 ** 6); rollByCode.fill(-1);
for (let r = 0; r < 252; r += 1) { let code = 0, p = 1; for (let f = 0; f < 6; f += 1) { code += universe.rolls[r][f] * p; p *= 6; } rollByCode[code] = r; }
function rollId(counts) { let code = 0, p = 1; for (let f = 0; f < 6; f += 1) { code += counts[f] * p; p *= 6; } return rollByCode[code]; }
function counts(slots) { const out = new Uint8Array(6); for (const x of slots) out[x - 1] += 1; return out; }
function keeperSlots(slots, keep) { const need = Uint8Array.from(keep); const kept = []; for (let i = 0; i < 5; i += 1) { const f = slots[i] - 1; if (need[f]) { kept.push(i); need[f] -= 1; } } return kept; }

export function simulateCounterGame({ seed, gameIndex, policyId, evaluator, oneTurnEvaluator, scoringOptions = {}, capture = false }) {
  const scores = buildScoreMatrix(universe.rolls, scoringOptions); const policyStream = ['one_turn', 'greedy', 'bonus_priority', 'fixed_priority', 'random'].indexOf(policyId) + 2; const random = new CounterStream(seed, gameIndex, 0, policyStream);
  let mask = 0, upper = 0, upperRaw = 0, total = 0, bonus = false, yatzy = false; const visits = [];
  for (let turn = 0; turn < 15; turn += 1) {
    const slots = new Uint8Array(5); for (let slot = 0; slot < 5; slot += 1) slots[slot] = potentialDie(seed, gameIndex, turn, 0, slot);
    let rerolls = 2, opportunity = 0;
    while (true) {
      const diceCounts = counts(slots), rid = rollId(diceCounts); if (diceCounts.some(x => x === 5)) yatzy = true;
      let decision, evaluation;
      if (policyId === 'optimal') { evaluation = evaluator.evaluate(mask, upper, rid, rerolls); decision = evaluation.best; }
      else if (policyId === 'one_turn') { if (!oneTurnEvaluator) throw new Error('one_turn requires a zero-continuation evaluator'); decision = oneTurnEvaluator.evaluate(mask, upper, rid, rerolls).best; }
      else {
        const row = scores.subarray(rid * 15, rid * 15 + 15);
        decision = heuristicDecision(policyId, { mask, upper, counts: diceCounts, rerolls, rng: random, universe, rollId: rid, categoryScores: row });
        if (decision.type === 'reroll_counts') decision = { type: 'reroll', keeperId: universe.keeperIdByKey.get(Array.from(decision.keep).join('')) };
      }
      if (capture && evaluation) visits.push({ turn: turn + 1, mask, upper, dice: Array.from(slots), rollId: rid, rerollsRemaining: rerolls, ...evaluation });
      if (decision.type === 'reroll' && rerolls > 0) {
        const keep = universe.keepers[decision.keeperId], kept = new Set(keeperSlots(slots, keep)); opportunity += 1;
        for (let slot = 0; slot < 5; slot += 1) if (!kept.has(slot)) slots[slot] = potentialDie(seed, gameIndex, turn, opportunity, slot);
        rerolls -= 1; continue;
      }
      const c = decision.id ?? decision.category; const immediate = scores[rid * 15 + c]; total += immediate;
      if (c < 6) { upperRaw += immediate; const next = Math.min(63, upper + immediate); if (!bonus && upper < 63 && next === 63) { bonus = true; total += 50; } upper = next; }
      mask |= 1 << c; break;
    }
  }
  return { finalScore: total, bonus, yatzy, upperRaw, visits };
}
