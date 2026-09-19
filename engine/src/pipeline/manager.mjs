import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import { openRunDatabase, setMeta, getMeta, addEvent, checkpointDb } from '../database.mjs';
import { ensureDir, writeJsonAtomic, readJson, copyFileAtomic } from '../util/fs.mjs';
import { stableJson, sha256Text } from '../util/hash.mjs';
import { runPreflight } from './preflight.mjs';
import { runPrecomputation } from '../solver/precompute.mjs';
import { verifyRun } from '../solver/verify.mjs';
import { createSimulationPlan, runSimulationPlan } from '../solver/simulation.mjs';
import { seed64 } from '../solver/rng.mjs';
import { runAnalysis } from '../analysis/analyze.mjs';
import { buildDossier, renderDossierPdf, buildResearchBundle } from '../analysis/dossier.mjs';
import { OrderedReferenceSolver } from '../solver/reference.mjs';

const STAGES=[
  ['preflight','Scientific preflight',1],['precompute','Exact precomputation',14],['determinism','Deterministic verification build',14],['model_verify','Model verification',3],
  ['pilot_simulation','500,000-game simulation gate',3],['optimal_simulations','10 × 1,000,000 optimal simulations',31],['policy_comparisons','Policy comparison suite',14],['final_verify','Final verification',3],
  ['analysis','Exact and simulation analysis',10],['dossier','Evidence dossier',3],['bundle','Audited research package',4]
];

export const LEGACY_COMPLETE_PIPELINE_PROFILE_ID='legacy-complete-pipeline-v3';
export const PUBLIC_SMOKE_PROFILE_ID='public-smoke-v1';

const LEGACY_OVERRIDE_FIELDS=new Set(['workers','simulationWorkers','gamesPerRun','determinismBuild','copyToDownloads']);

function configurationError(message){
  const error=new Error(message);
  error.code='YATZY_CONFIG_INVALID';
  return error;
}

function requireBoundedInteger(field,value,minimum,maximum){
  if(!Number.isSafeInteger(value)||value<minimum||value>maximum)throw configurationError(`Invalid ${field}: expected an integer from ${minimum} through ${maximum}.`);
}

function requireBoolean(field,value){
  if(typeof value!=='boolean')throw configurationError(`Invalid ${field}: expected a boolean.`);
}

export function legacyDefaultConfig(logicalCores){
  if(!Number.isSafeInteger(logicalCores)||logicalCores<1)throw configurationError('Invalid logical core count: expected a positive safe integer.');
  return{
    optimalRuns:10,
    gamesPerRun:1_000_000,
    comparisonGames:1_000_000,
    workers:Math.max(1,Math.min(12,logicalCores-1)),
    simulationWorkers:Math.min(5,Math.max(1,logicalCores-1)),
    chunkSize:4096,
    simulationBatchSize:50_000,
    pilotGames:500_000,
    determinismBuild:true,
    includeValueTable:true,
    copyToDownloads:true
  };
}

export function resolveLegacyPipelineConfig(input={},logicalCores=os.availableParallelism()){
  if(input===null||typeof input!=='object'||Array.isArray(input)||Object.getPrototypeOf(input)!==Object.prototype)throw configurationError('Invalid legacy pipeline configuration: expected a plain JSON object.');
  const descriptors=Object.getOwnPropertyDescriptors(input);
  const overrides={};
  for(const key of Reflect.ownKeys(descriptors)){
    if(typeof key!=='string')throw configurationError('Invalid legacy pipeline configuration key: symbol keys are not allowed.');
    const descriptor=descriptors[key];
    if(!descriptor.enumerable||!Object.hasOwn(descriptor,'value')||!LEGACY_OVERRIDE_FIELDS.has(key))throw configurationError(`Invalid legacy pipeline configuration key "${key}": key is not allowed.`);
    const value=descriptor.value;
    if(key==='workers')requireBoundedInteger(key,value,1,12);
    else if(key==='simulationWorkers')requireBoundedInteger(key,value,1,8);
    else if(key==='gamesPerRun')requireBoundedInteger(key,value,1_000,1_000_000);
    else requireBoolean(key,value);
    overrides[key]=value;
  }
  return{...legacyDefaultConfig(logicalCores),...overrides};
}

