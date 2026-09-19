import test from 'node:test'; import assert from 'node:assert/strict';
import { assertScientificValue, validateExperimentManifest, validateFigureMetadata, assertHistogram } from '../src/v3/quality-gates.mjs';
const h='a'.repeat(64); const base=()=>({id:'x',kind:'test',required:true,status:'COMPLETE',seed:'1',gameCount:1,workers:1,batches:1,durationMs:0,sourceCommit:'abc',inputs:[{path:'in'}],outputs:[{path:'out'}],rulesHash:h,valuesHash:h,boundsHash:h,policyHash:h});
test('quality mutations reject NaN Infinity null and empty data',()=>{assert.throws(()=>assertScientificValue({x:NaN}));assert.throws(()=>assertScientificValue({x:Infinity}));assert.throws(()=>assertScientificValue({x:null}));assert.throws(()=>assertHistogram([],0,'empty'));});
test('manifest mutations reject incomplete absolute and checksum fields',()=>{const a=base();a.status='FAILED';assert.throws(()=>validateExperimentManifest({experiments:[a]}));const b=base();b.outputs=[{path:'C:\\bad'}];assert.throws(()=>validateExperimentManifest({experiments:[b]}));const c=base();c.policyHash='bad';assert.throws(()=>validateExperimentManifest({experiments:[c]}));});
test('caption mutation rejects placeholders',()=>assert.throws(()=>validateFigureMetadata({figureId:'x',source:'x',transform:'x',population:'x',units:'x',uncertainty:'x',code:'x',caption:'TODO placeholder',sourceSha256:h,svgSha256:h})));

