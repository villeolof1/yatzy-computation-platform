import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { TextDecoder } from 'node:util';
import { fileURLToPath } from 'node:url';
import {
  copyFileAtomicOwned,
  createOwnedTempDir,
  ensureOwnedDir,
  promoteOwnedPath,
  removeOwnedPath,
  writeJsonAtomicOwned,
  writeTextAtomicOwned
} from '../util/fs.mjs';
import { runControlledProcessSync } from '../util/child-process.mjs';
import { stableJson } from '../util/hash.mjs';
import {
  collectPublicEnvironment,
  createPublicProvenance,
  normalizePublicEnvironment,
  serializePublicProvenance
} from '../pipeline/preflight.mjs';
import { assertOwnedPath, claimOutputRoot, relativePosix, resolveWithin } from './paths.mjs';

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const POLICY_FILE = path.join(MODULE_DIR, 'public-source-policy.json');
const UTF8_FATAL = new TextDecoder('utf-8', { fatal: true });
const PLAN_IDENTITIES = new WeakSet();
const REGULAR_MODES = new Set(['100644', '100755']);
const RESEARCH_ROOT = 'research/sources';
const WINDOWS_INVALID_CHARACTERS = /[<>:"|?*]/u;
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

function sourceFailure(code, message) {
  const error = new Error(`Source snapshot ${message}`);
  error.code = code;
  return error;
}

function plainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const nested of Object.values(value)) deepFreeze(nested);
    Object.freeze(value);
  }
  return value;
}

function compareUtf8(a, b) {
  return Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}

