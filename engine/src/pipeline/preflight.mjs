import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { staticChecks } from '../solver/verify.mjs';

export const PUBLIC_ENVIRONMENT_FIELDS=Object.freeze(['nodeVersion','osFamily','architecture','logicalCoreCount']);

const PUBLIC_OS_FAMILIES=new Set(['windows','linux','macos','aix','freebsd','openbsd','sunos']);
const PUBLIC_PROVENANCE_IDENTITIES=new WeakSet();

function publicProvenanceFailure(message){
  const error=new Error(`Public provenance ${message}`);
  error.code='YATZY_PUBLIC_PROVENANCE_INVALID';
  return error;
}

function requirePlainObject(value,label){
  if(value===null||typeof value!=='object'||Array.isArray(value)||Object.getPrototypeOf(value)!==Object.prototype)throw publicProvenanceFailure(`${label} must be a plain object.`);
  return value;
}

function requireExactKeys(value,keys,label){
  const actual=Object.keys(requirePlainObject(value,label));
  if(actual.length!==keys.length||actual.some((key,index)=>key!==keys[index]))throw publicProvenanceFailure(`${label} fields are not exactly allowlisted.`);
}

function requireSha256(value,label){
  if(typeof value!=='string'||!/^[0-9a-f]{64}$/u.test(value))throw publicProvenanceFailure(`${label} must be a lowercase SHA-256 identity.`);
  return value;
}

function publicOsFamily(platform){
  if(platform==='win32')return'windows';
  if(platform==='darwin')return'macos';
  return platform;
}

export function collectPrivateOperationalEnvironment({freeMemory=os.freemem()}={}){
  return{node:process.version,platform:process.platform,arch:process.arch,cpu:os.cpus()[0]?.model,logicalCores:os.cpus().length,totalMemory:os.totalmem(),freeMemory,hostname:os.hostname()};
}

export function normalizePublicEnvironment(value){
  requireExactKeys(value,PUBLIC_ENVIRONMENT_FIELDS,'environment');
  const{nodeVersion,osFamily,architecture,logicalCoreCount}=value;
  if(typeof nodeVersion!=='string'||!/^v\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/u.test(nodeVersion))throw publicProvenanceFailure('nodeVersion is invalid.');
  if(typeof osFamily!=='string'||!PUBLIC_OS_FAMILIES.has(osFamily))throw publicProvenanceFailure('osFamily is invalid.');
  if(typeof architecture!=='string'||!/^[a-z0-9][a-z0-9_-]{0,31}$/u.test(architecture))throw publicProvenanceFailure('architecture is invalid.');
  if(!Number.isSafeInteger(logicalCoreCount)||logicalCoreCount<1||logicalCoreCount>4096)throw publicProvenanceFailure('logicalCoreCount is invalid.');
  return Object.freeze({nodeVersion,osFamily,architecture,logicalCoreCount});
}

export function collectPublicEnvironment(){
  return normalizePublicEnvironment({nodeVersion:process.version,osFamily:publicOsFamily(process.platform),architecture:process.arch,logicalCoreCount:os.availableParallelism()});
}

export function createPublicProvenance({packagedSourceSha256,packageManifestSha256,payloadFileCount,payloadByteLength,canonicalRulesSha256,registeredProfileSha256,rightsPolicySha256,environment}){
  if(!Number.isSafeInteger(payloadFileCount)||payloadFileCount<1)throw publicProvenanceFailure('payloadFileCount is invalid.');
  if(!Number.isSafeInteger(payloadByteLength)||payloadByteLength<0)throw publicProvenanceFailure('payloadByteLength is invalid.');
  const report={
    schemaVersion:'yatzy-public-provenance-v1',
    classification:'PUBLIC_ALLOWLISTED_ENVIRONMENT',
    packagedSource:{
      sha256:requireSha256(packagedSourceSha256,'packagedSourceSha256'),
      manifestSha256:requireSha256(packageManifestSha256,'packageManifestSha256'),
      payloadFileCount,
      payloadByteLength
    },
    scientificIdentities:{
      canonicalRulesSha256:requireSha256(canonicalRulesSha256,'canonicalRulesSha256'),
      registeredProfileSha256:requireSha256(registeredProfileSha256,'registeredProfileSha256')
    },
    rightsBoundary:{
      policySha256:requireSha256(rightsPolicySha256,'rightsPolicySha256'),
      historicalJavaPathCount:27,
      retainedNotice:'research/sources/optimalt-yatzy-source/LICENSE',
      excludedPaths:[
        'research/sources/Alga_Yatzy_rules_manual.pdf',
        'research/sources/KTH_2012_optimal_yatzy.pdf',
        'scripts/install-node-autostart.ps1',
        'scripts/uninstall-node-autostart.ps1'
      ]
    },
    environment:normalizePublicEnvironment(environment)
  };
  Object.freeze(report.packagedSource);Object.freeze(report.scientificIdentities);Object.freeze(report.rightsBoundary.excludedPaths);Object.freeze(report.rightsBoundary);Object.freeze(report);
  PUBLIC_PROVENANCE_IDENTITIES.add(report);
  return report;
}

export function serializePublicProvenance(report){
  if(!report||!PUBLIC_PROVENANCE_IDENTITIES.has(report))throw publicProvenanceFailure('serialization requires a validated public provenance object.');
  return`${JSON.stringify(report,null,2)}\n`;
}

export function runPreflight({projectRoot,runDir,rulesHash}){
  const checks=staticChecks();const add=(id,category,required,passed,details={})=>checks.push({id,category,required,passed,details});
  const [major,minor]=process.versions.node.split('.').map(Number);add('runtime.node_version','Environment',true,major>22||(major===22&&minor>=5),{actual:process.version,required:'v22.5.0+'});
  add('runtime.rules_hash','Identity',true,/^[0-9a-f]{64}$/.test(rulesHash),{rulesHash});
  try{fs.accessSync(runDir,fs.constants.W_OK);add('storage.run_directory_writable','Storage',true,true,{runDir});}catch(e){add('storage.run_directory_writable','Storage',true,false,{error:e.message});}
  const free=os.freemem();add('runtime.memory_available','Environment',true,free>512*1024*1024,{freeBytes:free});
  const requiredFiles=['package.json','rules/swedish-alga-free-order-v1.json','engine/src/server.mjs'];for(const f of requiredFiles)add(`source.${f.replaceAll('/','.')}`,'Source',true,fs.existsSync(path.join(projectRoot,f)),{path:f});
  return{passed:checks.filter(x=>x.required).every(x=>x.passed),checks,environment:collectPrivateOperationalEnvironment({freeMemory:free})};
}
