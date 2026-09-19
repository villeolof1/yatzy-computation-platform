import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { counterUint, counterInt, potentialDie } from '../src/v3/counter-rng.mjs';
import { runV3Pipeline } from '../src/v3/official-pipeline.mjs';
import { assertLexicalContainment, assertRelativePath, claimOutputRoot, resolveWithin } from '../src/v3/paths.mjs';
import { assertScientificValue, validateExperimentManifest, validateFigureMetadata } from '../src/v3/quality-gates.mjs';
import { scoreCategory, diceToCounts } from '../src/solver/scoring.mjs';
import { ActionValueEvaluator } from '../src/v3/action-values.mjs';
import { createStateIndex } from '../src/solver/state-index.mjs';
import { writeSchemas } from '../src/v3/schemas.mjs';
import { simulateCounterGame } from '../src/v3/game-simulator.mjs';

test('counter RNG fixtures are stable and bounded', () => {
  assert.equal(counterUint(123n, 4, 5, 1, 2), counterUint(123n, 4, 5, 1, 2));
  assert.notEqual(counterUint(123n, 4, 5, 1, 2), counterUint(123n, 4, 5, 1, 3));
  for (let i = 0; i < 1000; i += 1) assert.ok(counterInt(99n, 6, i, 1, 2, 3) < 6);
  assert.ok(potentialDie(9n, 1, 2, 0, 0) >= 1 && potentialDie(9n, 1, 2, 0, 0) <= 6);
});
test('relative path gate rejects absolute and traversal paths', () => {
  assert.equal(assertRelativePath('a/b.json'), 'a/b.json'); assert.throws(() => assertRelativePath('../x')); assert.throws(() => assertRelativePath('C:\\x')); assert.throws(() => assertRelativePath('a//b')); assert.throws(() => assertRelativePath('a/./b'));
  const root = path.resolve(os.tmpdir(), 'yatzy-path-root'), nested = path.join(root, 'a', 'b');
  assert.equal(resolveWithin(root, 'a/b'), nested);
  assert.equal(assertLexicalContainment(root, root), root);
  assert.equal(assertLexicalContainment(root, nested), nested);
  assert.throws(() => assertLexicalContainment(root, ''), { code: 'YATZY_FS_INVALID_PATH' });
  assert.throws(() => assertLexicalContainment(root, path.resolve(root, '..', 'outside')), { code: 'YATZY_FS_ESCAPE' });
  assert.throws(() => assertLexicalContainment(root, `${root}2`), { code: 'YATZY_FS_ESCAPE' });
  if (process.platform === 'win32') {
    assert.equal(assertLexicalContainment(root.toUpperCase(), nested.toLowerCase()), nested.toLowerCase());
    assert.throws(() => assertLexicalContainment(root, `${root}\\child/../../outside`));
    const rootDrive = path.parse(root).root[0].toUpperCase(), alternateDrive = rootDrive === 'Z' ? 'Y' : 'Z';
    assert.throws(() => assertLexicalContainment(root, `${alternateDrive}:\\outside`), { code: 'YATZY_FS_ESCAPE' });
  }
});
test('non-smoke V3 pipeline requires an explicit absolute output root before computation', async () => {
  assert.throws(() => claimOutputRoot(''), { code: 'YATZY_FS_INVALID_PATH' });
  assert.throws(() => claimOutputRoot('relative-output'), { code: 'YATZY_FS_INVALID_PATH' });
  assert.throws(() => claimOutputRoot(`${path.resolve(os.tmpdir(), 'yatzy-ambiguous')}${path.sep}..${path.sep}yatzy-other`), { code: 'YATZY_FS_INVALID_PATH' });
  await assert.rejects(runV3Pipeline({ mode: 'reduced' }), { code: 'YATZY_FS_INVALID_PATH' });
  await assert.rejects(runV3Pipeline({ mode: 'reduced', outputRoot: 'relative-output' }), { code: 'YATZY_FS_INVALID_PATH' });
});
test('historical scoring differs only for single-pair fallback fixture', () => {
  const four = diceToCounts([4, 4, 4, 4, 6]); assert.equal(scoreCategory(four, 7), 0); assert.equal(scoreCategory(four, 7, { twoPairSinglePairFallback: true }), 8);
  const valid = diceToCounts([2, 2, 2, 5, 5]); assert.equal(scoreCategory(valid, 7), 14); assert.equal(scoreCategory(valid, 7, { twoPairSinglePairFallback: true }), 14);
});
test('action evaluator emits finite values and an explicit class', () => {
  const stateIndex = createStateIndex(), table = new Float64Array(stateIndex.totalStates); const evaluator = new ActionValueEvaluator({ values: table, lower: table, upper: table, stateIndex, cacheSize: 2 });
  const e = evaluator.evaluate(0, 0, 0, 2); assert.ok(Number.isFinite(e.value)); assert.ok(Number.isFinite(e.margin)); assert.ok(['exact_algebraic_tie','certified_interval_tie','numerically_unresolved_overlap','tolerance_near_tie','certified_order','forced_action'].includes(e.tieClass)); assert.ok(Number.isFinite(e.bestScoreValue)); assert.ok(Number.isFinite(e.bestRerollValue));
});
test('one-turn paired baseline uses an explicit zero-continuation evaluator', () => {
  const stateIndex = createStateIndex(), zero = new Float64Array(stateIndex.totalStates), oneTurnEvaluator = new ActionValueEvaluator({ values: zero, lower: zero, upper: zero, stateIndex, cacheSize: 32 });
  const game = simulateCounterGame({ seed: 11n, gameIndex: 0, policyId: 'one_turn', evaluator: oneTurnEvaluator, oneTurnEvaluator }); assert.ok(Number.isInteger(game.finalScore)); assert.ok(game.finalScore >= 0);
});
test('schemas are practical files and figure metadata validates', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yatzy-schema-')); assert.ok(writeSchemas(root) >= 6); assert.ok(fs.existsSync(path.join(root, 'schemas', 'experiments.schema.json')));
  assert.equal(validateFigureMetadata({ figureId:'x',source:'a.csv',transform:'sum bins',population:'games',units:'count',uncertainty:'none',code:'x.mjs',caption:'Valid scientific caption.',sourceSha256:'a'.repeat(64),svgSha256:'b'.repeat(64) }), true);
});
test('complete experiment manifest validates', () => {
  const h='a'.repeat(64), e={id:'x',kind:'test',required:true,status:'COMPLETE',seed:'1',gameCount:1,workers:1,batches:1,durationMs:0,sourceCommit:'abc',inputs:[{path:'in.json'}],outputs:[{path:'out.json'}],rulesHash:h,valuesHash:h,boundsHash:h,policyHash:h};
  assert.equal(validateExperimentManifest({experiments:[e]}),true); assert.equal(assertScientificValue({x:1}),undefined);
});
