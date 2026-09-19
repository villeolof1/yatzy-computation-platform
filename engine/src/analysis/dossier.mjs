import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';
import { ensureDir, ensureOwnedDir, writeTextAtomic, listFilesRecursive, copyFileAtomic, writeJsonAtomic } from '../util/fs.mjs';
import { sha256File } from '../util/hash.mjs';
import { createZip, verifyZip } from '../util/zip.mjs';
import { ChildProcessPolicyError, runControlledProcessSync } from '../util/child-process.mjs';
import { claimOutputRoot } from '../v3/paths.mjs';
import { createSourceSnapshotPlan, materializeSourceSnapshot } from '../v3/source-snapshot.mjs';

function esc(x){return String(x??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;');}
function pct(x){return `${(x*100).toFixed(3)}%`;}
function num(x,d=6){return Number(x).toFixed(d);}
function table(headers,rows){return `<table><thead><tr>${headers.map(x=>`<th>${esc(x)}</th>`).join('')}</tr></thead><tbody>${rows.map(r=>`<tr>${r.map(x=>`<td>${esc(x)}</td>`).join('')}</tr>`).join('')}</tbody></table>`;}
function figure(name,caption){return `<figure><img src="figures/svg/${name}.svg" alt="${esc(caption)}"><figcaption>${esc(caption)} · Source data are included in the tables and analysis directories.</figcaption></figure>`;}

export function buildDossier({runDir,master,verification,manifest,simulationSummaries}){
  const opt=simulationSummaries.filter(x=>x.policyId==='optimal');const policy=master.policies;
  const verificationRows=verification.checks.map(c=>[c.passed?'PASS':'FAIL',c.id,c.category,c.required?'Required':'Informative']);
  const runRows=opt.map((x,i)=>[i+1,x.seed,x.gameCount,num(x.mean,6),num(x.sd,4),pct(x.aggregate.bonusCount/x.gameCount),pct(x.aggregate.yatzyGameCount/x.gameCount)]);
  const catRows=master.categories.map(x=>[x.category,num(x.mean,4),num(x.sd,4),pct(x.zero_frequency),num(x.mean_fill_turn,3)]);
  const policyRows=policy.map(x=>[x.policy,x.games,num(x.mean,4),num(x.loss_vs_optimal,4),pct(x.bonus_frequency),pct(x.yatzy_frequency)]);
  const html=`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Yatzy Research Evidence Dossier</title><style>
  :root{--ink:#14232d;--muted:#5e7180;--line:#d8e0e5;--paper:#fafaf8;--accent:#176b87;--accent2:#64ccc5;--ok:#166534}*{box-sizing:border-box}body{margin:0;background:var(--paper);color:var(--ink);font-family:Inter,Segoe UI,Arial,sans-serif;line-height:1.55}.cover{min-height:92vh;padding:9vw;display:flex;flex-direction:column;justify-content:space-between;background:linear-gradient(145deg,#f8fbfc,#e8f3f4)}.cover h1{font-size:clamp(42px,7vw,86px);line-height:1.02;max-width:950px;margin:0}.cover p{font-size:20px;max-width:760px;color:var(--muted)}.identity{display:grid;grid-template-columns:repeat(4,1fr);gap:18px}.identity div{border-top:2px solid var(--ink);padding-top:10px}.identity strong{display:block;font-size:12px;text-transform:uppercase;letter-spacing:.09em;color:var(--muted)}main{max-width:1120px;margin:auto;padding:70px 40px}section{margin:0 0 90px}h2{font-size:38px;line-height:1.1;margin:0 0 24px}h3{font-size:24px;margin-top:42px}.lead{font-size:20px;color:var(--muted);max-width:850px}.metrics{display:grid;grid-template-columns:repeat(4,1fr);gap:16px;margin:28px 0}.metric{border:1px solid var(--line);border-radius:12px;padding:20px;background:white}.metric b{font-size:28px;display:block}.metric span{font-size:13px;color:var(--muted)}table{border-collapse:collapse;width:100%;font-size:13px;background:white}th,td{border-bottom:1px solid var(--line);padding:9px 10px;text-align:left}th{background:#eef4f6;font-weight:700}figure{margin:38px 0 60px}figure img{width:100%;border:1px solid var(--line);border-radius:10px;background:white}figcaption{font-size:13px;color:var(--muted);margin-top:8px}.note{border-left:4px solid var(--accent);padding:16px 20px;background:#edf7f8}.pass{color:var(--ok);font-weight:700}.toc{columns:2}.toc a{display:block;color:var(--accent);text-decoration:none;margin:7px 0}code{background:#edf1f3;padding:2px 5px;border-radius:4px}@media(max-width:800px){.identity,.metrics{grid-template-columns:1fr 1fr}main{padding:45px 20px}.toc{columns:1}}@media print{.cover{min-height:95vh;page-break-after:always}section{page-break-before:auto}figure,table{break-inside:avoid}a{color:inherit;text-decoration:none}}
  </style></head><body><header class="cover"><div><h1>Exact Swedish Yatzy<br>Research Evidence Dossier</h1><p>A factual, machine-generated package of mathematical results, verification evidence, simulation statistics, strategy comparisons, figures, tables, raw-data inventories, and reproducibility metadata. It is evidence for a later paper and case study—not the paper itself.</p></div><div class="identity"><div><strong>Ruleset</strong>${esc(master.rulesetId)}</div><div><strong>Run</strong>${esc(master.runId)}</div><div><strong>Exact value</strong>${num(master.exact.midpoint,12)}</div><div><strong>Optimal games</strong>${master.simulation.totalGames.toLocaleString()}</div></div></header><main>
  <section><h2>Contents</h2><div class="toc">${['Run identity','Rules and state model','Exact computational result','Verification register','Computational performance','Ten-million-game simulation','Score distribution','Category analysis','Bonus and Yatzy analysis','Decision analysis','Policy comparisons','Interesting positions and raw data','Reproduction and provenance'].map((x,i)=>`<a href="#s${i+1}">${i+1}. ${x}</a>`).join('')}</div></section>
  <section id="s1"><h2>1. Run identity</h2><p class="lead">The values below identify the frozen computation and the exact artifacts used by every downstream result.</p>${table(['Field','Value'],[['Ruleset',master.rulesetId],['Rules SHA-256',master.rulesHash],['Value-table SHA-256',master.artifacts.valuesSha256],['Bounds SHA-256',master.artifacts.boundsSha256],['Runtime',`${manifest.runtime.node} · ${manifest.runtime.platform} ${manifest.runtime.arch}`],['CPU',manifest.runtime.cpu],['Workers',manifest.workers],['State count',manifest.stateCount.toLocaleString()],['Completed',manifest.completedAt]])}</section>
  <section id="s2"><h2>2. Rules and state model</h2><p>The canonical model uses five fair six-sided dice, two rerolls, fifteen free-order Swedish categories, a 50-point bonus at an upper subtotal of 63, no repeated-Yatzy bonus, and no Joker rule. Two Pairs requires two distinct face values.</p>${figure('17_state_compression','Complete history is reduced to the used-category mask and capped upper subtotal.')}${figure('16_architecture','One-button scientific pipeline from frozen rules to audited package.')}</section>
  <section id="s3"><h2>3. Exact computational result</h2><div class="metrics"><div class="metric"><b>${num(master.exact.midpoint,12)}</b><span>Exact-model midpoint</span></div><div class="metric"><b>${num(master.exact.lower,12)}</b><span>Conservative lower bound</span></div><div class="metric"><b>${num(master.exact.upper,12)}</b><span>Conservative upper bound</span></div><div class="metric"><b>${master.exact.stateCount.toLocaleString()}</b><span>Reachable states</span></div></div><p class="note">The Bellman value is the primary theoretical result. Simulation estimates below validate policy execution but do not replace the exact value.</p>${figure('01_state_counts_by_layer','Reachable turn-boundary states by dependency layer.')}${figure('12_bonus_shadow_heatmap','Average marginal value of one additional upper-section point.')}</section>
  <section id="s4"><h2>4. Verification register</h2><div class="metrics"><div class="metric"><b class="pass">${verification.publicationReady?'YES':'NO'}</b><span>Publication-ready gate</span></div><div class="metric"><b>${verification.mandatoryPassed}/${verification.mandatoryTotal}</b><span>Mandatory checks passed</span></div><div class="metric"><b>${verification.totalChecks}</b><span>Total checks</span></div><div class="metric"><b>${verification.checks.filter(x=>!x.required).length}</b><span>Informative checks</span></div></div>${table(['Status','Check','Category','Gate'],verificationRows)}</section>
  <section id="s5"><h2>5. Computational performance</h2>${table(['Metric','Value'],[['Precomputation duration',`${(manifest.durationMs/1000).toFixed(2)} seconds`],['Workers',manifest.workers],['Chunk size',manifest.chunkSize],['States',manifest.stateCount.toLocaleString()],['Value artifact',master.artifacts.valuesSha256],['Bounds artifact',master.artifacts.boundsSha256]])}${figure('18_durability_protocol','Data are made durable before the SQLite completion marker is committed.')}</section>
  <section id="s6"><h2>6. Ten-million-game optimal-policy simulation</h2><div class="metrics"><div class="metric"><b>${num(master.simulation.mean,5)}</b><span>Pooled mean</span></div><div class="metric"><b>${num(master.simulation.sd,4)}</b><span>Standard deviation</span></div><div class="metric"><b>${pct(master.simulation.bonusFrequency)}</b><span>Upper bonus</span></div><div class="metric"><b>${pct(master.simulation.yatzyFrequency)}</b><span>At least one Yatzy roll</span></div></div>${table(['Run','Seed','Games','Mean','SD','Bonus','Yatzy'],runRows)}${figure('02_simulation_convergence','Cumulative run-level mean compared with the exact expectation.')}${figure('03_independent_run_means','Means from ten independently seeded million-game runs.')}</section>
  <section id="s7"><h2>7. Score distribution</h2>${table(['Statistic','Value'],[['Minimum',master.simulation.min],['1st percentile',master.simulation.q01],['5th percentile',master.simulation.q05],['Median',master.simulation.median],['95th percentile',master.simulation.q95],['99th percentile',master.simulation.q99],['Maximum',master.simulation.max]])}${figure('04_final_score_distribution','One-point final-score histogram, displayed in ten-point bins.')}${figure('05_score_cdf','Empirical cumulative final-score distribution.')}</section>
  <section id="s8"><h2>8. Category analysis</h2>${table(['Category','Mean','SD','Zero frequency','Mean fill turn'],catRows)}${figure('07_category_means','Mean points contributed by each scorecard category.')}${figure('08_category_zero_frequency','Probability that each category is recorded as zero.')}${figure('14_category_correlations','Absolute Pearson correlation between each category and final score.')}${figure('13_turn_trajectories','Mean cumulative score and upper subtotal across turns.')}</section>
  <section id="s9"><h2>9. Bonus and Yatzy analysis</h2><p>Upper-bonus and Yatzy frequencies include Wilson confidence intervals in <code>master_results.json</code>. Full conditional distributions, upper-subtotal counts, and turn trajectories are included as reusable CSV datasets.</p>${figure('06_bonus_probability_by_turn','Cumulative probability that the upper bonus has been earned by each turn.')}${figure('12_bonus_shadow_heatmap','Exact-state marginal upper-point values by game stage and distance to the bonus.')}</section>
  <section id="s10"><h2>10. Decision analysis</h2><p>The run preserves complete streaming aggregates for score-versus-reroll choices, keeper sizes, action margins, ties, early scoring, reroll value, and high-regret surprising positions.</p>${figure('09_keeper_sizes','Number of dice retained on optimal reroll actions.')}${figure('15_decision_margins','Distribution of the expected-value gap between best and second-best actions.')}</section>
  <section id="s11"><h2>11. Policy comparisons</h2>${table(['Policy','Games','Mean','Loss vs optimal','Bonus','Yatzy'],policyRows)}${figure('10_policy_means','Mean score for the exact and comparison policies.')}${figure('11_policy_loss','Expected points lost relative to optimal full-game planning.')}</section>
  <section id="s12"><h2>12. Interesting positions and raw data</h2><p>The package contains a deterministic ranked set of strategically surprising positions, complete regular game traces, all 10 million compact game summaries, complete turn-boundary values and bounds, bonus-shadow values, decision aggregates, extreme-game indexes, and source data for every figure.</p>${table(['Dataset','Location'],[['Complete value table','exact_model/values.bin'],['Certified bounds','exact_model/bounds.bin'],['10m game summaries','simulations/optimal_*.bin'],['Trace sample','simulations/optimal_*.traces.jsonl'],['Turn-boundary states','analysis/turn_boundary_states.csv'],['Bonus shadow values','analysis/bonus_shadow_values.csv'],['Surprising positions','analysis/surprising_positions.json'],['Figure source tables','tables/csv/']])}</section>
  <section id="s13"><h2>13. Reproduction and provenance</h2><p>Every file in the complete package is covered by SHA-256 checksums. The package includes the frozen rule document, mathematical and platform specifications, source snapshot, dependency metadata, simulation seed manifest, exact commands, environment data, pipeline event history, and scripts for checksum and figure validation.</p><p class="note">This dossier intentionally does not write an abstract, discussion, novelty claim, or scientific conclusion. Those require human interpretation of this evidence and the historical literature.</p></section>
  </main></body></html>`;
  const dossier=path.join(runDir,'Yatzy_Research_Evidence_Dossier.html');writeTextAtomic(dossier,html);writeTextAtomic(path.join(runDir,'START_HERE.html'),html);return dossier;
}

function browserCandidates(){const c=[];if(process.platform==='win32'){for(const env of ['PROGRAMFILES','PROGRAMFILES(X86)','LOCALAPPDATA']){const root=process.env[env];if(!root)continue;c.push(path.join(root,'Google','Chrome','Application','chrome.exe'));c.push(path.join(root,'Microsoft','Edge','Application','msedge.exe'));}}else c.push('/usr/bin/chromium','/usr/bin/chromium-browser','/usr/bin/google-chrome');return c.filter(fs.existsSync);}
function simplePdf(file,title,lines){const content=[`BT /F1 20 Tf 50 780 Td (${title.replace(/[()\\]/g,'')}) Tj 0 -35 Td /F1 10 Tf`,...lines.map(x=>`(${String(x).replace(/[()\\]/g,'').slice(0,110)}) Tj 0 -16 Td`),'ET'].join('\n');const objs=[];objs.push('1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj');objs.push('2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj');objs.push('3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >> endobj');objs.push('4 0 obj << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> endobj');objs.push(`5 0 obj << /Length ${Buffer.byteLength(content)} >> stream\n${content}\nendstream endobj`);let pdf='%PDF-1.4\n',offsets=[0];for(const o of objs){offsets.push(Buffer.byteLength(pdf));pdf+=o+'\n';}const xref=Buffer.byteLength(pdf);pdf+=`xref\n0 ${objs.length+1}\n0000000000 65535 f \n`+offsets.slice(1).map(x=>`${String(x).padStart(10,'0')} 00000 n \n`).join('')+`trailer << /Size ${objs.length+1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;fs.writeFileSync(file,pdf);}

export const RENDERING_ISOLATION_ERROR_CODES=Object.freeze({
  input:'YATZY_RENDER_INPUT_INVALID',
  asset:'YATZY_RENDER_ASSET_INVALID',
  cleanup:'YATZY_RENDER_CLEANUP_FAILED'
});

export class RenderingIsolationError extends Error{
  constructor(code,message){super(message);this.name='RenderingIsolationError';this.code=code;}
}

function renderingFailure(code,message){throw new RenderingIsolationError(code,message);}
function containedPath(root,target){const relative=path.relative(root,target);return relative!==''&&!relative.startsWith(`..${path.sep}`)&&relative!=='..'&&!path.isAbsolute(relative);}
function passiveSvgData(asset){
  const stat=fs.lstatSync(asset);if(!stat.isFile()||stat.isSymbolicLink())renderingFailure(RENDERING_ISOLATION_ERROR_CODES.asset,'Rendering asset must be a regular unlinked file');
  const svg=fs.readFileSync(asset,'utf8');
  if(!/<svg\b/iu.test(svg)||/<\s*(?:script|foreignObject|iframe|object|embed|image|audio|video|link)\b/iu.test(svg)||/\b(?:href|xlink:href|src)\s*=/iu.test(svg)||/@import|url\s*\(/iu.test(svg))renderingFailure(RENDERING_ISOLATION_ERROR_CODES.asset,'Rendering asset is not passive standalone SVG');
  return `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;
}
function isolatedRenderHtml(dossierPath){
  const dossierStat=fs.lstatSync(dossierPath);if(!dossierStat.isFile()||dossierStat.isSymbolicLink())renderingFailure(RENDERING_ISOLATION_ERROR_CODES.input,'Rendering input must be a regular unlinked file');
  const sourceRoot=fs.realpathSync(path.dirname(dossierPath));let html=fs.readFileSync(dossierPath,'utf8');
  if(/<\s*(?:script|iframe|frame|object|embed|base|form|input|button|video|audio|source|track|link)\b/iu.test(html)||/<meta\b[^>]*http-equiv\s*=\s*["']?refresh/iu.test(html)||/\son[a-z]+\s*=/iu.test(html)||/@import|url\s*\(/iu.test(html))renderingFailure(RENDERING_ISOLATION_ERROR_CODES.input,'Rendering input contains active or external-resource-capable content');
  if(/\b(?:src|href|action|formaction|poster|data)\s*=\s*(?!["'])/iu.test(html))renderingFailure(RENDERING_ISOLATION_ERROR_CODES.input,'Rendering input contains an unquoted resource target');
  const resources=new Map();
  html=html.replace(/\b(src|href|action|formaction|poster|data)\s*=\s*(["'])(.*?)\2/giu,(match,name,quote,value)=>{
    if(name.toLowerCase()==='href'&&/^#[A-Za-z0-9_-]+$/u.test(value))return match;
    if(name.toLowerCase()!=='src'||!/^figures\/svg\/[A-Za-z0-9_-]+\.svg$/u.test(value))renderingFailure(RENDERING_ISOLATION_ERROR_CODES.input,'Rendering input contains an unexpected resource or navigation target');
    if(!resources.has(value)){
      const candidate=path.resolve(sourceRoot,...value.split('/'));let real,stat;
      try{stat=fs.lstatSync(candidate);}catch{renderingFailure(RENDERING_ISOLATION_ERROR_CODES.asset,'Declared rendering asset is missing');}
      if(!stat.isFile()||stat.isSymbolicLink())renderingFailure(RENDERING_ISOLATION_ERROR_CODES.asset,'Declared rendering asset must be a regular unlinked file');
      try{real=fs.realpathSync(candidate);}catch{renderingFailure(RENDERING_ISOLATION_ERROR_CODES.asset,'Declared rendering asset is missing');}
      if(!containedPath(sourceRoot,real))renderingFailure(RENDERING_ISOLATION_ERROR_CODES.asset,'Declared rendering asset escapes the dossier root');
      resources.set(value,passiveSvgData(real));
    }
    return `${name}=${quote}${resources.get(value)}${quote}`;
  });
  const csp="default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src 'none'; connect-src 'none'; media-src 'none'; object-src 'none'; frame-src 'none'; child-src 'none'; worker-src 'none'; manifest-src 'none'; base-uri 'none'; form-action 'none'";
  const policy=`<meta http-equiv="Content-Security-Policy" content="${csp}">`;
  html=/<head\b[^>]*>/iu.test(html)?html.replace(/<head\b[^>]*>/iu,match=>`${match}${policy}`):`${policy}${html}`;
  return{html,assets:[...resources.keys()].sort()};
}
function removeRenderWorkspace(workspace){
  try{fs.rmSync(workspace,{recursive:true,force:false});}
  catch{renderingFailure(RENDERING_ISOLATION_ERROR_CODES.cleanup,'Owned rendering workspace cleanup failed');}
}

export function renderDossierPdf(dossierPath,master,{runner=runControlledProcessSync,browsers=browserCandidates()}={}){
  const prepared=isolatedRenderHtml(dossierPath),destinationRoot=fs.realpathSync(path.dirname(dossierPath));
  const pdf=path.join(destinationRoot,'Yatzy_Research_Evidence_Dossier.pdf');
  for(const browser of browsers){
    const workspace=fs.mkdtempSync(path.join(destinationRoot,'.yatzy-render-'));
    try{
      const document=path.join(workspace,'dossier.html'),profile=path.join(workspace,'profile'),temporaryPdf=path.join(workspace,'output.pdf');
      fs.mkdirSync(profile);fs.writeFileSync(document,prepared.html,{flag:'wx'});
      const args=['--disable-extensions','--disable-background-networking','--no-first-run','--no-default-browser-check',`--user-data-dir=${profile}`,'--virtual-time-budget=5000','--headless','--disable-gpu',`--print-to-pdf=${temporaryPdf}`,'--no-pdf-header-footer',pathToFileURL(document).href];
      try{runner(browser,args,{cwd:workspace,timeoutMs:30000,maxOutputBytes:1024*1024,encoding:'utf8'});}
      catch(error){if(error instanceof ChildProcessPolicyError)continue;throw error;}
      if(fs.existsSync(temporaryPdf)&&fs.lstatSync(temporaryPdf).isFile()&&fs.statSync(temporaryPdf).size>1000){copyFileAtomic(temporaryPdf,pdf);return{pdf,browser,assets:prepared.assets};}
    }finally{removeRenderWorkspace(workspace);}
  }
  simplePdf(pdf,'Yatzy Research Evidence Dossier',[`Exact expected score: ${master.exact.midpoint}`,`Optimal simulations: ${master.simulation.totalGames}`,`Simulation mean: ${master.simulation.mean}`,`Bonus frequency: ${master.simulation.bonusFrequency}`,`Yatzy frequency: ${master.simulation.yatzyFrequency}`,'The complete interactive dossier is supplied as HTML in the same package.']);return{pdf,browser:null,fallback:true};
}

function relativeEntries(root,baseName){return listFilesRecursive(root).filter(f=>!f.endsWith('.zip')&&!f.includes(`${path.sep}.trace-batches${path.sep}`)&&!f.endsWith('.sqlite-wal')&&!f.endsWith('.sqlite-shm')).map(source=>({source,name:path.posix.join(baseName,path.relative(root,source).split(path.sep).join('/'))}));}
export async function buildResearchBundle({projectRoot,runDir,master,onProgress=()=>{},copyToDownloads=true,sourceCommit=null,archiveWriter=createZip,archiveVerifier=verifyZip}){
  const frozenCommit=sourceCommit??runControlledProcessSync('git',['rev-parse','HEAD'],{cwd:projectRoot,timeoutMs:30000,maxOutputBytes:1024*1024,encoding:'utf8'}).stdout.trim();
  const sourcePlan=createSourceSnapshotPlan({repositoryRoot:projectRoot,sourceCommit:frozenCommit});
  const ownership=claimOutputRoot(runDir);const exportDir=ensureOwnedDir(ownership,path.join(runDir,'export'));const bundlePath=path.join(exportDir,`Yatzy_Complete_Research_Package_${path.basename(runDir)}.zip`);
  const sourceResult=materializeSourceSnapshot({plan:sourcePlan,ownership,destination:path.join(exportDir,'source_snapshot'),manifestPath:path.join(exportDir,'source_snapshot_manifest.json'),purpose:'dossier-source-snapshot'});
  const reproductionDir=ensureDir(path.join(runDir,'reproduction'));writeTextAtomic(path.join(reproductionDir,'README.md'),'# Reproduction\n\nRun `npm test`, verify `checksums.sha256`, and use the included source snapshot and seed manifest to reproduce calculations. The canonical model is identified by its rules and artifact hashes.\n');writeTextAtomic(path.join(reproductionDir,'verify_checksums.ps1'),`$ErrorActionPreference='Stop'\nGet-Content checksums.sha256 | ForEach-Object { $p=$_.Substring(66); $expected=$_.Substring(0,64); $actual=(Get-FileHash -Algorithm SHA256 $p).Hash.ToLower(); if($actual -ne $expected){throw "Mismatch: $p"} }\nWrite-Host 'All checksums passed.'\n`);
  const entries=[];for(const f of ['START_HERE.html','Yatzy_Research_Evidence_Dossier.html','Yatzy_Research_Evidence_Dossier.pdf','master_results.json','master_results.csv','verification.json','manifest.json','precomputation_metrics.json']){const source=path.join(runDir,f);if(fs.existsSync(source))entries.push({source,name:f});}
  for(const dir of ['analysis','figures','tables','simulations','reproduction','provenance']){const root=path.join(runDir,dir);if(fs.existsSync(root))entries.push(...relativeEntries(root,dir));}
  for(const f of ['values.bin','bounds.bin']){const source=path.join(runDir,f);if(fs.existsSync(source))entries.push({source,name:`exact_model/${f}`});}
  for(const item of sourceResult.manifest.entries)entries.push({source:path.join(sourceResult.destination,...item.path.split('/')),name:`source_snapshot/${item.path}`});
  entries.push({source:sourceResult.manifestPath,name:'generated/source_snapshot_manifest.json'});
  const checksumLines=[];let done=0;for(const e of entries){checksumLines.push(`${await sha256File(e.source)}  ${e.name}`);done++;onProgress({phase:'checksums',progress:done/entries.length*.15});}const checksumFile=path.join(exportDir,'checksums.sha256');writeTextAtomic(checksumFile,checksumLines.join('\n')+'\n');entries.unshift({source:checksumFile,name:'checksums.sha256'});
  const result=await archiveWriter(bundlePath,entries,p=>onProgress({phase:'zip',progress:.15+p.progress*.8,file:p.file}));const audit=archiveVerifier(bundlePath,['START_HERE.html','master_results.json','checksums.sha256','exact_model/values.bin']);if(!audit.passed)throw new Error(`Bundle audit failed: ${JSON.stringify(audit)}`);const hash=await sha256File(bundlePath);const bundleManifest={...result,sha256:hash,audit,createdAt:new Date().toISOString()};writeJsonAtomic(path.join(exportDir,'bundle_manifest.json'),bundleManifest);
  let downloadsCopy=null;if(copyToDownloads){const dstDir=ensureDir(path.join(os.homedir(),'Downloads','Yatzy Research'));downloadsCopy=path.join(dstDir,path.basename(bundlePath));copyFileAtomic(bundlePath,downloadsCopy);}
  onProgress({phase:'complete',progress:1});return{bundlePath,downloadsCopy,bundleManifest};}