export const PUBLIC_PACKAGE_PAYLOAD_PATHS=Object.freeze([
  '.gitattributes',
  'CHANGELOG.md',
  'CITATION.cff',
  'LICENSE',
  'REPRODUCIBILITY.md',
  'THIRD_PARTY_NOTICES.md',
  'data/.gitkeep',
  'docs/ANALYSIS_AND_RESEARCH_PLAN.md',
  'docs/IMPLEMENTATION_VALIDATION.md',
  'docs/NUMERICAL_ERROR_BOUND.md',
  'docs/SIMULATION_RNG_CORRECTION.md',
  'docs/yatzy_24863_investigation.md',
  'docs/yatzy_solver_specification.md',
  'engine/src/analysis/analyze.mjs',
  'engine/src/analysis/charts.mjs',
  'engine/src/analysis/dossier.mjs',
  'engine/src/analysis/png.mjs',
  'engine/src/cli.mjs',
  'engine/src/database.mjs',
  'engine/src/pipeline/manager.mjs',
  'engine/src/pipeline/preflight.mjs',
  'engine/src/server.mjs',
  'engine/src/solver/dice.mjs',
  'engine/src/solver/policies.mjs',
  'engine/src/solver/policy-format.mjs',
  'engine/src/solver/precompute-worker.mjs',
  'engine/src/solver/precompute.mjs',
  'engine/src/solver/query.mjs',
  'engine/src/solver/reference.mjs',
  'engine/src/solver/rng.mjs',
  'engine/src/solver/scoring.mjs',
  'engine/src/solver/simulation-worker.mjs',
  'engine/src/solver/simulation.mjs',
  'engine/src/solver/state-index.mjs',
  'engine/src/solver/table-format.mjs',
  'engine/src/solver/verify.mjs',
  'engine/src/util/child-process.mjs',
  'engine/src/util/csv.mjs',
  'engine/src/util/float.mjs',
  'engine/src/util/fs.mjs',
  'engine/src/util/hash.mjs',
  'engine/src/util/statistics.mjs',
  'engine/src/util/zip.mjs',
  'engine/src/v3/action-values.mjs',
  'engine/src/v3/archive.mjs',
  'engine/src/v3/cli.mjs',
  'engine/src/v3/corrected-figures.mjs',
  'engine/src/v3/counter-rng.mjs',
  'engine/src/v3/estimands.mjs',
  'engine/src/v3/experiment-manifest.mjs',
  'engine/src/v3/format-audit.mjs',
  'engine/src/v3/game-simulator.mjs',
  'engine/src/v3/identity.mjs',
  'engine/src/v3/official-pipeline.mjs',
  'engine/src/v3/paired-comparison.mjs',
  'engine/src/v3/paths.mjs',
  'engine/src/v3/policy-audit.mjs',
  'engine/src/v3/provenance.mjs',
  'engine/src/v3/public-source-policy.json',
  'engine/src/v3/quality-gates.mjs',
  'engine/src/v3/schemas.mjs',
  'engine/src/v3/source-snapshot.mjs',
  'engine/src/v3/structural-atlas.mjs',
  'engine/src/v3/visit-analysis.mjs',
  'engine/test/child-process-policy.test.mjs',
  'engine/test/config-profiles.test.mjs',
  'engine/test/core.test.mjs',
  'engine/test/database.test.mjs',
  'engine/test/determinism-counter.test.mjs',
  'engine/test/fault-archive.test.mjs',
  'engine/test/fixtures/bounded-public-profile.json',
  'engine/test/fixtures/registered-full-profile.json',
  'engine/test/float.test.mjs',
  'engine/test/fs-atomic.test.mjs',
  'engine/test/mutation-gates.test.mjs',
  'engine/test/preflight.test.mjs',
  'engine/test/public-provenance.test.mjs',
  'engine/test/reference.test.mjs',
  'engine/test/rendering-isolation.test.mjs',
  'engine/test/reparse-containment.test.mjs',
  'engine/test/rng-seeding.test.mjs',
  'engine/test/server-security.test.mjs',
  'engine/test/source-snapshot.test.mjs',
  'engine/test/v3-core.test.mjs',
  'engine/test/verify-order.test.mjs',
  'engine/test/zip-fixture-builder.mjs',
  'engine/test/zip.test.mjs',
  'package-lock.json',
  'package.json',
  'README.md',
  'research/sources/optimalt-yatzy-source/.gitignore',
  'research/sources/optimalt-yatzy-source/LICENSE',
  'research/sources/optimalt-yatzy-source/pom.xml',
  'research/sources/optimalt-yatzy-source/README',
  'research/sources/optimalt-yatzy-source/src/main/java/se/kth/ansjobmarcular/ActionsStorage.java',
  'research/sources/optimalt-yatzy-source/src/main/java/se/kth/ansjobmarcular/App.java',
  'research/sources/optimalt-yatzy-source/src/main/java/se/kth/ansjobmarcular/Bot.java',
  'research/sources/optimalt-yatzy-source/src/main/java/se/kth/ansjobmarcular/Category.java',
  'research/sources/optimalt-yatzy-source/src/main/java/se/kth/ansjobmarcular/concurrency/basecases/BaseCase.java',
  'research/sources/optimalt-yatzy-source/src/main/java/se/kth/ansjobmarcular/concurrency/ParallellAction.java',
  'research/sources/optimalt-yatzy-source/src/main/java/se/kth/ansjobmarcular/concurrency/recursion/RollCase.java',
  'research/sources/optimalt-yatzy-source/src/main/java/se/kth/ansjobmarcular/FileActionsStorage.java',
  'research/sources/optimalt-yatzy-source/src/main/java/se/kth/ansjobmarcular/Generator.java',
  'research/sources/optimalt-yatzy-source/src/main/java/se/kth/ansjobmarcular/Hand.java',
  'research/sources/optimalt-yatzy-source/src/main/java/se/kth/ansjobmarcular/Keeper.java',
  'research/sources/optimalt-yatzy-source/src/main/java/se/kth/ansjobmarcular/MemoryActionsStorage.java',
  'research/sources/optimalt-yatzy-source/src/main/java/se/kth/ansjobmarcular/PanicException.java',
  'research/sources/optimalt-yatzy-source/src/main/java/se/kth/ansjobmarcular/ScoreCard.java',
  'research/sources/optimalt-yatzy-source/src/main/java/se/kth/ansjobmarcular/Utils.java',
  'research/sources/optimalt-yatzy-source/src/main/java/se/kth/ansjobmarcular/VoidActionsStorage.java',
  'research/sources/optimalt-yatzy-source/src/test/java/se/kth/ansjobmarcular/FileTest.java',
  'research/sources/optimalt-yatzy-source/src/test/java/se/kth/ansjobmarcular/HandTest.java',
  'research/sources/optimalt-yatzy-source/src/test/java/se/kth/ansjobmarcular/KeeperTest.java',
  'research/sources/optimalt-yatzy-source/src/test/java/se/kth/ansjobmarcular/ProbabilityTest.java',
  'research/sources/optimalt-yatzy-source/src/test/java/se/kth/ansjobmarcular/ScoreCardTest.java',
  'research/sources/optimalt-yatzy-source/src/test/java/se/kth/ansjobmarcular/SolutionTest.java',
  'research/sources/optimalt-yatzy-source/src/test/java/se/kth/ansjobmarcular/UtilsTest.java',
  'research/sources/SOURCE_METADATA.json',
  'rules/kth-2012-implementation-compatible-v1.json',
  'rules/swedish-alga-free-order-v1.json',
  'SCIENTIFIC_ESTIMANDS.md',
  'scripts/run-complete-research.ps1',
  'scripts/start-windows.bat',
  'scripts/verify-environment.ps1',
  'SOURCE_CHECKSUMS.sha256',
  'web/app.js',
  'web/index.html',
  'web/styles.css'
].sort(compareUtf8));

function collisionKey(value) {
  return value.toLocaleLowerCase('en-US');
}

function isWindowsReservedSegment(segment) {
  const strippedSegment = segment.replace(/[. ]+$/u, '');
  const extensionIndex = strippedSegment.indexOf('.');
  const rawBase = extensionIndex === -1 ? strippedSegment : strippedSegment.slice(0, extensionIndex);
  return WINDOWS_RESERVED.test(rawBase.replace(/[. ]+$/u, ''));
}

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

function gitBlobId(buffer) {
  return createHash('sha1').update(`blob ${buffer.length}\0`).update(buffer).digest('hex');
}

function runGit(repositoryRoot, args, { runner = runControlledProcessSync, encoding = 'utf8', maxOutputBytes = 64 * 1024 * 1024 } = {}) {
  return runner('git', args, {
    cwd: repositoryRoot,
    timeoutMs: 30_000,
    maxOutputBytes,
    encoding
  }).stdout;
}

