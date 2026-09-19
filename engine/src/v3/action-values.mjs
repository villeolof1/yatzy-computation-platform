import { createDiceUniverse, keeperTransform } from '../solver/dice.mjs';
import { buildScoreMatrix } from '../solver/scoring.mjs';

const TOLERANCE = 1e-8;

function actionOrder(a, b) {
  return b.value - a.value || (a.type === b.type ? a.id - b.id : a.type === 'score' ? -1 : 1);
}

function buildPointModel(table, stateIndex, universe, scores, mask, upper) {
  const scoreActions = Array.from({ length: 252 }, () => []);
  const scoreBest = new Float64Array(252);
  for (let r = 0; r < 252; r += 1) {
    for (let c = 0; c < 15; c += 1) {
      if (mask & (1 << c)) continue;
      const immediate = scores[r * 15 + c];
      const nextUpper = c < 6 ? Math.min(63, upper + immediate) : upper;
      const grant = c < 6 && upper < 63 && nextUpper === 63 ? 50 : 0;
      const continuation = table[stateIndex.indexOf(mask | (1 << c), nextUpper)];
      scoreActions[r].push({ type: 'score', id: c, value: immediate + grant + continuation, immediate, grant, expression: `score:${c}:${immediate}:${grant}` });
    }
    scoreActions[r].sort(actionOrder);
    scoreBest[r] = scoreActions[r][0].value;
  }
  const rerollOne = keeperTransform(scoreBest, universe);
  const afterOne = new Float64Array(252);
  for (let r = 0; r < 252; r += 1) {
    let best = scoreBest[r];
    for (let p = universe.legalOffsets[r]; p < universe.legalOffsets[r + 1]; p += 1) best = Math.max(best, rerollOne[universe.legalKeepers[p]]);
    afterOne[r] = best;
  }
  return { scoreActions, rerollOne, rerollTwo: keeperTransform(afterOne, universe) };
}

export class ActionValueEvaluator {
  constructor({ values, lower, upper, stateIndex, scoringOptions = {}, cacheSize = 2048 }) {
    this.tables = { values, lower, upper }; this.stateIndex = stateIndex; this.cacheSize = cacheSize;
    this.universe = createDiceUniverse(); this.scores = buildScoreMatrix(this.universe.rolls, scoringOptions); this.cache = new Map();
  }
  state(mask, upper) {
    const key = mask * 64 + upper;
    if (this.cache.has(key)) { const hit = this.cache.get(key); this.cache.delete(key); this.cache.set(key, hit); return hit; }
    const out = {
      mid: buildPointModel(this.tables.values, this.stateIndex, this.universe, this.scores, mask, upper),
      low: buildPointModel(this.tables.lower, this.stateIndex, this.universe, this.scores, mask, upper),
      high: buildPointModel(this.tables.upper, this.stateIndex, this.universe, this.scores, mask, upper)
    };
    this.cache.set(key, out); if (this.cache.size > this.cacheSize) this.cache.delete(this.cache.keys().next().value); return out;
  }
  actions(mask, upper, rollId, rerolls) {
    const s = this.state(mask, upper); const actions = [];
    for (let i = 0; i < s.mid.scoreActions[rollId].length; i += 1) {
      const m = s.mid.scoreActions[rollId][i], lo = s.low.scoreActions[rollId].find(x => x.id === m.id), hi = s.high.scoreActions[rollId].find(x => x.id === m.id);
      actions.push({ ...m, lower: lo.value, upper: hi.value });
    }
    if (rerolls > 0) {
      const field = rerolls === 1 ? 'rerollOne' : 'rerollTwo';
      for (let p = this.universe.legalOffsets[rollId]; p < this.universe.legalOffsets[rollId + 1]; p += 1) {
        const id = this.universe.legalKeepers[p];
        actions.push({ type: 'reroll', id, keeperId: id, keeperSize: this.universe.keeperSizes[id], value: s.mid[field][id], lower: s.low[field][id], upper: s.high[field][id], expression: `reroll:${rerolls}:${id}` });
      }
    }
    actions.sort(actionOrder); return actions;
  }
  evaluate(mask, upper, rollId, rerolls) {
    const actions = this.actions(mask, upper, rollId, rerolls); const best = actions[0], second = actions[1] ?? { ...best, expression: 'forced:no-second-legal-action' };
    const margin = best.value - second.value;
    let tieClass = actions.length === 1 ? 'forced_action' : 'certified_order';
    if (actions.length > 1 && best.expression === second.expression) tieClass = 'exact_algebraic_tie';
    else if (actions.length > 1 && best.value === second.value && best.lower === second.lower && best.upper === second.upper) tieClass = 'certified_interval_tie';
    else if (actions.length > 1 && best.lower <= second.upper && second.lower <= best.upper) tieClass = 'numerically_unresolved_overlap';
    else if (actions.length > 1 && margin <= TOLERANCE) tieClass = 'tolerance_near_tie';
    const score = actions.filter(x => x.type === 'score')[0]; const reroll = actions.filter(x => x.type === 'reroll')[0];
    return { actions, best, second, value: best.value, margin, tieClass, certified: tieClass === 'certified_order' || tieClass === 'forced_action' || tieClass === 'exact_algebraic_tie' || tieClass === 'certified_interval_tie', bestScoreValue: score.value, bestRerollValue: reroll?.value, rerollAdvantage: reroll ? reroll.value - score.value : undefined };
  }
}
