import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PipelineManager, PUBLIC_SMOKE_PROFILE_ID } from '../pipeline/manager.mjs';
import { runV3Pipeline } from './official-pipeline.mjs';
import { buildPublicSourcePackage, verifyPublicSourcePackage } from './source-snapshot.mjs';

function invalidArguments(message) {
  const error = new Error(message);
  error.code = 'YATZY_CLI_INVALID_ARGUMENT';
  return error;
}

function parseArguments(argv) {
  const args = [...argv];
  const command = args[0] && !args[0].startsWith('--') ? args.shift() : 'smoke';
  let outputRoot;
  let acknowledgeFullResearch = false;
  while (args.length) {
    const argument = args.shift();
    if (argument === '--output-root') {
      if (outputRoot !== undefined || !args.length || args[0].startsWith('--')) throw invalidArguments('--output-root requires one value and may appear only once.');
      outputRoot = args.shift();
    } else if (argument === '--acknowledge-full-research') {
      if (acknowledgeFullResearch) throw invalidArguments('--acknowledge-full-research may appear only once.');
      acknowledgeFullResearch = true;
    } else {
      throw invalidArguments(`Unknown argument: ${argument}`);
    }
  }
  return { command, outputRoot, acknowledgeFullResearch };
}

const { command, outputRoot: explicitOutputRoot, acknowledgeFullResearch } = parseArguments(process.argv.slice(2));
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

if (command === 'audit') throw new Error('Use an archived run FINAL_AUDIT.json for immutable audit results.');

if (command === 'smoke') {
  if (explicitOutputRoot !== undefined || acknowledgeFullResearch) throw invalidArguments('The bounded smoke profile accepts no output-root or full-research acknowledgement arguments.');
  const result = new PipelineManager(projectRoot).runPublicSmoke();
  console.log(`Selected profile: ${PUBLIC_SMOKE_PROFILE_ID}`);
  for (const check of result.preflight.checks) console.log(`${check.passed ? 'PASSED' : 'FAILED'}  ${check.id}`);
  console.log(`Reference one-category Yatzy turn value: ${result.referenceValue.toFixed(12)}`);
  if (!result.preflight.passed) process.exitCode = 1;
} else if (command === 'verify-public-package') {
  if (explicitOutputRoot !== undefined || acknowledgeFullResearch) throw invalidArguments('verify-public-package accepts no output-root or acknowledgement arguments.');
  const result = verifyPublicSourcePackage(projectRoot);
  console.log(JSON.stringify({
    packagedSourceSha256: result.packagedSourceSha256,
    packageManifestSha256: result.packageManifestSha256,
    publicProvenanceSha256: result.publicProvenanceSha256,
    payloadFileCount: result.payloadFileCount,
    payloadByteLength: result.payloadByteLength
  }, null, 2));
} else if (command === 'public-package') {
  if (acknowledgeFullResearch) throw invalidArguments('public-package does not accept the full-research acknowledgement flag.');
  const outputRoot = explicitOutputRoot ?? process.env.YATZY_OUTPUT_ROOT;
  if (typeof outputRoot !== 'string' || !outputRoot.trim()) {
    const error = new Error('Filesystem output root must be supplied explicitly with --output-root or YATZY_OUTPUT_ROOT.');
    error.code = 'YATZY_FS_INVALID_PATH';
    throw error;
  }
  const result = buildPublicSourcePackage({ sourceRoot: projectRoot, outputRoot });
  console.log(JSON.stringify({
    packagedSourceSha256: result.packagedSourceSha256,
    packageManifestSha256: result.packageManifestSha256,
    publicProvenanceSha256: result.publicProvenanceSha256,
    payloadFileCount: result.payloadFileCount,
    payloadByteLength: result.payloadByteLength
  }, null, 2));
} else {
  if (!['reduced', 'official'].includes(command)) throw invalidArguments(`Unknown profile command: ${command}`);
  if (command === 'official' && !acknowledgeFullResearch) {
    const error = new Error('Registered full research requires the exact --acknowledge-full-research flag.');
    error.code = 'YATZY_FULL_RESEARCH_ACK_REQUIRED';
    throw error;
  }
  if (command !== 'official' && acknowledgeFullResearch) throw invalidArguments('The full-research acknowledgement flag is valid only with explicit official selection.');
  const outputRoot = command === 'official' ? explicitOutputRoot : explicitOutputRoot ?? process.env.YATZY_OUTPUT_ROOT;
  if (typeof outputRoot !== 'string' || !outputRoot.trim()) {
    const error = new Error(command === 'official'
      ? 'Registered full research requires an explicit --output-root <owned-path>.'
      : 'Filesystem output root must be supplied explicitly with --output-root or YATZY_OUTPUT_ROOT.');
    error.code = 'YATZY_FS_INVALID_PATH';
    throw error;
  }
  const result = await runV3Pipeline({ mode: command, outputRoot, acknowledgeFullResearch });
  console.log(JSON.stringify({ runId: result.runId, runDir: result.runDir, archives: result.archives, canonicalIdentityIntact: true }, null, 2));
}