export function validateSnapshotPath(value) {
  if (typeof value !== 'string' || value.length === 0 || value !== value.normalize('NFC')) {
    throw sourceFailure('YATZY_SOURCE_UNSAFE_PATH', 'tree path is not a nonempty normalized UTF-8 string.');
  }
  if (value.includes('\\') || value.startsWith('/') || value.endsWith('/') || path.posix.isAbsolute(value) || path.win32.isAbsolute(value)) {
    throw sourceFailure('YATZY_SOURCE_UNSAFE_PATH', 'tree path uses an unsafe absolute or ambiguous form.');
  }
  if (/[\x00-\x1f\x7f]/u.test(value)) throw sourceFailure('YATZY_SOURCE_UNSAFE_PATH', 'tree path contains a control character.');
  const segments = value.split('/');
  if (segments.some(segment => !segment || segment === '.' || segment === '..')) {
    throw sourceFailure('YATZY_SOURCE_UNSAFE_PATH', 'tree path contains an unsafe segment.');
  }
  for (const segment of segments) {
    if (WINDOWS_INVALID_CHARACTERS.test(segment) || /[. ]$/u.test(segment) || isWindowsReservedSegment(segment)) {
      throw sourceFailure('YATZY_SOURCE_UNSAFE_PATH', 'tree path is not portable to the destination filesystem.');
    }
  }
  return value;
}

export function parseGitTreeOutput(output) {
  if (!Buffer.isBuffer(output) || output.length === 0 || output.at(-1) !== 0) {
    throw sourceFailure('YATZY_SOURCE_TREE_MALFORMED', 'Git tree output is empty or not NUL terminated.');
  }
  const records = [];
  for (const raw of output.subarray(0, -1).toString('binary').split('\0')) {
    let decoded;
    try { decoded = UTF8_FATAL.decode(Buffer.from(raw, 'binary')); }
    catch { throw sourceFailure('YATZY_SOURCE_TREE_MALFORMED', 'Git tree output is not valid UTF-8.'); }
    const match = /^(\d{6}) ([a-z]+) ([0-9a-f]{40}) +(\d+|-)\t(.+)$/u.exec(decoded);
    if (!match) throw sourceFailure('YATZY_SOURCE_TREE_MALFORMED', 'Git tree record is malformed.');
    const [, gitMode, objectType, gitBlobIdValue, sizeValue, rawPath] = match;
    const entryPath = validateSnapshotPath(rawPath);
    if (objectType !== 'blob' || !REGULAR_MODES.has(gitMode) || sizeValue === '-') {
      throw sourceFailure('YATZY_SOURCE_UNSUPPORTED_ENTRY', 'Git tree contains a non-regular or unsupported entry.');
    }
    const byteLength = Number(sizeValue);
    if (!Number.isSafeInteger(byteLength) || byteLength < 0 || byteLength >= 256 * 1024 * 1024) {
      throw sourceFailure('YATZY_SOURCE_TREE_MALFORMED', 'Git tree entry has an unsupported byte length.');
    }
    records.push({ path: entryPath, gitMode, objectType, gitBlobId: gitBlobIdValue, byteLength });
  }
  records.sort((a, b) => compareUtf8(a.path, b.path));
  const exact = new Set();
  const prefixes = new Map();
  for (const entry of records) {
    if (exact.has(entry.path)) throw sourceFailure('YATZY_SOURCE_DUPLICATE_PATH', 'Git tree contains a duplicate normalized path.');
    exact.add(entry.path);
    const segments = entry.path.split('/');
    for (let index = 0; index < segments.length; index += 1) {
      const prefix = segments.slice(0, index + 1).join('/');
      const kind = index === segments.length - 1 ? 'file' : 'directory';
      const key = collisionKey(prefix);
      const previous = prefixes.get(key);
      if (previous && (previous.path !== prefix || previous.kind !== kind)) {
        throw sourceFailure('YATZY_SOURCE_CASE_COLLISION', 'Git tree contains a case-colliding path prefix or file/directory alias.');
      }
      if (!previous) prefixes.set(key, { path: prefix, kind });
    }
  }
  return records;
}

function validatePolicy(value) {
  if (!plainObject(value) || value.schemaVersion !== 1 || value.defaultDisposition !== 'exclude_unreviewed' || value.researchRoot !== RESEARCH_ROOT || !Array.isArray(value.entries)) {
    throw sourceFailure('YATZY_SOURCE_POLICY_INVALID', 'rights policy schema is invalid.');
  }
  const permittedDispositions = new Set(['author_owned_metadata', 'retained_third_party_mit', 'excluded_rights_unresolved']);
  const byPath = new Map();
  let previous = null;
  for (const item of value.entries) {
    if (!plainObject(item) || typeof item.included !== 'boolean' || !permittedDispositions.has(item.disposition)) {
      throw sourceFailure('YATZY_SOURCE_POLICY_INVALID', 'rights policy entry is invalid.');
    }
    const itemPath = validateSnapshotPath(item.path);
    if (itemPath !== RESEARCH_ROOT && !itemPath.startsWith(`${RESEARCH_ROOT}/`)) throw sourceFailure('YATZY_SOURCE_POLICY_INVALID', 'rights policy entry is outside the research root.');
    if (previous !== null && compareUtf8(previous, itemPath) >= 0) throw sourceFailure('YATZY_SOURCE_POLICY_INVALID', 'rights policy paths are not unique UTF-8 byte ordered values.');
    if (item.included !== (item.disposition !== 'excluded_rights_unresolved')) throw sourceFailure('YATZY_SOURCE_POLICY_INVALID', 'rights policy inclusion contradicts its disposition.');
    const notice = item.requiredNotice ?? null;
    if (notice !== null && validateSnapshotPath(notice) !== value.requiredNotice) throw sourceFailure('YATZY_SOURCE_POLICY_INVALID', 'rights policy notice is invalid.');
    const normalized = Object.freeze({ path: itemPath, disposition: item.disposition, included: item.included, requiredNotice: notice });
    byPath.set(itemPath, normalized);
    previous = itemPath;
  }
  if (!byPath.get(value.requiredMetadata)?.included || !byPath.get(value.requiredNotice)?.included) {
    throw sourceFailure('YATZY_SOURCE_POLICY_INVALID', 'rights policy omits mandatory metadata or notice.');
  }
  const subtree = value.completeSubtree;
  if (!plainObject(subtree) || typeof subtree.prefix !== 'string' || !Number.isSafeInteger(subtree.expectedEntryCount) || subtree.expectedEntryCount < 1) {
    throw sourceFailure('YATZY_SOURCE_POLICY_INVALID', 'rights policy complete-subtree rule is invalid.');
  }
  const retained = [...byPath.values()].filter(item => item.included && item.path.startsWith(subtree.prefix));
  if (retained.length !== subtree.expectedEntryCount || retained.some(item => item.disposition !== 'retained_third_party_mit')) {
    throw sourceFailure('YATZY_SOURCE_POLICY_INVALID', 'rights policy does not retain the complete reviewed subtree.');
  }
  return deepFreeze({ ...value, entries: [...byPath.values()], byPath });
}

