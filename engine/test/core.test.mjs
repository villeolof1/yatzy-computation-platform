import test from 'node:test';
import assert from 'node:assert/strict';
import { createDiceUniverse } from '../src/solver/dice.mjs';
import { createStateIndex } from '../src/solver/state-index.mjs';
import { scoreCategory, diceToCounts } from '../src/solver/scoring.mjs';
import { staticChecks } from '../src/solver/verify.mjs';

test('dice and keeper universes have exact cardinalities and probabilities',()=>{
  const u=createDiceUniverse();
  assert.equal(u.rolls.length,252);assert.equal(u.keepers.length,462);
  assert.equal(u.initialMultiplicity.reduce((a,b)=>a+b,0),7776);
  for(let n=0;n<=5;n++)assert.equal(u.outcomeBySize[n].reduce((a,x)=>a+x.multiplicity,0),6**n);
});

test('reachable state index has exact cardinality and round trips',()=>{
  const s=createStateIndex();assert.equal(s.upperPairCount,2794);assert.equal(s.totalStates,1430528);
  for(const i of [0,1,63,12345,1000000,s.totalStates-1]) assert.equal(s.indexOf(s.stateMask[i],s.stateUpper[i]),i);
});

test('Swedish scoring boundary cases are frozen',()=>{
  const c=ds=>diceToCounts(ds);
  assert.equal(scoreCategory(c([1,2,2,3,4]),7),0);
  assert.equal(scoreCategory(c([2,2,2,3,4]),7),0);
  assert.equal(scoreCategory(c([4,4,4,4,6]),7),0);
  assert.equal(scoreCategory(c([6,6,6,6,6]),7),0);
  assert.equal(scoreCategory(c([2,2,2,5,5]),7),14);
  assert.equal(scoreCategory(c([6,6,6,6,6]),6),12);
  assert.equal(scoreCategory(c([6,6,6,6,6]),12),0);
});

test('all mandatory static checks pass',()=>{const c=staticChecks();assert.equal(c.filter(x=>x.required&&!x.passed).length,0);});
