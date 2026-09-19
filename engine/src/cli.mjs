import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PipelineManager, PUBLIC_SMOKE_PROFILE_ID } from './pipeline/manager.mjs';
import { runPreflight } from './pipeline/preflight.mjs';
import { verifyZip } from './util/zip.mjs';
const projectRoot=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..','..');const command=process.argv[2]||'smoke';const manager=new PipelineManager(projectRoot);
if(command==='preflight'){const tmp=path.join(projectRoot,'data','preflight');fs.mkdirSync(tmp,{recursive:true});const r=runPreflight({projectRoot,runDir:tmp,rulesHash:manager.rulesHash});for(const c of r.checks)console.log(`${c.passed?'PASSED':'FAILED'}  ${c.id}`);if(!r.passed)process.exitCode=1;}
else if(command==='smoke'){const result=manager.runPublicSmoke();console.log(`Selected profile: ${PUBLIC_SMOKE_PROFILE_ID}`);for(const c of result.preflight.checks)console.log(`${c.passed?'PASSED':'FAILED'}  ${c.id}`);console.log(`Reference one-category Yatzy turn value: ${result.referenceValue.toFixed(12)}`);if(!result.preflight.passed)process.exitCode=1;}
else if(command==='pipeline'){const error=new Error('The generic complete-pipeline route is disabled for public safety. Use the bounded smoke default, or explicitly select the registered full profile with its output-root and acknowledgement flags.');error.code='YATZY_UNSAFE_LEGACY_ROUTE_DISABLED';throw error;}
else if(command==='verify-bundle'){const file=process.argv[3];if(!file)throw new Error('Provide a ZIP path');console.log(verifyZip(file));}
else console.log('Commands: smoke (default), preflight, verify-bundle <zip>');