function loadProductionPolicy() {
  let parsed;
  try { parsed = JSON.parse(fs.readFileSync(POLICY_FILE, 'utf8')); }
  catch { throw sourceFailure('YATZY_SOURCE_POLICY_INVALID', 'rights policy cannot be loaded.'); }
  return validatePolicy(parsed);
}

const PRODUCTION_POLICY = loadProductionPolicy();

export function readPublicSourcePolicy() {
  const { byPath: _ignored, ...serializable } = PRODUCTION_POLICY;
  return structuredClone(serializable);
}

function applyRightsPolicy(inventory, policy = PRODUCTION_POLICY) {
  const inventoryByPath = new Map(inventory.map(entry => [entry.path, entry]));
  const researchEntries = inventory.filter(entry => entry.path.startsWith(`${RESEARCH_ROOT}/`));
  for (const entry of researchEntries) {
    const decision = policy.byPath.get(entry.path);
    if (!decision || !decision.included) throw sourceFailure('YATZY_SOURCE_RIGHTS_DENIED', 'Git tree contains an excluded or unreviewed research source.');
  }
  for (const decision of policy.entries) {
    const present = inventoryByPath.has(decision.path);
    if (decision.included && !present) throw sourceFailure('YATZY_SOURCE_RIGHTS_INCOMPLETE', 'Git tree omits a required reviewed research source.');
    if (!decision.included && present) throw sourceFailure('YATZY_SOURCE_RIGHTS_DENIED', 'Git tree contains an excluded research source.');
  }
  const retained = researchEntries.filter(entry => entry.path.startsWith(policy.completeSubtree.prefix));
  if (retained.length !== policy.completeSubtree.expectedEntryCount || !inventoryByPath.has(policy.requiredNotice)) {
    throw sourceFailure('YATZY_SOURCE_RIGHTS_INCOMPLETE', 'Git tree does not contain the complete reviewed third-party subtree and notice.');
  }
  return inventory.map(entry => {
    const decision = policy.byPath.get(entry.path);
    return Object.freeze({
      ...entry,
      rightsDisposition: decision?.disposition ?? 'tracked_source',
      requiredNotice: decision?.requiredNotice ?? null
    });
  });
}

export function createSourceSnapshotPlan({ repositoryRoot, sourceCommit, runner = runControlledProcessSync } = {}) {
  if (typeof repositoryRoot !== 'string' || !path.isAbsolute(repositoryRoot)) throw sourceFailure('YATZY_SOURCE_REPOSITORY_INVALID', 'repository root must be absolute.');
  const resolvedRoot = path.resolve(repositoryRoot);
  let rootStat;
  try { rootStat = fs.lstatSync(resolvedRoot); }
  catch { throw sourceFailure('YATZY_SOURCE_REPOSITORY_INVALID', 'repository root is unavailable.'); }
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw sourceFailure('YATZY_SOURCE_REPOSITORY_INVALID', 'repository root is not a regular directory.');
  let canonicalRoot;
  try { canonicalRoot = fs.realpathSync.native(resolvedRoot); }
  catch { throw sourceFailure('YATZY_SOURCE_REPOSITORY_INVALID', 'repository root identity cannot be proven.'); }
  const key = process.platform === 'win32' ? value => value.toLowerCase() : value => value;
  if (key(canonicalRoot) !== key(resolvedRoot)) throw sourceFailure('YATZY_SOURCE_REPOSITORY_INVALID', 'repository root is redirected.');
  if (typeof sourceCommit !== 'string' || !/^[0-9a-f]{40}$/u.test(sourceCommit)) throw sourceFailure('YATZY_SOURCE_COMMIT_INVALID', 'source commit must be an explicit lowercase 40-hex identity.');
  const resolvedCommit = String(runGit(resolvedRoot, ['rev-parse', '--verify', `${sourceCommit}^{commit}`], { runner })).trim();
  if (resolvedCommit !== sourceCommit) throw sourceFailure('YATZY_SOURCE_COMMIT_INVALID', 'source commit did not resolve exactly.');
  const sourceTree = String(runGit(resolvedRoot, ['rev-parse', '--verify', `${sourceCommit}^{tree}`], { runner })).trim();
  if (!/^[0-9a-f]{40}$/u.test(sourceTree)) throw sourceFailure('YATZY_SOURCE_TREE_MALFORMED', 'source tree identity is invalid.');
  const treeOutput = runGit(resolvedRoot, ['ls-tree', '-r', '-z', '-l', '--full-tree', sourceCommit], { runner, encoding: 'buffer' });
  const entries = applyRightsPolicy(parseGitTreeOutput(treeOutput));
  const plan = Object.freeze({ repositoryRoot: resolvedRoot, sourceCommit, sourceTree, entries: Object.freeze(entries), runner });
  PLAN_IDENTITIES.add(plan);
  return plan;
}

