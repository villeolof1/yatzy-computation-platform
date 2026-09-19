import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  renderDossierPdf,
  RenderingIsolationError,
  RENDERING_ISOLATION_ERROR_CODES
} from '../src/analysis/dossier.mjs';
import {
  CHILD_PROCESS_ERROR_CODES,
  ChildProcessPolicyError
} from '../src/util/child-process.mjs';

const master={exact:{midpoint:1},simulation:{totalGames:1,mean:1,bonusFrequency:0,yatzyFrequency:0}};
function fixture(t,{html='<!doctype html><html><head><title>fixture</title><style>body{color:#123}</style></head><body><a href="#ok">ok</a><img src="figures/svg/chart.svg"><section id="ok">done</section></body></html>',svg='<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"><rect width="20" height="20" fill="#176b87"/></svg>'}={}){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'yatzy-rendering-test-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const figures=path.join(root,'figures','svg');fs.mkdirSync(figures,{recursive:true});
  const dossier=path.join(root,'dossier.html');fs.writeFileSync(dossier,html);fs.writeFileSync(path.join(figures,'chart.svg'),svg);
  return{root,dossier,asset:path.join(figures,'chart.svg'),pdf:path.join(root,'Yatzy_Research_Evidence_Dossier.pdf')};
}
function renderDirectories(root){return fs.readdirSync(root).filter(name=>name.startsWith('.yatzy-render-'));}

