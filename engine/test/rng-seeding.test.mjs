import test from 'node:test';
import assert from 'node:assert/strict';
import { XorShift128, gameSeed } from '../src/solver/rng.mjs';

test('all four xorshift state words depend on the per-game seed', () => {
  const [a1,b1]=gameSeed(123456789n,1),[a2,b2]=gameSeed(123456789n,2);
  const r1=new XorShift128(a1,b1),r2=new XorShift128(a2,b2);
  assert.notEqual(r1.a,r2.a); assert.notEqual(r1.b,r2.b);
  assert.notEqual(r1.c,r2.c); assert.notEqual(r1.d,r2.d);
});

test('seeded streams are deterministic and integer draws stay in range', () => {
  const [a,b]=gameSeed(987654321n,42);
  const r1=new XorShift128(a,b),r2=new XorShift128(a,b);
  for(let i=0;i<10000;i+=1){const x=r1.int(6),y=r2.int(6);assert.equal(x,y);assert.ok(x>=0&&x<6);}
});