function requirePlan(plan) {
  if (!plainObject(plan) || !PLAN_IDENTITIES.has(plan)) throw sourceFailure('YATZY_SOURCE_PLAN_INVALID', 'operation requires a validated frozen source plan.');
  return plan;
}

function selectedEntries(plan, selection) {
  if (selection === 'tracked') return plan.entries;
  if (selection === 'research') return plan.entries.filter(entry => entry.path.startsWith(`${RESEARCH_ROOT}/`));
  throw sourceFailure('YATZY_SOURCE_SELECTION_INVALID', 'snapshot selection is invalid.');
}

function payloadPath(entryPath, selection) {
  return selection === 'research' ? entryPath.slice(`${RESEARCH_ROOT}/`.length) : entryPath;
}

function manifestFor(plan, entries, purpose, realized) {
  if (typeof purpose !== 'string' || !/^[a-z0-9][a-z0-9-]{1,63}$/u.test(purpose)) throw sourceFailure('YATZY_SOURCE_PURPOSE_INVALID', 'manifest purpose is invalid.');
  const manifestEntries = entries.map(entry => {
    const value = realized.get(entry.path);
    return {
      path: entry.path,
      gitMode: entry.gitMode,
      gitBlobId: entry.gitBlobId,
      sha256: value.sha256,
      byteLength: entry.byteLength,
      rightsDisposition: entry.rightsDisposition,
      requiredNotice: entry.requiredNotice
    };
  });
  return {
    schemaVersion: 1,
    purpose,
    sourceCommit: plan.sourceCommit,
    sourceTree: plan.sourceTree,
    entryCount: manifestEntries.length,
    totalBytes: manifestEntries.reduce((sum, entry) => sum + entry.byteLength, 0),
    entries: manifestEntries
  };
}

function readExactBlob(plan, entry) {
  const bytes = runGit(plan.repositoryRoot, ['cat-file', 'blob', entry.gitBlobId], {
    runner: plan.runner,
    encoding: 'buffer',
    maxOutputBytes: Math.max(1, entry.byteLength + 1)
  });
  if (!Buffer.isBuffer(bytes) || bytes.length !== entry.byteLength || gitBlobId(bytes) !== entry.gitBlobId) {
    throw sourceFailure('YATZY_SOURCE_BLOB_MISMATCH', 'Git blob bytes do not match the frozen tree record.');
  }
  return bytes;
}

function pathIdentity(value) {
  const resolved = path.resolve(value);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function listRegularPayloadFiles(root) {
  const resolvedRoot = path.resolve(root);
  const files = [];
  function walk(current) {
    let stat;
    try { stat = fs.lstatSync(current); }
    catch { throw sourceFailure('YATZY_SOURCE_VERIFY_FAILED', 'snapshot path state cannot be proven.'); }
    if (stat.isSymbolicLink()) throw sourceFailure('YATZY_SOURCE_VERIFY_FAILED', 'snapshot contains filesystem redirection.');
    let canonical;
    try { canonical = fs.realpathSync.native(current); }
    catch { throw sourceFailure('YATZY_SOURCE_VERIFY_FAILED', 'snapshot canonical path cannot be proven.'); }
    if (pathIdentity(canonical) !== pathIdentity(current)) throw sourceFailure('YATZY_SOURCE_VERIFY_FAILED', 'snapshot contains canonical redirection.');
    if (stat.isFile()) { files.push(current); return; }
    if (!stat.isDirectory()) throw sourceFailure('YATZY_SOURCE_VERIFY_FAILED', 'snapshot contains a non-regular filesystem entry.');
    for (const name of fs.readdirSync(current)) walk(path.join(current, name));
  }
  walk(resolvedRoot);
  return files;
}

function verifyPayloadDirectory(root, manifest, selection) {
  const actualPaths = listRegularPayloadFiles(root).map(file => relativePosix(root, file)).sort(compareUtf8);
  const expectedPaths = manifest.entries.map(entry => payloadPath(entry.path, selection));
  if (actualPaths.length !== expectedPaths.length || actualPaths.some((value, index) => value !== expectedPaths[index])) {
    throw sourceFailure('YATZY_SOURCE_VERIFY_FAILED', 'snapshot path inventory does not match its manifest.');
  }
  for (const entry of manifest.entries) {
    const file = resolveWithin(root, payloadPath(entry.path, selection));
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== entry.byteLength || sha256(fs.readFileSync(file)) !== entry.sha256) {
      throw sourceFailure('YATZY_SOURCE_VERIFY_FAILED', 'snapshot payload does not match its manifest.');
    }
  }
}