test('isolated renderer stages only one passive document, owned profile and temporary output',t=>{
  const value=fixture(t),calls=[];
  const browser=path.join(value.root,'Browser With Spaces.exe');
  const result=renderDossierPdf(value.dossier,master,{browsers:[browser],runner(executable,args,options){
    calls.push({executable,args,options});
    assert.equal(options.cwd.startsWith(value.root),true);
    assert.deepEqual(fs.readdirSync(options.cwd).sort(),['dossier.html','profile']);
    const staged=fs.readFileSync(path.join(options.cwd,'dossier.html'),'utf8');
    assert.match(staged,/Content-Security-Policy/u);assert.match(staged,/img-src data:/u);assert.match(staged,/src="data:image\/svg\+xml;base64,/u);
    assert.doesNotMatch(staged,/figures\/svg\/chart\.svg/u);assert.doesNotMatch(staged,new RegExp(value.root.replace(/[.*+?^${}()|[\]\\]/g,'\\$&'),'u'));
    assert.equal(fs.readdirSync(path.join(options.cwd,'profile')).length,0);
    const output=args.find(argument=>argument.startsWith('--print-to-pdf=')).slice('--print-to-pdf='.length);
    assert.equal(path.dirname(output),options.cwd);fs.writeFileSync(output,Buffer.alloc(1200,1));
    return{status:0,signal:null,stdout:'',stderr:''};
  }});
  assert.equal(result.browser,browser);assert.deepEqual(result.assets,['figures/svg/chart.svg']);assert.equal(fs.statSync(value.pdf).size,1200);
  assert.equal(calls.length,1);assert.equal(renderDirectories(value.root).length,0);
});

test('browser arguments retain sandboxing, remove broad file access and own browser state',t=>{
  const value=fixture(t);let captured;
  renderDossierPdf(value.dossier,master,{browsers:[path.join(value.root,'browser.exe')],runner(executable,args,options){captured={args,options};const output=args.find(argument=>argument.startsWith('--print-to-pdf=')).slice(15);fs.writeFileSync(output,Buffer.alloc(1200));return{status:0,signal:null,stdout:'',stderr:''};}});
  assert.equal(captured.args.includes('--no-sandbox'),false);assert.equal(captured.args.includes('--allow-file-access-from-files'),false);
  assert.equal(captured.args.includes('--disable-background-networking'),true);assert.equal(captured.args.includes('--disable-extensions'),true);
  const profile=captured.args.find(argument=>argument.startsWith('--user-data-dir=')).slice('--user-data-dir='.length);assert.equal(path.dirname(profile),captured.options.cwd);
  const navigation=captured.args.at(-1);assert.match(navigation,/^file:\/\//u);assert.equal(navigation.includes(value.dossier.replaceAll('\\','/')),false);assert.equal(renderDirectories(value.root).length,0);
});

test('out-of-root sentinel target is rejected before browser invocation',t=>{
  const value=fixture(t,{html:'<!doctype html><img src="../sentinel.svg">'}),sentinel=path.join(path.dirname(value.root),'sentinel.svg');fs.writeFileSync(sentinel,'harmless sentinel');t.after(()=>{try{fs.rmSync(sentinel);}catch{}});
  let called=false;assert.throws(()=>renderDossierPdf(value.dossier,master,{browsers:['browser'],runner(){called=true;}}),error=>error instanceof RenderingIsolationError&&error.code===RENDERING_ISOLATION_ERROR_CODES.input);
  assert.equal(called,false);assert.equal(fs.readFileSync(sentinel,'utf8'),'harmless sentinel');assert.equal(renderDirectories(value.root).length,0);
});

test('external network and file URL targets are rejected before browser invocation',t=>{
  for(const target of ['https://example.invalid/a.svg','file:///outside/sentinel.svg','//example.invalid/a.svg']){
    const value=fixture(t,{html:`<!doctype html><img src="${target}">`});let called=false;
    assert.throws(()=>renderDossierPdf(value.dossier,master,{browsers:['browser'],runner(){called=true;}}),error=>error instanceof RenderingIsolationError&&error.code===RENDERING_ISOLATION_ERROR_CODES.input);assert.equal(called,false);
  }
});

test('active HTML, meta refresh, event handlers and CSS resource URLs are rejected',t=>{
  const documents=['<!doctype html><script>1</script>','<!doctype html><meta http-equiv="refresh" content="0;url=file:///x">','<!doctype html><p onclick="x()">x</p>','<!doctype html><style>p{background:url(file:///x)}</style>'];
  for(const html of documents){const value=fixture(t,{html});assert.throws(()=>renderDossierPdf(value.dossier,master,{browsers:[]}),error=>error instanceof RenderingIsolationError&&error.code===RENDERING_ISOLATION_ERROR_CODES.input);}
});

test('SVG assets with active or external-resource-capable content are rejected',t=>{
  for(const svg of ['<svg xmlns="http://www.w3.org/2000/svg"><script>1</script></svg>','<svg xmlns="http://www.w3.org/2000/svg"><image href="file:///x"/></svg>','<svg xmlns="http://www.w3.org/2000/svg"><style>rect{fill:url(https://example.invalid/x)}</style></svg>']){
    const value=fixture(t,{svg});assert.throws(()=>renderDossierPdf(value.dossier,master,{browsers:[]}),error=>error instanceof RenderingIsolationError&&error.code===RENDERING_ISOLATION_ERROR_CODES.asset);
  }
});

test('linked declared assets are rejected where file symlinks are supported',t=>{
  const value=fixture(t),target=path.join(value.root,'target.svg');fs.writeFileSync(target,'<svg xmlns="http://www.w3.org/2000/svg"/>');fs.rmSync(value.asset);
  try{fs.symlinkSync(target,value.asset,'file');}catch(error){if(error?.code==='EPERM'||error?.code==='EACCES')return;throw error;}
  assert.throws(()=>renderDossierPdf(value.dossier,master,{browsers:[]}),error=>error instanceof RenderingIsolationError&&error.code===RENDERING_ISOLATION_ERROR_CODES.asset);
});

test('controlled browser failure preserves fallback and removes every owned workspace',t=>{
  const value=fixture(t);let attempts=0;
  const result=renderDossierPdf(value.dossier,master,{browsers:['first','second'],runner(){attempts+=1;throw new ChildProcessPolicyError(CHILD_PROCESS_ERROR_CODES.nonzero,'failed');}});
  assert.equal(attempts,2);assert.equal(result.fallback,true);assert.equal(result.browser,null);assert.match(fs.readFileSync(value.pdf,'utf8'),/^%PDF-1\.4/u);assert.equal(renderDirectories(value.root).length,0);
});

test('timeout-classified browser failure cleans owned profile, document and output',t=>{
  const value=fixture(t);
  const result=renderDossierPdf(value.dossier,master,{browsers:['browser'],runner(executable,args){const output=args.find(argument=>argument.startsWith('--print-to-pdf=')).slice(15);fs.writeFileSync(output,Buffer.alloc(1200));throw new ChildProcessPolicyError(CHILD_PROCESS_ERROR_CODES.timeout,'timed out');}});
  assert.equal(result.fallback,true);assert.equal(renderDirectories(value.root).length,0);assert.match(fs.readFileSync(value.pdf,'utf8'),/^%PDF-1\.4/u);
});

test('unexpected runner failure is propagated after deterministic cleanup',t=>{
  const value=fixture(t),failure=new Error('unexpected');
  assert.throws(()=>renderDossierPdf(value.dossier,master,{browsers:['browser'],runner(){throw failure;}}),error=>error===failure);assert.equal(renderDirectories(value.root).length,0);assert.equal(fs.existsSync(value.pdf),false);
});

test('browser output cannot select or escape the approved PDF destination',t=>{
  const value=fixture(t),outside=path.join(path.dirname(value.root),'outside.pdf');t.after(()=>{try{fs.rmSync(outside);}catch{}});
  renderDossierPdf(value.dossier,master,{browsers:['browser'],runner(executable,args,options){const output=args.find(argument=>argument.startsWith('--print-to-pdf=')).slice(15);assert.equal(path.dirname(output),options.cwd);assert.notEqual(output,outside);fs.writeFileSync(output,Buffer.alloc(1200));return{status:0,signal:null,stdout:'',stderr:''};}});
  assert.equal(fs.existsSync(outside),false);assert.equal(fs.existsSync(value.pdf),true);assert.equal(renderDirectories(value.root).length,0);
});

test('bounded live browser renders declared local SVG without retained temp state',t=>{
  if(process.env.YATZY_LIVE_RENDER_TEST!=='1')return;
  const browser=process.env.YATZY_LIVE_BROWSER;assert.ok(browser&&path.isAbsolute(browser)&&fs.existsSync(browser));
  const value=fixture(t);const result=renderDossierPdf(value.dossier,master,{browsers:[browser]});
  assert.equal(result.browser,browser);const bytes=fs.readFileSync(value.pdf);assert.equal(bytes.subarray(0,5).toString('ascii'),'%PDF-');assert.ok(bytes.length>1000);assert.equal(renderDirectories(value.root).length,0);
});
