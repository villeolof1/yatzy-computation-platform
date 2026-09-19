import { scoreCategory } from './scoring.mjs';

export const POLICY_DEFINITIONS = [
  { id: 'optimal', label: 'Optimal full-game policy', description: 'Exact Bellman policy using the complete continuation table.' },
  { id: 'one_turn', label: 'One-turn expected-value policy', description: 'Optimizes the current turn while ignoring category continuation value.' },
  { id: 'greedy', label: 'Immediate-score greedy', description: 'Uses rerolls to pursue the largest repeated/high-value pattern, then takes the largest immediate score.' },
  { id: 'bonus_priority', label: 'Upper-bonus priority', description: 'Prioritizes available upper categories and the 63-point bonus pace.' },
  { id: 'fixed_priority', label: 'Fixed category priority', description: 'Pursues categories in a fixed conventional ranking.' },
  { id: 'random', label: 'Random legal policy', description: 'Selects legal rerolls and categories randomly.' }
];

function bestImmediate(mask, counts, scoreMatrixRow = null) {
  let best = { category: -1, score: -1 };
  for (let c = 0; c < 15; c += 1) {
    if (mask & (1 << c)) continue;
    const score = scoreMatrixRow ? scoreMatrixRow[c] : scoreCategory(counts, c);
    if (score > best.score || (score === best.score && c < best.category)) best = { category: c, score };
  }
  return best;
}

function keeperForMultiplicity(counts, preferHigh = true) {
  let bestFace = 0, bestCount = 0;
  for (let f = 0; f < 6; f += 1) {
    if (counts[f] > bestCount || (counts[f] === bestCount && preferHigh && f > bestFace)) { bestCount = counts[f]; bestFace = f; }
  }
  const keep = new Uint8Array(6);
  if (bestCount >= 2) keep[bestFace] = counts[bestFace];
  else for (let f = 3; f < 6; f += 1) keep[f] = counts[f];
  return keep;
}

export function heuristicDecision(policyId, context) {
  const { mask, counts, rerolls, rng, universe, categoryScores } = context;
  if (policyId === 'random') {
    if (rerolls > 0 && rng.float() < 0.72) {
      const legal = [];
      const rollId = context.rollId;
      for (let p = universe.legalOffsets[rollId]; p < universe.legalOffsets[rollId + 1]; p += 1) legal.push(universe.legalKeepers[p]);
      return { type: 'reroll', keeperId: legal[rng.int(legal.length)], margin: NaN };
    }
    const cats = [];
    for (let c = 0; c < 15; c += 1) if (!(mask & (1 << c))) cats.push(c);
    const category = cats[rng.int(cats.length)];
    return { type: 'score', category, immediate: categoryScores[category], margin: NaN };
  }

  if (rerolls > 0) {
    if (policyId === 'bonus_priority') {
      let target = -1;
      for (let f = 5; f >= 0; f -= 1) if (!(mask & (1 << f)) && counts[f] > 0) { target = f; break; }
      if (target >= 0) {
        const keep = new Uint8Array(6); keep[target] = counts[target];
        return { type: 'reroll_counts', keep, margin: NaN };
      }
    }
    if (policyId === 'fixed_priority') {
      // Keep promising made structures; otherwise keep high dice.
      const keep = keeperForMultiplicity(counts, true);
      return { type: 'reroll_counts', keep, margin: NaN };
    }
    if (policyId === 'greedy') return { type: 'reroll_counts', keep: keeperForMultiplicity(counts, true), margin: NaN };
  }

  if (policyId === 'bonus_priority') {
    let best = { category: -1, score: -1, utility: -Infinity };
    for (let c = 0; c < 15; c += 1) {
      if (mask & (1 << c)) continue;
      const score = categoryScores[c];
      const utility = score + (c < 6 ? 8 + score * 0.35 : 0);
      if (utility > best.utility) best = { category: c, score, utility };
    }
    return { type: 'score', category: best.category, immediate: best.score, margin: NaN };
  }
  if (policyId === 'fixed_priority') {
    const priority = [14, 9, 11, 10, 12, 7, 8, 6, 5, 4, 3, 2, 1, 0, 13];
    for (const c of priority) if (!(mask & (1 << c)) && categoryScores[c] > 0) return { type: 'score', category: c, immediate: categoryScores[c], margin: NaN };
  }
  const best = bestImmediate(mask, counts, categoryScores);
  return { type: 'score', category: best.category, immediate: best.score, margin: NaN };
}
