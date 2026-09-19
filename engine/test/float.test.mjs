import test from 'node:test';
import assert from 'node:assert/strict';
import { nextDown, nextUp, addDown, addUp, divDown, divUp } from '../src/util/float.mjs';
test('outward floating operations contain ordinary operations',()=>{
  for(const [a,b] of [[0.1,0.2],[248.44,0.0001],[-2.3,4.5]]){
    assert.ok(addDown(a,b)<=a+b);assert.ok(addUp(a,b)>=a+b);
    if(b!==0){assert.ok(divDown(a,b)<=a/b);assert.ok(divUp(a,b)>=a/b);}
  }
  assert.ok(nextDown(1)<1);assert.ok(nextUp(1)>1);
});
