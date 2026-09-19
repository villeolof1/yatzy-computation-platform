import fs from 'node:fs';
import { XorShift128, gameSeed } from './rng.mjs';
import path from 'node:path';
import { createDiceUniverse, multiplicity } from './dice.mjs';
import { createStateIndex } from './state-index.mjs';
import { scoreCategory, diceToCounts } from './scoring.mjs';
import { verifyHeader, VALUE_MAGIC, BOUNDS_MAGIC, readTables, artifactHashes } from './table-format.mjs';
import { OrderedReferenceSolver } from './reference.mjs';
import { verifyPolicyHeader, policyHash, POLICY_HEADER_SIZE, POLICY_STRIDE } from './policy-format.mjs';
import { PolicyEngine } from './query.mjs';
import { writeJsonAtomic } from '../util/fs.mjs';
import { addEvent } from '../database.mjs';

function independentScore(counts, c) {
  const dice = [];
  for (let f=0; f<6; f++) for (let i=0;i<counts[f];i++) dice.push(f+1);
  if (c < 6) return dice.filter(x=>x===c+1).reduce((a,b)=>a+b,0);
  const freq = new Map(); for (const d of dice) freq.set(d,(freq.get(d)||0)+1);
  const faces = [...freq.keys()].sort((a,b)=>b-a);
  if (c===6) { const f=faces.find(x=>freq.get(x)>=2); return f?2*f:0; }
  if (c===7) { const p=faces.filter(x=>freq.get(x)>=2); return p.length>=2?2*(p[0]+p[1]):0; }
  if (c===8) { const f=faces.find(x=>freq.get(x)>=3); return f?3*f:0; }
  if (c===9) { const f=faces.find(x=>freq.get(x)>=4); return f?4*f:0; }
  if (c===10) return dice.join('')==='12345'?15:0;
  if (c===11) return dice.join('')==='23456'?20:0;
  if (c===12) { const t=faces.find(x=>freq.get(x)===3), p=faces.find(x=>freq.get(x)===2); return t&&p?3*t+2*p:0; }
  if (c===13) return dice.reduce((a,b)=>a+b,0);
  if (c===14) return faces.some(x=>freq.get(x)===5)?50:0;
  return 0;
}

export function staticChecks() {
  const dice = createDiceUniverse();
  const states = createStateIndex();
  const checks = [];
  const add=(id,category,required,passed,details={})=>checks.push({id,category,required,passed,details});
  add('dice.roll_count','Combinatorics',true,dice.rolls.length===252,{actual:dice.rolls.length,expected:252});
  add('dice.keeper_count','Combinatorics',true,dice.keepers.length===462,{actual:dice.keepers.length,expected:462});
  add('probability.initial_sum','Probability',true,dice.initialMultiplicity.reduce((a,b)=>a+b,0)===7776,{});
  for(let n=0;n<=5;n++) add(`probability.reroll_${n}`,'Probability',true,dice.outcomeBySize[n].reduce((a,x)=>a+x.multiplicity,0)===6**n,{expected:6**n});
  add('state.upper_pairs','State Index',true,states.upperPairCount===2794,{actual:states.upperPairCount});
  add('state.total','State Index',true,states.totalStates===1430528,{actual:states.totalStates});
  add('state.layer_sum','State Index',true,states.layers.reduce((a,x)=>a+x.length,0)===states.totalStates,{layers:states.layers.map(x=>x.length)});
  const [ra1,rb1]=gameSeed(123456789n,1),[ra2,rb2]=gameSeed(123456789n,2);const rng1=new XorShift128(ra1,rb1),rng2=new XorShift128(ra2,rb2);
  add('rng.full_state_seeded','Randomness',true,rng1.a!==rng2.a&&rng1.b!==rng2.b&&rng1.c!==rng2.c&&rng1.d!==rng2.d,{state1:[rng1.a,rng1.b,rng1.c,rng1.d],state2:[rng2.a,rng2.b,rng2.c,rng2.d]});
  const cases=[
    ['scoring.yatzy_as_pair',[6,6,6,6,6],6,12],['scoring.one_pair_not_two_pairs',[1,2,2,3,4],7,0],
    ['scoring.triple_not_two_pairs',[2,2,2,3,4],7,0],['scoring.four_kind_not_two_pairs',[4,4,4,4,6],7,0],
    ['scoring.yatzy_not_two_pairs',[6,6,6,6,6],7,0],['scoring.valid_two_pairs_with_triple',[2,2,2,5,5],7,14],
    ['scoring.full_house',[3,3,3,6,6],12,21],['scoring.yatzy_not_full_house',[6,6,6,6,6],12,0],
    ['scoring.small_straight',[1,2,3,4,5],10,15],['scoring.large_straight',[2,3,4,5,6],11,20]
  ];
  for(const [id,ds,c,e] of cases) add(id,'Scoring',true,scoreCategory(diceToCounts(ds),c)===e,{dice:ds,expected:e,actual:scoreCategory(diceToCounts(ds),c)});
  let exhaustive=true, mismatch=null;
  outer: for(const counts of dice.rolls) for(let c=0;c<15;c++) { const a=scoreCategory(counts,c),b=independentScore(counts,c); if(a!==b){exhaustive=false;mismatch={counts:Array.from(counts),category:c,a,b};break outer;} }
  add('scoring.exhaustive_3780','Scoring',true,exhaustive,mismatch||{cases:3780});
  return checks;
}