export function materializeSourceSnapshot({ plan: planValue, ownership, destination, manifestPath, purpose, selection = 'tracked' } = {}) {
  const plan = requirePlan(planValue);
  const entries = selectedEntries(plan, selection);
  const safeDestination = assertOwnedPath(ownership, destination, { mustExist: false });
  const safeManifest = assertOwnedPath(ownership, manifestPath, { mustExist: false });
  if (path.dirname(safeDestination) !== path.dirname(safeManifest)) throw sourceFailure('YATZY_SOURCE_DESTINATION_INVALID', 'manifest must be adjacent to the snapshot destination.');
  const stage = createOwnedTempDir(ownership, path.dirname(safeDestination), 'source-snapshot');
  const realized = new Map();
  let promoted = false;
  try {
    for (const entry of entries) {
      const bytes = readExactBlob(plan, entry);
      const file = resolveWithin(stage, payloadPath(entry.path, selection));
      ensureOwnedDir(ownership, path.dirname(file));
      assertOwnedPath(ownership, file, { mustExist: false });
      const fd = fs.openSync(file, 'wx', entry.gitMode === '100755' ? 0o755 : 0o644);
      try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); }
      finally { fs.closeSync(fd); }
      if (entry.gitMode === '100755') fs.chmodSync(file, 0o755);
      realized.set(entry.path, { sha256: sha256(bytes) });
    }
    const manifest = manifestFor(plan, entries, purpose, realized);
    verifyPayloadDirectory(stage, manifest, selection);
    promoteOwnedPath(ownership, stage, safeDestination, { replaceExisting: false });
    promoted = true;
    writeJsonAtomicOwned(ownership, safeManifest, manifest, { replaceExisting: false });
    verifySourceSnapshot({ plan, destination: safeDestination, manifestPath: safeManifest, purpose, selection });
    return Object.freeze({ destination: safeDestination, manifestPath: safeManifest, manifest: deepFreeze(manifest) });
  } catch (error) {
    try {
      if (promoted && fs.existsSync(safeDestination)) removeOwnedPath(ownership, safeDestination, { recursive: true, allowMissing: true, type: 'directory' });
      else if (fs.existsSync(stage)) removeOwnedPath(ownership, stage, { recursive: true, allowMissing: true, type: 'directory' });
      if (fs.existsSync(safeManifest)) removeOwnedPath(ownership, safeManifest, { allowMissing: true, type: 'file' });
    } catch (cleanupError) { error.cleanupError = cleanupError.message; }
    throw error;
  }
}

export function verifySourceSnapshot({ plan: planValue, destination, manifestPath, purpose, selection = 'tracked' } = {}) {
  const plan = requirePlan(planValue);
  const entries = selectedEntries(plan, selection);
  let manifest;
  try {
    const stat = fs.lstatSync(manifestPath);
    const canonical = fs.realpathSync.native(manifestPath);
    if (!stat.isFile() || stat.isSymbolicLink() || pathIdentity(canonical) !== pathIdentity(manifestPath)) throw new Error('unsafe manifest');
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  }
  catch { throw sourceFailure('YATZY_SOURCE_VERIFY_FAILED', 'snapshot manifest cannot be read.'); }
  const realized = new Map(entries.map(entry => [entry.path, { sha256: sha256(readExactBlob(plan, entry)) }]));
  const expected = manifestFor(plan, entries, purpose, realized);
  if (JSON.stringify(manifest) !== JSON.stringify(expected)) throw sourceFailure('YATZY_SOURCE_VERIFY_FAILED', 'snapshot manifest does not match the frozen plan.');
  const stableBytes = `${JSON.stringify(expected, null, 2)}\n`;
  if (!fs.readFileSync(manifestPath).equals(Buffer.from(stableBytes, 'utf8'))) throw sourceFailure('YATZY_SOURCE_VERIFY_FAILED', 'snapshot manifest serialization is not stable.');
  verifyPayloadDirectory(destination, expected, selection);
  return expected;
}

export function materializeResearchSources(options = {}) {
  return materializeSourceSnapshot({ ...options, selection: 'research' });
}

export function verifyResearchSources(options = {}) {
  return verifySourceSnapshot({ ...options, selection: 'research' });
}

export const PUBLIC_PACKAGE_DIRECTORY = 'public-source-package';
export const PUBLIC_PACKAGE_MANIFEST = 'PUBLIC_PACKAGE_MANIFEST.json';
export const PUBLIC_PROVENANCE = 'PUBLIC_PROVENANCE.json';
const PUBLIC_PACKAGE_METADATA_PATHS = Object.freeze([PUBLIC_PACKAGE_MANIFEST, PUBLIC_PROVENANCE].sort(compareUtf8));
const PUBLIC_PACKAGE_DOMAIN = Buffer.from('yatzy-public-packaged-source-v1\0', 'utf8');
const CANONICAL_RULES_PATH = 'rules/swedish-alga-free-order-v1.json';
const REGISTERED_PROFILE_PATH = 'engine/test/fixtures/registered-full-profile.json';
const RIGHTS_POLICY_PATH = 'engine/src/v3/public-source-policy.json';
const RIGHTS_EXCLUDED_PATHS = Object.freeze([
  'research/sources/Alga_Yatzy_rules_manual.pdf',
  'research/sources/KTH_2012_optimal_yatzy.pdf',
  'scripts/install-node-autostart.ps1',
  'scripts/uninstall-node-autostart.ps1'
]);

function packageFailure(code, message) {
  const error = new Error(`Public source package ${message}`);
  error.code = code;
  return error;
}

