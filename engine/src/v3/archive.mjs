import fs from 'node:fs';
import path from 'node:path';
import { ensureDir, writeJsonAtomic, listFilesRecursive } from '../util/fs.mjs';
import { ChildProcessPolicyError, runControlledProcessSync } from '../util/child-process.mjs';
import { auditZip as auditSharedZip, listZip as listSharedZip } from '../util/zip.mjs';
import { verifyResearchSources } from './source-snapshot.mjs';

const sharedArchiveModule = new URL('../util/zip.mjs', import.meta.url).href;
const sharedOperationScript = `
const moduleUrl = process.argv[1];
const request = JSON.parse(process.argv[2]);
try {
  const archive = await import(moduleUrl);
  const result = await archive[request.operation](...request.args);
  process.stdout.write(JSON.stringify({ ok: true, result }));
} catch (error) {
  process.stdout.write(JSON.stringify({ ok: false, code: error?.code ?? 'YATZY_ARCHIVE_OPERATION_FAILED', message: error?.message ?? 'Archive operation failed' }));
}`;

function run(command, args, cwd, { timeoutMs = 5 * 60_000, maxOutputBytes = 64 * 1024 * 1024 } = {}) {
  return runControlledProcessSync(command, args, { cwd, timeoutMs, maxOutputBytes, encoding: 'utf8' }).stdout;
}

function runSharedOperation(operation, args, cwd, timeoutMs = 30 * 60_000) {
  const stdout = run(process.execPath, ['--input-type=module', '-e', sharedOperationScript, sharedArchiveModule, JSON.stringify({ operation, args })], cwd, { timeoutMs, maxOutputBytes: 4 * 1024 * 1024 });
  let response;
  try { response = JSON.parse(stdout); } catch { throw new Error('Shared archive operation returned an invalid result'); }
  if (!response?.ok) {
    const error = new Error(response?.message ?? 'Shared archive operation failed');
    error.code = response?.code ?? 'YATZY_ARCHIVE_OPERATION_FAILED';
    throw error;
  }
  return response.result;
}

export function createZip(sourceDir, outputFile) {
  runSharedOperation('createZipFromDirectory', [sourceDir, outputFile, { compression: 'deflate' }], path.resolve(process.cwd()));
  return outputFile;
}

export function listZip(file) {
  const entries = listSharedZip(file);
  if (!entries.length) throw new Error('Archive contains no entries');
  return entries;
}

export async function auditZip(file, required = []) {
  return auditSharedZip(file, required);
}

export function buildPaperStaging(runDir, staging, { sourcePlan } = {}) {
  verifyResearchSources({
    plan: sourcePlan,
    destination: path.join(runDir, 'research', 'sources'),
    manifestPath: path.join(runDir, 'research', 'source_snapshot_manifest.json'),
    purpose: 'research-source-staging'
  });
  fs.rmSync(staging, { recursive: true, force: true }); ensureDir(staging);
  const include = ['master_results.json', 'master_results.csv', 'experiments.json', 'verification.json', 'final_provenance.json', 'canonical_identity.json', 'historical_identity.json', 'limitations_and_scope.json', 'claim_to_evidence_register.json'];
  for (const name of include) { const src = path.join(runDir, name); if (fs.existsSync(src)) fs.copyFileSync(src, path.join(staging, name)); }
  for (const dir of ['analysis', 'tables', 'figures', 'schemas', 'data-dictionary', 'decision', 'structural', 'estimands', 'paired', 'historical', 'research']) { const src = path.join(runDir, dir); if (fs.existsSync(src)) fs.cpSync(src, path.join(staging, dir), { recursive: true }); }
  return listFilesRecursive(staging).length;
}

export function cleanRoomTest(fullArchive, cleanDir) {
  runSharedOperation('extractZip', [fullArchive, cleanDir, { prefix: 'source_snapshot/' }], path.resolve(path.dirname(fullArchive)));
  const source = path.join(cleanDir, 'source_snapshot'), tests = fs.readdirSync(path.join(source, 'engine', 'test')).filter(name => name.endsWith('.test.mjs')).sort().map(name => path.join('engine', 'test', name));
  let result;
  try {
    result = runControlledProcessSync(process.execPath, ['--test', ...tests], {
      cwd: source,
      timeoutMs: 10 * 60_000,
      maxOutputBytes: 32 * 1024 * 1024,
      encoding: 'utf8'
    });
  } catch (error) {
    if (!(error instanceof ChildProcessPolicyError)) throw error;
    const report = {
      command: `${process.execPath} --test ${tests.join(' ')}`,
      exitCode: error.exitCode ?? null,
      passed: false,
      stdout: error.stdoutExcerpt,
      stderr: error.stderrExcerpt,
      errorCode: error.code
    };
    writeJsonAtomic(path.join(cleanDir, 'clean_room_report.json'), report);
    throw new Error('Clean-room source tests failed', { cause: error });
  }
  const report = { command: `${process.execPath} --test ${tests.join(' ')}`, exitCode: result.status, passed: true, stdout: result.stdout, stderr: result.stderr };
  writeJsonAtomic(path.join(cleanDir, 'clean_room_report.json'), report);
  return report;
}
