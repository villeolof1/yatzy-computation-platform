import fs from 'node:fs';
import path from 'node:path';
import { RunningStats, normal95 } from '../util/statistics.mjs';
import { writeJsonAtomic } from '../util/fs.mjs';
import { simulateCounterGame } from './game-simulator.mjs';

function median(xs) { const a = [...xs].sort((x, y) => x - y), n = a.length; return n % 2 ? a[(n - 1) / 2] : (a[n / 2 - 1] + a[n / 2]) / 2; }
export function runPairedComparisons({ outDir, seed, gameCount, evaluator, oneTurnEvaluator, comparators = ['one_turn', 'greedy', 'bonus_priority', 'fixed_priority', 'random'], scoringOptions = {} }) {
  fs.mkdirSync(outDir, { recursive: true }); const rows = [];
  for (const comparator of comparators) {
    const stats = new RunningStats(), differences = []; let wins = 0, ties = 0, losses = 0, bonusDifference = 0, yatzyDifference = 0;
    for (let i = 0; i < gameCount; i += 1) {
      const a = simulateCounterGame({ seed, gameIndex: i, policyId: 'optimal', evaluator, oneTurnEvaluator, scoringOptions });
      const b = simulateCounterGame({ seed, gameIndex: i, policyId: comparator, evaluator, oneTurnEvaluator, scoringOptions });
      const d = a.finalScore - b.finalScore; stats.push(d); differences.push(d); if (d > 0) wins += 1; else if (d === 0) ties += 1; else losses += 1;
      bonusDifference += Number(a.bonus) - Number(b.bonus); yatzyDifference += Number(a.yatzy) - Number(b.yatzy);
    }
    rows.push({ comparator, n: stats.n, meanDifference: stats.mean, sdDifference: stats.sd, seDifference: stats.se, interval95: normal95(stats.mean, stats.se), medianDifference: median(differences), optimalWinRate: wins / gameCount, tieRate: ties / gameCount, optimalLossRate: losses / gameCount, pairedBonusDifference: bonusDifference / gameCount, pairedYatzyDifference: yatzyDifference / gameCount, pairing: 'counter-based shared physical-die-slot potentials' });
  }
  const result = { population: 'paired_policy_games', seed: String(seed), gameCount, rows }; writeJsonAtomic(path.join(outDir, 'paired_policy_comparisons.json'), result); return result;
}
