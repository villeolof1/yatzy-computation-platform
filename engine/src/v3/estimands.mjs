import fs from 'node:fs';
import path from 'node:path';
import { writeJsonAtomic } from '../util/fs.mjs';

export function upperPointEstimands({ outDir, values, stateIndex, hashes }) {
  fs.mkdirSync(outDir, { recursive: true }); const rawPath = path.join(outDir, 'upper_point_raw.jsonl'), fd = fs.openSync(rawPath, 'w'); let buffer = ''; const byUpper = new Map(); let rawCount = 0;
  for (let i = 0; i < stateIndex.totalStates; i += 1) {
    const mask = stateIndex.stateMask[i], upper = stateIndex.stateUpper[i]; if (upper >= 63) continue;
    let next; try { next = stateIndex.indexOf(mask, upper + 1); } catch { continue; }
    if (next < 0) continue; const continuation = values[next] - values[i]; const grant = 1 + (upper === 62 ? 50 : 0) + continuation;
    buffer += JSON.stringify({ stateIndex: i, mask, upper, delta_continuation: continuation, delta_grant: grant }) + '\n'; rawCount += 1; if (buffer.length >= 1024 * 1024) { fs.writeSync(fd, buffer); buffer = ''; }
    const g = byUpper.get(upper) || { upper, n: 0, continuationSum: 0, grantSum: 0 }; g.n += 1; g.continuationSum += continuation; g.grantSum += grant; byUpper.set(upper, g);
  }
  if (buffer) fs.writeSync(fd, buffer); fs.fsyncSync(fd); fs.closeSync(fd);
  const aggregates = [...byUpper.values()].map(g => ({ upper: g.upper, n: g.n, mean_delta_continuation: g.continuationSum / g.n, mean_delta_grant: g.grantSum / g.n }));
  const report = { population: 'reachable_model_states', rawCount, definitions: { delta_continuation: 'F(M,u+1)-F(M,u)', delta_grant: '1+50 I(u=62)+F(M,min(63,u+1))-F(M,u)' }, hashes, aggregates };
  writeJsonAtomic(path.join(outDir, 'upper_point_aggregates.json'), report); return report;
}

export function optionCostsFromVisitSample({ outDir, sampleFile, evaluator, hashes }) {
  const rows = []; if (fs.existsSync(sampleFile)) for (const line of fs.readFileSync(sampleFile, 'utf8').trim().split(/\r?\n/)) {
    if (!line) continue; const v = JSON.parse(line); const evaluation = evaluator.evaluate(v.mask, v.upper, v.rollId, v.rerollsRemaining);
    for (const a of evaluation.actions.filter(x => x.type === 'score')) rows.push({ population: 'visit_weighted_deterministic_detail_sample', samplingDesign: v.samplingDesign, weight: v.weight, gameIndex: v.gameIndex, visitIndex: v.visitIndex, turn: v.turn, mask: v.mask, upper: v.upper, dice: v.dice, rollId: v.rollId, rerollsRemaining: v.rerollsRemaining, category: a.id, optionCost: evaluation.value - a.value, bestAction: { type: evaluation.best.type, id: evaluation.best.id }, alternativeAction: { type: 'score', id: a.id }, bestValue: evaluation.value, actionValue: a.value, regret: evaluation.value - a.value, tieClass: evaluation.tieClass, certified: evaluation.certified, condition: 'legal score action at sampled visit', ...hashes });
  }
  fs.writeFileSync(path.join(outDir, 'category_option_costs.jsonl'), rows.map(x => JSON.stringify(x)).join('\n') + '\n');
  const surprises = rows.sort((a, b) => b.optionCost - a.optionCost || a.gameIndex - b.gameIndex || a.visitIndex - b.visitIndex || a.category - b.category).slice(0, 100).map(x => ({ ...x, selectionReason: 'largest legal category option cost in deterministic visit detail sample' })); writeJsonAtomic(path.join(outDir, 'surprising_positions.json'), { population: 'visit_weighted_deterministic_detail_sample', selection: 'top 100 legal category option costs with deterministic tie-breaking', rows: surprises });
  return { rowCount: rows.length, surpriseCount: surprises.length };
}
