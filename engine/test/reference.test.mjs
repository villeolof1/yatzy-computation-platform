import test from 'node:test';
import assert from 'node:assert/strict';
import { OrderedReferenceSolver } from '../src/solver/reference.mjs';
test('independent ordered-roll reference solver returns known one-category Yatzy value',()=>{
 const r=new OrderedReferenceSolver();const mask=0x7fff^(1<<14),v=r.turnValue(mask,0);
 assert.ok(Math.abs(v-2.301432126285)<1e-10);
});
