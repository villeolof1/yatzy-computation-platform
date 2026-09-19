import fs from 'node:fs';
import path from 'node:path';
import { writeJsonAtomic } from '../util/fs.mjs';
import { sha256File } from '../util/hash.mjs';
import { simulateCounterGame } from './game-simulator.mjs';

function actionView(a) { return { type: a.type, id: a.id, value: a.value, lower: a.lower, upper: a.upper, keeperSize: a.keeperSize }; }
function dicePattern(dice) { const counts = Array(6).fill(0); for (const d of dice) counts[d - 1] += 1; return counts.filter(Boolean).sort((a, b) => b - a).join('-'); }
function groupKey(v) { const categoryCount = v.mask.toString(2).replaceAll('0', '').length; return `${v.turn}|${v.rerollsRemaining}|${categoryCount}|${Math.max(0, 63 - v.upper)}|${dicePattern(v.dice)}|${v.best.keeperSize ?? -1}`; }
export async function runVisitAnalysis({ outDir, seed, gameCount, evaluator, hashes, sampleEvery = 17 }) {
  fs.mkdirSync(outDir, { recursive: true }); const detail = path.join(outDir, 'visit_decisions.jsonl'); const stream = fs.createWriteStream(detail, { encoding: 'utf8' });
  const groups = new Map(), tieClasses = { exact_algebraic_tie: 0, certified_interval_tie: 0, numerically_unresolved_overlap: 0, tolerance_near_tie: 0, certified_order: 0, forced_action: 0 };
  let visits = 0, rerollVisits = 0, sampleCount = 0;
  for (let gameIndex = 0; gameIndex < gameCount; gameIndex += 1) {
    const game = simulateCounterGame({ seed, gameIndex, policyId: 'optimal', evaluator, capture: true });
    for (let j = 0; j < game.visits.length; j += 1) {
      const v = game.visits[j]; visits += 1; tieClasses[v.tieClass] += 1; if (v.bestRerollValue !== undefined) rerollVisits += 1;
      const key = groupKey(v), g = groups.get(key) || { turn: v.turn, rerollsRemaining: v.rerollsRemaining, categoryCount: v.mask.toString(2).replaceAll('0', '').length, bonusDistance: Math.max(0, 63 - v.upper), dicePattern: dicePattern(v.dice), keeperSize: v.best.keeperSize ?? -1, n: 0, marginSum: 0, rerollAdvantageSum: 0, rerollAdvantageN: 0 };
      g.n += 1; g.marginSum += v.margin; if (v.rerollAdvantage !== undefined) { g.rerollAdvantageSum += v.rerollAdvantage; g.rerollAdvantageN += 1; } groups.set(key, g);
      if ((gameIndex * 47 + j) % sampleEvery === 0) {
        const row = { population: 'visit_weighted_optimal', samplingDesign: `all visits; deterministic detail sample modulo ${sampleEvery}`, weight: 1, gameIndex, visitIndex: j, turn: v.turn, mask: v.mask, upper: v.upper, dice: v.dice, dicePattern: dicePattern(v.dice), rollId: v.rollId, rerollsRemaining: v.rerollsRemaining, bestAction: actionView(v.best), alternativeAction: actionView(v.second), bestValue: v.value, alternativeValue: v.second.value, margin: v.margin, regret: v.margin, bestScoreValue: v.bestScoreValue, ...(v.bestRerollValue === undefined ? {} : { bestRerollValue: v.bestRerollValue, rerollAdvantage: v.rerollAdvantage }), tieClass: v.tieClass, certified: v.certified, ...hashes };
        stream.write(JSON.stringify(row) + '\n'); sampleCount += 1;
      }
    }
  }
  await new Promise((resolve, reject) => stream.end(resolve).on('error', reject));
  const aggregateGroups = [...groups.values()].map(g => ({ ...g, meanMargin: g.marginSum / g.n, ...(g.rerollAdvantageN ? { meanRerollAdvantage: g.rerollAdvantageSum / g.rerollAdvantageN } : {}) }));
  const report = { population: 'visit_weighted_optimal', seed: String(seed), gameCount, visits, rerollVisits, sampleCount, detailSha256: await sha256File(detail), tieClasses, groups: aggregateGroups, hashes };
  writeJsonAtomic(path.join(outDir, 'visit_aggregates.json'), report); return report;
}
