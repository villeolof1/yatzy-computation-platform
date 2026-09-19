import path from 'node:path';
import { writeJsonAtomic } from '../util/fs.mjs';

function select(states, n) { if (states.length <= n) return Array.from(states); return Array.from({ length: n }, (_, i) => states[Math.floor(i * (states.length - 1) / (n - 1))]); }
export function runStructuralAtlas({ outDir, evaluator, stateIndex, hashes, statesPerLayer = 8 }) {
  const tieClasses = { exact_algebraic_tie: 0, certified_interval_tie: 0, numerically_unresolved_overlap: 0, tolerance_near_tie: 0, certified_order: 0, forced_action: 0 }; const strata = [], patternMap = new Map(); let positions = 0, totalWeight = 0;
  for (let layer = 0; layer < 15; layer += 1) {
    const picked = select(stateIndex.layers[layer], statesPerLayer), stateWeight = stateIndex.layers[layer].length / picked.length;
    for (const index of picked) {
      const mask = stateIndex.stateMask[index], upper = stateIndex.stateUpper[index];
      for (let stage = 0; stage <= 2; stage += 1) {
        let marginSum = 0, advantageSum = 0, advantageWeight = 0, weight = 0;
        for (let rollId = 0; rollId < 252; rollId += 1) {
          const e = evaluator.evaluate(mask, upper, rollId, stage), w = evaluator.universe.initialMultiplicity[rollId] * stateWeight, pattern = Array.from(evaluator.universe.rolls[rollId]).filter(Boolean).sort((a, b) => b - a).join('-'), keeperSize = e.best.keeperSize ?? -1;
          positions += 1; totalWeight += w; weight += w; marginSum += w * e.margin; tieClasses[e.tieClass] += 1;
          if (e.rerollAdvantage !== undefined) { advantageSum += w * e.rerollAdvantage; advantageWeight += w; }
          const pk = `${layer}|${stage}|${Math.max(0,63-upper)}|${pattern}|${keeperSize}`, pg = patternMap.get(pk) || { categoryCount: layer, rerollsRemaining: stage, bonusDistance: Math.max(0,63-upper), dicePattern: pattern, keeperSize, weight: 0, marginSum: 0, rerollAdvantageSum: 0, rerollAdvantageWeight: 0 }; pg.weight += w; pg.marginSum += w * e.margin; if (e.rerollAdvantage !== undefined) { pg.rerollAdvantageSum += w * e.rerollAdvantage; pg.rerollAdvantageWeight += w; } patternMap.set(pk, pg);
        }
        strata.push({ layer, stateIndex: index, mask, upper, rerollsRemaining: stage, selection: 'evenly_spaced_index_within_layer', stateWeight, unorderedRollWeight: 'ordered multiplicity out of 7776', weightedPopulation: weight, weightedMeanMargin: marginSum / weight, ...(advantageWeight ? { weightedMeanRerollAdvantage: advantageSum / advantageWeight } : {}) });
      }
    }
  }
  const patternStrata = [...patternMap.values()].map(g => ({ ...g, weightedMeanMargin: g.marginSum / g.weight, ...(g.rerollAdvantageWeight ? { weightedMeanRerollAdvantage: g.rerollAdvantageSum / g.rerollAdvantageWeight } : {}) }));
  const report = { population: 'structural_state_space_atlas', samplingDesign: 'deterministic evenly-spaced states by layer; all 252 unordered rolls; stages 0,1,2', statesPerLayer, positions, totalWeight, tieClasses, hashes, strata, patternStrata };
  writeJsonAtomic(path.join(outDir, 'structural_decision_atlas.json'), report); return report;
}