function assertCanonicalDirectory(root, role) {
  if (typeof root !== 'string' || !path.isAbsolute(root)) throw packageFailure('YATZY_PUBLIC_PACKAGE_SOURCE_INVALID', `${role} must be absolute.`);
  const resolved = path.resolve(root);
  let stat;
  let canonical;
  try {
    stat = fs.lstatSync(resolved);
    canonical = fs.realpathSync.native(resolved);
  } catch {
    throw packageFailure('YATZY_PUBLIC_PACKAGE_SOURCE_INVALID', `${role} cannot be proven.`);
  }
  if (!stat.isDirectory() || stat.isSymbolicLink() || pathIdentity(canonical) !== pathIdentity(resolved)) {
    throw packageFailure('YATZY_PUBLIC_PACKAGE_SOURCE_INVALID', `${role} is redirected or not a regular directory.`);
  }
  return resolved;
}

function readRegularSourceFile(root, relative) {
  validateSnapshotPath(relative);
  const file = resolveWithin(root, relative);
  let stat;
  let canonical;
  try {
    stat = fs.lstatSync(file);
    canonical = fs.realpathSync.native(file);
  } catch {
    throw packageFailure('YATZY_PUBLIC_PACKAGE_SOURCE_INVALID', 'an allowlisted source path is unavailable.');
  }
  if (!stat.isFile() || stat.isSymbolicLink() || pathIdentity(canonical) !== pathIdentity(file)) {
    throw packageFailure('YATZY_PUBLIC_PACKAGE_SOURCE_INVALID', 'an allowlisted source path is redirected or non-regular.');
  }
  return { file, bytes: fs.readFileSync(file), byteLength: stat.size };
}

function uint64(value) {
  if (!Number.isSafeInteger(value) || value < 0) throw packageFailure('YATZY_PUBLIC_PACKAGE_INVALID', 'a framed byte length is invalid.');
  const bytes = Buffer.alloc(8);
  bytes.writeBigUInt64BE(BigInt(value));
  return bytes;
}

function packagedSourceIdentity(entries, readBytes) {
  const hash = createHash('sha256');
  hash.update(PUBLIC_PACKAGE_DOMAIN);
  for (const entry of entries) {
    const name = Buffer.from(entry.path, 'utf8');
    const bytes = readBytes(entry);
    hash.update(uint64(name.length));
    hash.update(name);
    hash.update(uint64(bytes.length));
    hash.update(bytes);
  }
  return hash.digest('hex');
}

function parseStableJson(bytes, role) {
  let value;
  try { value = JSON.parse(bytes.toString('utf8')); }
  catch { throw packageFailure('YATZY_PUBLIC_PACKAGE_INVALID', `${role} is not valid JSON.`); }
  return value;
}

function semanticJsonSha256(bytes, role) {
  return sha256(Buffer.from(stableJson(parseStableJson(bytes, role)), 'utf8'));
}

function validatePackagePolicy(bytes) {
  const policy = validatePolicy(parseStableJson(bytes, 'rights policy'));
  const included = policy.entries.filter(entry => entry.included);
  const excluded = policy.entries.filter(entry => !entry.included);
  if (policy.entries.length !== 30 || included.length !== 28 || excluded.length !== 2) {
    throw packageFailure('YATZY_PUBLIC_PACKAGE_RIGHTS_INVALID', 'rights policy decision counts are not the approved 30/28/2 boundary.');
  }
  if (policy.completeSubtree.expectedEntryCount !== 27 || policy.requiredNotice !== 'research/sources/optimalt-yatzy-source/LICENSE') {
    throw packageFailure('YATZY_PUBLIC_PACKAGE_RIGHTS_INVALID', 'historical Java subtree boundary is not approved.');
  }
  return policy;
}

function buildPackageManifest(payload) {
  const entries = payload.map(({ path: entryPath, bytes }) => ({
    path: entryPath,
    byteLength: bytes.length,
    sha256: sha256(bytes)
  }));
  const packagedSourceSha256 = packagedSourceIdentity(entries, entry => payload.find(item => item.path === entry.path).bytes);
  return {
    schemaVersion: 'yatzy-public-package-manifest-v1',
    identityAlgorithm: 'sha256-framed-path-and-content-v1',
    identityDomain: 'yatzy-public-packaged-source-v1',
    identityScope: 'payload-files-only',
    excludedSelfMetadata: [...PUBLIC_PACKAGE_METADATA_PATHS],
    packagedSourceSha256,
    payloadFileCount: entries.length,
    payloadByteLength: entries.reduce((total, entry) => total + entry.byteLength, 0),
    rightsBoundary: {
      policyPath: RIGHTS_POLICY_PATH,
      decisionCount: 30,
      includedDecisionCount: 28,
      excludedDecisionCount: 2,
      historicalJavaPathCount: 27,
      retainedNotice: 'research/sources/optimalt-yatzy-source/LICENSE',
      excludedPaths: [...RIGHTS_EXCLUDED_PATHS]
    },
    entries
  };
}

function expectedPublicProvenance(manifest, payloadByPath, environment, manifestBytes) {
  return createPublicProvenance({
    packagedSourceSha256: manifest.packagedSourceSha256,
    packageManifestSha256: sha256(manifestBytes),
    payloadFileCount: manifest.payloadFileCount,
    payloadByteLength: manifest.payloadByteLength,
    canonicalRulesSha256: semanticJsonSha256(payloadByPath.get(CANONICAL_RULES_PATH), 'canonical rules'),
    registeredProfileSha256: semanticJsonSha256(payloadByPath.get(REGISTERED_PROFILE_PATH), 'registered profile'),
    rightsPolicySha256: sha256(payloadByPath.get(RIGHTS_POLICY_PATH)),
    environment
  });
}