export async function verifyRun({runDir,db,rulesHash,valuesPath,boundsPath,policyPath=path.join(runDir,'policy.bin'),manifest,determinismManifest=null,simulationSummaries=[],requiredOptimalGames=10_000_000,expectedOptimalRuns=10}) {
  const stateIndex=createStateIndex(); const checks=staticChecks();
  const add=(id,category,required,passed,details={})=>checks.push({id,category,required,passed,details});
  const vh=verifyHeader(valuesPath,VALUE_MAGIC,stateIndex.totalStates,rulesHash,1);
  const bh=verifyHeader(boundsPath,BOUNDS_MAGIC,stateIndex.totalStates,rulesHash,2);
  add('artifact.magic','Artifact',true,vh.magic===VALUE_MAGIC,vh); add('artifact.length','Artifact',true,vh.length===vh.expectedLength,vh);
  add('artifact.ruleset_hash','Artifact',true,vh.hash===rulesHash,vh); add('bounds.magic','Numeric',true,bh.magic===BOUNDS_MAGIC,bh);
  const hashes=await artifactHashes(valuesPath,boundsPath);
  add('artifact.payload_hash','Artifact',true,hashes.valuesSha256===manifest.valuesSha256,hashes);
  add('bounds.payload_hash','Numeric',true,hashes.boundsSha256===manifest.boundsSha256,hashes);
  // Load the value and bound tables before constructing the policy engine.
  // Keeping this above the policy verification block prevents a temporal-dead-zone
  // ReferenceError when policy.bin exists (the normal completed-run path).
  const tables=readTables(valuesPath,boundsPath,stateIndex.totalStates);
  if(fs.existsSync(policyPath)&&manifest.policySha256){const ph=verifyPolicyHeader(policyPath,stateIndex.totalStates,rulesHash);const pHash=await policyHash(policyPath);add('policy.header','Policy',true,ph.passed,ph);add('policy.payload_hash','Policy',true,pHash===manifest.policySha256,{actual:pHash,expected:manifest.policySha256});}
  if(fs.existsSync(policyPath)){
    const engine=new PolicyEngine({...tables,stateIndex,cacheSize:128,continuation:'full'}),fd=fs.openSync(policyPath,'r');let agree=true,mismatch=null;
    try{for(let layer=0;layer<15&&agree;layer++){const states=stateIndex.layers[layer],count=Math.min(4,states.length);for(let q=0;q<count&&agree;q++){const idx=states[Math.floor(q*(states.length-1)/Math.max(1,count-1))],mask=stateIndex.stateMask[idx],u=stateIndex.stateUpper[idx],buf=Buffer.alloc(POLICY_STRIDE);fs.readSync(fd,buf,0,buf.length,POLICY_HEADER_SIZE+idx*POLICY_STRIDE);const pol=engine.getPolicy(mask,u);for(const rollId of [0,17,71,143,251])for(let stage=0;stage<3;stage++){const code=pol.actions[stage][rollId];let expected;if(code&0x8000){const keeper=code&0x7fff,begin=engine.universe.legalOffsets[rollId],end=engine.universe.legalOffsets[rollId+1];let local=-1;for(let p=begin;p<end;p++)if(engine.universe.legalKeepers[p]===keeper){local=p-begin;break;}expected=16+local;}else expected=code;if(buf[stage*252+rollId]!==expected){agree=false;mismatch={idx,mask,u,rollId,stage,file:buf[stage*252+rollId],expected};break;}}}}}finally{fs.closeSync(fd);}add('policy.sample_action_agreement','Policy',true,agree,mismatch||{sampledLayers:15,statesPerLayer:4,rollsPerState:5,stages:3});
  }
  let finite=true, contains=true, bad=null;
  for(let i=0;i<stateIndex.totalStates;i++){ const v=tables.values[i],l=tables.lower[i],u=tables.upper[i]; if(!Number.isFinite(v)||!Number.isFinite(l)||!Number.isFinite(u)){finite=false;bad=i;break;} if(!(l<=v&&v<=u)){contains=false;bad=i;break;} }
  add('artifact.finite_range','Artifact',true,finite,{badIndex:bad}); add('bounds.contain_midpoint','Numeric',true,contains,{badIndex:bad});
  let maxWidth=0;for(let i=0;i<stateIndex.totalStates;i++)maxWidth=Math.max(maxWidth,tables.upper[i]-tables.lower[i]);add('bounds.analytical_envelope_width','Numeric',true,maxWidth<=0.0000321,{maxWidth,document:'docs/NUMERICAL_ERROR_BOUND.md'});
  let terminal=true; for(const i of stateIndex.layers[15]) if(tables.values[i]!==0||tables.lower[i]!==0||tables.upper[i]!==0){terminal=false;bad=i;break;}
  add('bellman.terminal_zero','Bellman',true,terminal,{badIndex:bad});
  if(determinismManifest) {
    add('determinism.values_hash','Determinism',true,determinismManifest.valuesSha256===manifest.valuesSha256,{primary:manifest.valuesSha256,secondary:determinismManifest.valuesSha256});
    add('determinism.bounds_hash','Determinism',true,determinismManifest.boundsSha256===manifest.boundsSha256,{primary:manifest.boundsSha256,secondary:determinismManifest.boundsSha256});
  }
  const reference=new OrderedReferenceSolver();
  const samples=[14,12,5];
  for(const c of samples){ const mask=0x7fff^(1<<c), idx=stateIndex.indexOf(mask,0); const expected=reference.turnValue(mask,0); add(`reference.single_category_${c}_0`,'Reference Solver',true,Math.abs(expected-tables.values[idx])<1e-10,{reference:expected,optimized:tables.values[idx]}); }
  // One deterministic two-category late-game state.
  const mask2=0x7fff^(1<<14)^(1<<12), idx2=stateIndex.indexOf(mask2,0); const ref2=reference.turnValue(mask2,0);
  add('reference.two_category_deterministic_sample','Reference Solver',true,Math.abs(ref2-tables.values[idx2])<1e-9,{reference:ref2,optimized:tables.values[idx2]});
  add('external.correct_rules_independent_248_44','External Benchmark',false,Math.abs(manifest.startingExpectedValue-248.44)<0.02,{computed:manifest.startingExpectedValue,target:'approximately 248.44'});
  add('historical.kth_reported_248_63','External Benchmark',false,true,{reported:248.63,note:'Historical released implementation used partial single-pair credit in Two Pairs; not a same-rules target.'});
  if(simulationSummaries.length){
    const opt=simulationSummaries.filter(x=>x.policyId==='optimal'); const n=opt.reduce((a,x)=>a+x.aggregate.n,0); const sum=opt.reduce((a,x)=>a+x.aggregate.sum,0); const sumSq=opt.reduce((a,x)=>a+x.aggregate.sumSq,0);
    const mean=sum/n, variance=(sumSq-sum*sum/n)/(n-1), se=Math.sqrt(variance/n), agreement=Math.abs(mean-manifest.startingExpectedValue)<=3*se+1e-9;
    add('simulation.minimum_game_count','Simulation',true,n>=requiredOptimalGames,{games:n,required:requiredOptimalGames});
    add('simulation.optimal_policy_agreement','Simulation',true,agreement,{mean,exact:manifest.startingExpectedValue,se,z:(mean-manifest.startingExpectedValue)/se});
    add('simulation.seed_and_policy','Simulation',true,opt.length===expectedOptimalRuns&&new Set(opt.map(x=>x.seed)).size===expectedOptimalRuns,{runs:opt.length,expectedRuns:expectedOptimalRuns,uniqueSeeds:new Set(opt.map(x=>x.seed)).size});
  }
  const now=new Date().toISOString();
  db.exec('BEGIN IMMEDIATE');
  try{ const stmt=db.prepare(`INSERT INTO verification_checks(id,category,required,passed,details_json,completed_at) VALUES (?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET category=excluded.category,required=excluded.required,passed=excluded.passed,details_json=excluded.details_json,completed_at=excluded.completed_at`); for(const c of checks) stmt.run(c.id,c.category,c.required?1:0,c.passed?1:0,JSON.stringify(c.details),now); db.exec('COMMIT'); }catch(e){db.exec('ROLLBACK');throw e;}
  const required=checks.filter(c=>c.required), publicationReady=required.every(c=>c.passed);
  const report={completedAt:now,publicationReady,mandatoryPassed:required.filter(c=>c.passed).length,mandatoryTotal:required.length,totalChecks:checks.length,checks};
  writeJsonAtomic(path.join(runDir,'verification.json'),report); addEvent(db,publicationReady?'info':'error','VERIFICATION_COMPLETE',publicationReady?'All mandatory verification checks passed':'Mandatory verification failure',report);
  return report;
}