class Control {
  constructor(manager){this.manager=manager;this.pauseRequested=false;this.stopRequested=false;this.waiters=[];}
  async waitUntilResumed(){await this.manager.markPaused();return new Promise((resolve,reject)=>this.waiters.push({resolve,reject}));}
  resume(){this.pauseRequested=false;for(const w of this.waiters.splice(0))w.resolve();}
  stop(){this.stopRequested=true;for(const w of this.waiters.splice(0))w.reject(new Error('Stopped'));}
}

export class PipelineManager extends EventEmitter {
  constructor(projectRoot){super();this.projectRoot=projectRoot;this.dataRoot=ensureDir(path.join(projectRoot,'data'));this.activeFile=path.join(this.dataRoot,'active-pipeline.json');this.db=null;this.runDir=null;this.control=new Control(this);this.runningPromise=null;this.currentStage=null;this.rules=JSON.parse(fs.readFileSync(path.join(projectRoot,'rules','swedish-alga-free-order-v1.json'),'utf8'));this.rulesHash=sha256Text(stableJson(this.rules));this.lastProgress={};}
  async initialize(){const active=readJson(this.activeFile);if(active?.runDir&&fs.existsSync(active.runDir)){this.runDir=active.runDir;this.db=openRunDatabase(this.runDir);const status=getMeta(this.db,'pipeline.status','UNKNOWN');if(['RUNNING','RECOVERING','PAUSING'].includes(status)){setMeta(this.db,'pipeline.status','RECOVERING');this.runningPromise=this.execute().catch(e=>this.fail(e));}}}
  makeRunId(){return `run_${new Date().toISOString().replace(/[-:.]/g,'').replace('Z','Z')}_${Math.random().toString(16).slice(2,10)}`;}
  defaultConfig(){return legacyDefaultConfig(os.availableParallelism());}
  runPublicSmoke(){const runDir=ensureDir(path.join(this.dataRoot,'smoke'));const preflight=runPreflight({projectRoot:this.projectRoot,runDir,rulesHash:this.rulesHash});const referenceValue=new OrderedReferenceSolver().turnValue(0x7fff^(1<<14),0);return{profileId:PUBLIC_SMOKE_PROFILE_ID,preflight,referenceValue,generatedPayloadFiles:0,precomputationWorkers:0,simulationWorkers:0};}
  async start(config={}){if(this.runningPromise)throw new Error('A pipeline is already running');const merged=resolveLegacyPipelineConfig(config,os.availableParallelism());const runId=this.makeRunId();this.runDir=ensureDir(path.join(this.dataRoot,'runs',runId));this.db=openRunDatabase(this.runDir);setMeta(this.db,'pipeline.id',runId);setMeta(this.db,'pipeline.profileId',LEGACY_COMPLETE_PIPELINE_PROFILE_ID);setMeta(this.db,'pipeline.status','RUNNING');setMeta(this.db,'pipeline.config',merged);setMeta(this.db,'pipeline.rulesHash',this.rulesHash);setMeta(this.db,'pipeline.createdAt',new Date().toISOString());const stmt=this.db.prepare(`INSERT OR REPLACE INTO pipeline_stages(id,ordinal,label,status,progress,total_units) VALUES (?,?,?,'PENDING',0,?)`);for(let i=0;i<STAGES.length;i++)stmt.run(STAGES[i][0],i,STAGES[i][1],STAGES[i][2]);writeJsonAtomic(this.activeFile,{runDir:this.runDir,runId});addEvent(this.db,'info','PIPELINE_CREATED','Complete research pipeline created',{profileId:LEGACY_COMPLETE_PIPELINE_PROFILE_ID,config:merged,rulesHash:this.rulesHash});this.control=new Control(this);this.runningPromise=this.execute().catch(e=>this.fail(e));return{runId,runDir:this.runDir};}
  async markPaused(){setMeta(this.db,'pipeline.status','PAUSED');if(this.currentStage)this.db.prepare(`UPDATE pipeline_stages SET status='PAUSED' WHERE id=?`).run(this.currentStage);checkpointDb(this.db);this.emitUpdate();}
  async pause(){if(!this.runningPromise)return;this.control.pauseRequested=true;setMeta(this.db,'pipeline.status','PAUSING');if(this.currentStage)this.db.prepare(`UPDATE pipeline_stages SET status='PAUSING' WHERE id=?`).run(this.currentStage);this.emitUpdate();}
  async resume(){if(!this.db)return;setMeta(this.db,'pipeline.status','RUNNING');if(this.currentStage)this.db.prepare(`UPDATE pipeline_stages SET status='RUNNING' WHERE id=?`).run(this.currentStage);this.control.resume();if(!this.runningPromise)this.runningPromise=this.execute().catch(e=>this.fail(e));this.emitUpdate();}
  async stop(){if(!this.db)return;this.control.stop();setMeta(this.db,'pipeline.status','CANCELLED');if(this.currentStage)this.db.prepare(`UPDATE pipeline_stages SET status='CANCELLED' WHERE id=?`).run(this.currentStage);this.emitUpdate();}
  stageDone(id){return this.db.prepare(`SELECT status FROM pipeline_stages WHERE id=?`).get(id)?.status==='COMPLETE';}
  beginStage(id){this.currentStage=id;setMeta(this.db,'pipeline.currentStage',id);this.db.prepare(`UPDATE pipeline_stages SET status='RUNNING',started_at=COALESCE(started_at,?),error_json=NULL WHERE id=?`).run(new Date().toISOString(),id);this.emitUpdate();}
  progressStage(id,progress,detail={}){const p=Math.max(0,Math.min(1,Number(progress)||0));this.lastProgress[id]={progress:p,...detail};this.db.prepare(`UPDATE pipeline_stages SET progress=?,completed_units=?,detail_json=? WHERE id=?`).run(p,p,JSON.stringify(detail),id);this.emitUpdate();}
  completeStage(id,detail={}){this.db.prepare(`UPDATE pipeline_stages SET status='COMPLETE',progress=1,completed_units=1,completed_at=?,detail_json=? WHERE id=?`).run(new Date().toISOString(),JSON.stringify(detail),id);this.emitUpdate();}
  emitUpdate(){this.emit('update',this.status());}
  async execute(){const cfg=getMeta(this.db,'pipeline.config',this.defaultConfig());setMeta(this.db,'pipeline.status','RUNNING');
    if(!this.stageDone('preflight')){this.beginStage('preflight');const result=runPreflight({projectRoot:this.projectRoot,runDir:this.runDir,rulesHash:this.rulesHash});writeJsonAtomic(path.join(this.runDir,'preflight.json'),result);if(!result.passed)throw new Error('Scientific preflight failed');this.completeStage('preflight',{checks:result.checks.length,environment:result.environment});}
    let primary=getMeta(this.db,'primary.manifest');if(!this.stageDone('precompute')){this.beginStage('precompute');const r=await runPrecomputation({runDir:this.runDir,db:this.db,rulesHash:this.rulesHash,buildId:'primary',workers:cfg.workers,chunkSize:cfg.chunkSize,control:this.control,onProgress:p=>this.progressStage('precompute',p.progress,p)});primary=r.manifest??JSON.parse(fs.readFileSync(r.manifestPath,'utf8'));this.completeStage('precompute',{startingExpectedValue:primary.startingExpectedValue,hash:primary.valuesSha256});}
    else primary=getMeta(this.db,'primary.manifest')??JSON.parse(fs.readFileSync(path.join(this.runDir,'manifest.json'),'utf8'));
    let deterministic=null;if(cfg.determinismBuild){if(!this.stageDone('determinism')){this.beginStage('determinism');const r=await runPrecomputation({runDir:this.runDir,db:this.db,rulesHash:this.rulesHash,buildId:'determinism',workers:Math.max(1,Math.floor(cfg.workers/2)),chunkSize:cfg.chunkSize,control:this.control,verificationBuild:true,onProgress:p=>this.progressStage('determinism',p.progress,p)});deterministic=r.manifest??JSON.parse(fs.readFileSync(r.manifestPath,'utf8'));if(deterministic.valuesSha256!==primary.valuesSha256||deterministic.boundsSha256!==primary.boundsSha256)throw new Error('Deterministic verification build did not match');this.completeStage('determinism',{valuesMatch:true,boundsMatch:true});}else deterministic=getMeta(this.db,'determinism.manifest');}else this.completeStage('determinism',{skipped:true});
    if(!this.stageDone('model_verify')){this.beginStage('model_verify');const report=await verifyRun({runDir:this.runDir,db:this.db,rulesHash:this.rulesHash,valuesPath:path.join(this.runDir,'values.bin'),boundsPath:path.join(this.runDir,'bounds.bin'),manifest:primary,determinismManifest:deterministic,simulationSummaries:[]});if(!report.checks.filter(x=>x.required).every(x=>x.passed))throw new Error('Model verification failed');this.completeStage('model_verify',{mandatoryPassed:report.mandatoryPassed,mandatoryTotal:report.mandatoryTotal});}
    const pilotPlan=[{id:'pilot_optimal',policyId:'optimal',runNumber:0,gameCount:cfg.pilotGames,seedNamespace:'yatzy-publication-v1-pilot',seed:seed64('yatzy-publication-v1-pilot').toString()}];
    if(!this.stageDone('pilot_simulation')){this.beginStage('pilot_simulation');const pilot=await runSimulationPlan({runDir:this.runDir,db:this.db,valuesPath:path.join(this.runDir,'values.bin'),boundsPath:path.join(this.runDir,'bounds.bin'),plan:pilotPlan,workers:cfg.simulationWorkers,batchSize:cfg.simulationBatchSize,control:this.control,onProgress:p=>this.progressStage('pilot_simulation',p.progress,p)});const pilotReport=await verifyRun({runDir:this.runDir,db:this.db,rulesHash:this.rulesHash,valuesPath:path.join(this.runDir,'values.bin'),boundsPath:path.join(this.runDir,'bounds.bin'),manifest:primary,determinismManifest:deterministic,simulationSummaries:pilot,requiredOptimalGames:cfg.pilotGames,expectedOptimalRuns:1});const gate=pilotReport.checks.find(x=>x.id==='simulation.optimal_policy_agreement');if(!gate?.passed)throw new Error(`Pilot simulation did not agree with exact value (z=${gate?.details?.z})`);this.completeStage('pilot_simulation',{games:cfg.pilotGames,mean:gate.details.mean,exact:gate.details.exact,z:gate.details.z});}
    const fullPlan=createSimulationPlan({optimalRuns:cfg.optimalRuns,gamesPerRun:cfg.gamesPerRun,comparisonGames:cfg.comparisonGames});const optimalPlan=fullPlan.filter(x=>x.policyId==='optimal'),comparisonPlan=fullPlan.filter(x=>x.policyId!=='optimal');let optimalSummaries=[];
    if(!this.stageDone('optimal_simulations')){this.beginStage('optimal_simulations');optimalSummaries=await runSimulationPlan({runDir:this.runDir,db:this.db,valuesPath:path.join(this.runDir,'values.bin'),boundsPath:path.join(this.runDir,'bounds.bin'),plan:optimalPlan,workers:cfg.simulationWorkers,batchSize:cfg.simulationBatchSize,control:this.control,onProgress:p=>this.progressStage('optimal_simulations',p.progress,p)});this.completeStage('optimal_simulations',{runs:optimalSummaries.length,games:optimalSummaries.reduce((a,x)=>a+x.gameCount,0)});}else optimalSummaries=optimalPlan.map(x=>JSON.parse(this.db.prepare(`SELECT summary_json FROM simulation_runs WHERE id=?`).get(x.id).summary_json));
    let comparisonSummaries=[];if(!this.stageDone('policy_comparisons')){this.beginStage('policy_comparisons');comparisonSummaries=await runSimulationPlan({runDir:this.runDir,db:this.db,valuesPath:path.join(this.runDir,'values.bin'),boundsPath:path.join(this.runDir,'bounds.bin'),plan:comparisonPlan,workers:cfg.simulationWorkers,batchSize:cfg.simulationBatchSize,control:this.control,onProgress:p=>this.progressStage('policy_comparisons',p.progress,p)});this.completeStage('policy_comparisons',{policies:comparisonSummaries.length,games:comparisonSummaries.reduce((a,x)=>a+x.gameCount,0)});}else comparisonSummaries=comparisonPlan.map(x=>JSON.parse(this.db.prepare(`SELECT summary_json FROM simulation_runs WHERE id=?`).get(x.id).summary_json));
    const summaries=[...optimalSummaries,...comparisonSummaries];let verification;if(!this.stageDone('final_verify')){this.beginStage('final_verify');verification=await verifyRun({runDir:this.runDir,db:this.db,rulesHash:this.rulesHash,valuesPath:path.join(this.runDir,'values.bin'),boundsPath:path.join(this.runDir,'bounds.bin'),manifest:primary,determinismManifest:deterministic,simulationSummaries:summaries,requiredOptimalGames:cfg.optimalRuns*cfg.gamesPerRun,expectedOptimalRuns:cfg.optimalRuns});if(!verification.publicationReady)throw new Error('Final publication readiness checks failed');this.completeStage('final_verify',{publicationReady:true,mandatoryPassed:verification.mandatoryPassed});}else verification=JSON.parse(fs.readFileSync(path.join(this.runDir,'verification.json'),'utf8'));
    let analysis;if(!this.stageDone('analysis')){this.beginStage('analysis');analysis=await runAnalysis({runDir:this.runDir,manifest:primary,valuesPath:path.join(this.runDir,'values.bin'),boundsPath:path.join(this.runDir,'bounds.bin'),simulationSummaries:summaries,verification,onProgress:p=>this.progressStage('analysis',p.progress,p)});this.completeStage('analysis',{figures:analysis.inventory.figuresSvg.length,tables:analysis.inventory.tables.length});}else analysis={master:JSON.parse(fs.readFileSync(path.join(this.runDir,'master_results.json'),'utf8'))};
    const master=analysis.master??JSON.parse(fs.readFileSync(path.join(this.runDir,'master_results.json'),'utf8'));if(!this.stageDone('dossier')){this.beginStage('dossier');const html=buildDossier({runDir:this.runDir,master,verification,manifest:primary,simulationSummaries:summaries});const pdf=renderDossierPdf(html,master);this.progressStage('dossier',1,{html,pdf});this.completeStage('dossier',{html:path.basename(html),pdf:path.basename(pdf.pdf),browser:pdf.browser,fallback:pdf.fallback??false});}
    if(!this.stageDone('bundle')){this.beginStage('bundle');
      const provenanceDir=ensureDir(path.join(this.runDir,'provenance'));checkpointDb(this.db);
      writeJsonAtomic(path.join(provenanceDir,'pipeline_stages.json'),this.db.prepare(`SELECT * FROM pipeline_stages ORDER BY ordinal`).all());
      writeJsonAtomic(path.join(provenanceDir,'pipeline_events.json'),this.db.prepare(`SELECT * FROM events ORDER BY id`).all());
      writeJsonAtomic(path.join(provenanceDir,'environment.json'),JSON.parse(fs.readFileSync(path.join(this.runDir,'preflight.json'),'utf8')).environment);
      writeJsonAtomic(path.join(provenanceDir,'configuration.json'),cfg);
      copyFileAtomic(path.join(this.runDir,'run.sqlite'),path.join(provenanceDir,'run.sqlite'));
      const bundle=await buildResearchBundle({projectRoot:this.projectRoot,runDir:this.runDir,master,onProgress:p=>this.progressStage('bundle',p.progress,p),copyToDownloads:cfg.copyToDownloads});setMeta(this.db,'pipeline.bundle',bundle);this.completeStage('bundle',{bundlePath:bundle.bundlePath,downloadsCopy:bundle.downloadsCopy,sha256:bundle.bundleManifest.sha256});}
    setMeta(this.db,'pipeline.status','COMPLETE');setMeta(this.db,'pipeline.completedAt',new Date().toISOString());setMeta(this.db,'pipeline.currentStage',null);checkpointDb(this.db);this.currentStage=null;this.runningPromise=null;this.emitUpdate();return this.status();}
  async fail(error){if(!this.db)return;const status=this.control.stopRequested?'CANCELLED':'FAILED_RECOVERABLE';setMeta(this.db,'pipeline.status',status);if(this.currentStage)this.db.prepare(`UPDATE pipeline_stages SET status=?,error_json=? WHERE id=?`).run(status,JSON.stringify({message:error.message,stack:error.stack}),this.currentStage);addEvent(this.db,'error','PIPELINE_FAILED',error.message,{stack:error.stack});checkpointDb(this.db);this.runningPromise=null;this.emitUpdate();}
  status(){if(!this.db)return{status:'UNINITIALIZED',rulesHash:this.rulesHash,defaultProfileId:PUBLIC_SMOKE_PROFILE_ID};const stages=this.db.prepare(`SELECT * FROM pipeline_stages ORDER BY ordinal`).all().map(x=>({...x,detail:JSON.parse(x.detail_json||'{}'),error:x.error_json?JSON.parse(x.error_json):null}));const totalWeight=STAGES.reduce((a,x)=>a+x[2],0);let weighted=0;for(const s of stages){const w=STAGES.find(x=>x[0]===s.id)?.[2]??0;weighted+=w*(s.status==='COMPLETE'?1:s.progress);}const layers=this.db.prepare(`SELECT * FROM layers ORDER BY layer DESC`).all();const simulations=this.db.prepare(`SELECT id,policy_id,run_number,game_count,completed_games,seed,status,started_at,completed_at FROM simulation_runs ORDER BY policy_id,run_number`).all();const verification=this.db.prepare(`SELECT id,category,required,passed,details_json,completed_at FROM verification_checks ORDER BY category,id`).all().map(x=>({...x,details:JSON.parse(x.details_json)}));const bundle=getMeta(this.db,'pipeline.bundle');return{status:getMeta(this.db,'pipeline.status','UNKNOWN'),runId:getMeta(this.db,'pipeline.id'),runDir:this.runDir,currentStage:getMeta(this.db,'pipeline.currentStage'),createdAt:getMeta(this.db,'pipeline.createdAt'),completedAt:getMeta(this.db,'pipeline.completedAt'),config:getMeta(this.db,'pipeline.config'),rulesHash:this.rulesHash,overallProgress:weighted/totalWeight,stages,layers,simulations,verification,bundle,defaultProfileId:PUBLIC_SMOKE_PROFILE_ID,memory:{rss:process.memoryUsage().rss,heapUsed:process.memoryUsage().heapUsed,freeSystem:os.freemem()},safeToCloseBrowser:true,safeToPowerOff:['PAUSED','COMPLETE','FAILED_RECOVERABLE','CANCELLED'].includes(getMeta(this.db,'pipeline.status'))};}
}