function verifyExactPackageInventory(packageRoot) {
  const expected = [...PUBLIC_PACKAGE_METADATA_PATHS, ...PUBLIC_PACKAGE_PAYLOAD_PATHS].sort(compareUtf8);
  const actual = listRegularPayloadFiles(packageRoot).map(file => relativePosix(packageRoot, file)).sort(compareUtf8);
  if (actual.length !== expected.length || actual.some((value, index) => value !== expected[index])) {
    throw packageFailure('YATZY_PUBLIC_PACKAGE_INVALID', 'path inventory differs from the public package allowlist.');
  }
}

export function verifyPublicSourcePackage(packageRootValue) {
  const packageRoot = assertCanonicalDirectory(packageRootValue, 'package root');
  verifyExactPackageInventory(packageRoot);
  const payload = PUBLIC_PACKAGE_PAYLOAD_PATHS.map(entryPath => ({ path: entryPath, ...readRegularSourceFile(packageRoot, entryPath) }));
  const payloadByPath = new Map(payload.map(entry => [entry.path, entry.bytes]));
  validatePackagePolicy(payloadByPath.get(RIGHTS_POLICY_PATH));
  const expectedManifest = buildPackageManifest(payload);
  const expectedManifestBytes = Buffer.from(`${JSON.stringify(expectedManifest, null, 2)}\n`, 'utf8');
  const actualManifestBytes = readRegularSourceFile(packageRoot, PUBLIC_PACKAGE_MANIFEST).bytes;
  if (!actualManifestBytes.equals(expectedManifestBytes)) throw packageFailure('YATZY_PUBLIC_PACKAGE_TAMPERED', 'manifest or payload identity does not verify.');
  const provenanceBytes = readRegularSourceFile(packageRoot, PUBLIC_PROVENANCE).bytes;
  const provenance = parseStableJson(provenanceBytes, 'public provenance');
  if (!plainObject(provenance) || !plainObject(provenance.environment)) throw packageFailure('YATZY_PUBLIC_PACKAGE_INVALID', 'public provenance schema is invalid.');
  const environment = normalizePublicEnvironment(provenance.environment);
  const expectedProvenance = expectedPublicProvenance(expectedManifest, payloadByPath, environment, expectedManifestBytes);
  const expectedProvenanceBytes = Buffer.from(serializePublicProvenance(expectedProvenance), 'utf8');
  if (!provenanceBytes.equals(expectedProvenanceBytes)) throw packageFailure('YATZY_PUBLIC_PACKAGE_TAMPERED', 'public provenance does not verify.');
  return deepFreeze({
    packageRoot,
    packagedSourceSha256: expectedManifest.packagedSourceSha256,
    packageManifestSha256: sha256(expectedManifestBytes),
    publicProvenanceSha256: sha256(expectedProvenanceBytes),
    payloadFileCount: expectedManifest.payloadFileCount,
    payloadByteLength: expectedManifest.payloadByteLength,
    manifest: expectedManifest,
    provenance: expectedProvenance
  });
}

export function buildPublicSourcePackage({ sourceRoot: sourceRootValue, outputRoot, environment = collectPublicEnvironment() } = {}) {
  const sourceRoot = assertCanonicalDirectory(sourceRootValue, 'source root');
  const publicEnvironment = normalizePublicEnvironment(environment);
  const ownership = claimOutputRoot(outputRoot, { forbiddenTrees: [sourceRoot] });
  const destination = assertOwnedPath(ownership, path.join(path.resolve(outputRoot), PUBLIC_PACKAGE_DIRECTORY), { mustExist: false });
  const stage = createOwnedTempDir(ownership, path.resolve(outputRoot), 'public-source-package');
  let promoted = false;
  try {
    const payload = [];
    for (const entryPath of PUBLIC_PACKAGE_PAYLOAD_PATHS) {
      const source = readRegularSourceFile(sourceRoot, entryPath);
      const destinationFile = resolveWithin(stage, entryPath);
      copyFileAtomicOwned(ownership, source.file, destinationFile, { replaceExisting: false });
      const copied = readRegularSourceFile(stage, entryPath);
      if (!copied.bytes.equals(source.bytes)) throw packageFailure('YATZY_PUBLIC_PACKAGE_COPY_FAILED', 'copied payload bytes changed.');
      payload.push({ path: entryPath, bytes: copied.bytes });
    }
    const payloadByPath = new Map(payload.map(entry => [entry.path, entry.bytes]));
    validatePackagePolicy(payloadByPath.get(RIGHTS_POLICY_PATH));
    const manifest = buildPackageManifest(payload);
    const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
    const provenance = expectedPublicProvenance(manifest, payloadByPath, publicEnvironment, manifestBytes);
    writeTextAtomicOwned(ownership, path.join(stage, PUBLIC_PACKAGE_MANIFEST), manifestBytes.toString('utf8'), { replaceExisting: false });
    writeTextAtomicOwned(ownership, path.join(stage, PUBLIC_PROVENANCE), serializePublicProvenance(provenance), { replaceExisting: false });
    verifyPublicSourcePackage(stage);
    promoteOwnedPath(ownership, stage, destination, { replaceExisting: false });
    promoted = true;
    return verifyPublicSourcePackage(destination);
  } catch (error) {
    try {
      if (!promoted && fs.existsSync(stage)) removeOwnedPath(ownership, stage, { recursive: true, allowMissing: true, type: 'directory' });
    } catch (cleanupError) { error.cleanupError = cleanupError.message; }
    throw error;
  }
}
