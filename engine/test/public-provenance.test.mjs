import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  collectPrivateOperationalEnvironment,
  createPublicProvenance,
  normalizePublicEnvironment,
  PUBLIC_ENVIRONMENT_FIELDS,
  serializePublicProvenance
} from '../src/pipeline/preflight.mjs';
import {
  buildPublicSourcePackage,
  PUBLIC_PACKAGE_DIRECTORY,
  PUBLIC_PACKAGE_MANIFEST,
  PUBLIC_PACKAGE_PAYLOAD_PATHS,
  PUBLIC_PROVENANCE,
  verifyPublicSourcePackage
} from '../src/v3/source-snapshot.mjs';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const publicEnvironment = Object.freeze({
  nodeVersion: 'v22.14.0',
  osFamily: 'windows',
  architecture: 'x64',
  logicalCoreCount: 8
});
const syntheticPrivateSentinels = Object.freeze([
  'host-private-sentinel',
  'username-private-sentinel',
  'C:/Users/private-home-sentinel',
  'D:/private-workspace-sentinel/source',
  'private-contact@example.invalid',
  'SECRET_LIKE_ENV_SENTINEL_8f031',
  'Private CPU Model Sentinel',
  'D:/private-stack-sentinel/module.mjs:12',
  'C:/Temp/private-temp-sentinel'
]);

function tempContainer(t, prefix = 'yatzy-public-package-') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function buildAt(t, label = 'output', sourceRoot = projectRoot) {
  const container = tempContainer(t);
  const outputRoot = path.join(container, label);
  const result = buildPublicSourcePackage({ sourceRoot, outputRoot, environment: publicEnvironment });
  return { container, outputRoot, packageRoot: path.join(outputRoot, PUBLIC_PACKAGE_DIRECTORY), result };
}

function metadataBytes(packageRoot) {
  return {
    manifest: fs.readFileSync(path.join(packageRoot, PUBLIC_PACKAGE_MANIFEST)),
    provenance: fs.readFileSync(path.join(packageRoot, PUBLIC_PROVENANCE))
  };
}

test('public provenance exposes exactly the approved four-field environment schema', () => {
  assert.deepEqual(PUBLIC_ENVIRONMENT_FIELDS, ['nodeVersion', 'osFamily', 'architecture', 'logicalCoreCount']);
  assert.deepEqual(normalizePublicEnvironment(publicEnvironment), publicEnvironment);
  assert.throws(
    () => normalizePublicEnvironment({ ...publicEnvironment, hostname: syntheticPrivateSentinels[0] }),
    { code: 'YATZY_PUBLIC_PROVENANCE_INVALID' }
  );
  const report = createPublicProvenance({
    packagedSourceSha256: '1'.repeat(64),
    packageManifestSha256: '2'.repeat(64),
    payloadFileCount: 1,
    payloadByteLength: 1,
    canonicalRulesSha256: '3'.repeat(64),
    registeredProfileSha256: '4'.repeat(64),
    rightsPolicySha256: '5'.repeat(64),
    environment: publicEnvironment
  });
  const serialized = serializePublicProvenance(report);
  assert.equal(serialized, `${JSON.stringify(report, null, 2)}\n`);
  for (const sentinel of syntheticPrivateSentinels) assert.equal(serialized.includes(sentinel), false, sentinel);
  const privateOperational = collectPrivateOperationalEnvironment({ freeMemory: 123 });
  assert.equal(privateOperational.freeMemory, 123);
  assert.equal(Object.hasOwn(report.environment, 'hostname'), false);
  assert.equal(Object.hasOwn(report.environment, 'cpu'), false);
  assert.equal(Object.hasOwn(report.environment, 'totalMemory'), false);
  assert.equal(Object.hasOwn(report.environment, 'freeMemory'), false);
});

test('package identity and metadata bytes reproduce at different absolute paths and without .git', t => {
  const first = buildAt(t, 'absolute-path-a');
  const second = buildAt(t, 'different-absolute-path-b');
  assert.equal(fs.existsSync(path.join(first.packageRoot, '.git')), false);
  assert.equal(first.result.packagedSourceSha256, second.result.packagedSourceSha256);
  assert.deepEqual(metadataBytes(first.packageRoot), metadataBytes(second.packageRoot));

  const thirdContainer = tempContainer(t, 'yatzy-public-package-no-git-');
  const thirdOutputRoot = path.join(thirdContainer, 'rebuilt-at-new-path');
  const third = buildPublicSourcePackage({ sourceRoot: first.packageRoot, outputRoot: thirdOutputRoot, environment: publicEnvironment });
  const thirdPackageRoot = path.join(thirdOutputRoot, PUBLIC_PACKAGE_DIRECTORY);
  assert.equal(fs.existsSync(path.join(thirdPackageRoot, '.git')), false);
  assert.equal(third.packagedSourceSha256, first.result.packagedSourceSha256);
  assert.deepEqual(metadataBytes(thirdPackageRoot), metadataBytes(first.packageRoot));
  assert.equal(verifyPublicSourcePackage(thirdPackageRoot).packagedSourceSha256, first.result.packagedSourceSha256);
});

test('manifest enforces the reviewed public path and rights boundary', t => {
  const built = buildAt(t);
  const manifest = built.result.manifest;
  assert.equal(manifest.payloadFileCount, PUBLIC_PACKAGE_PAYLOAD_PATHS.length);
  assert.deepEqual(manifest.entries.map(entry => entry.path), PUBLIC_PACKAGE_PAYLOAD_PATHS);
  assert.deepEqual(manifest.rightsBoundary, {
    policyPath: 'engine/src/v3/public-source-policy.json',
    decisionCount: 30,
    includedDecisionCount: 28,
    excludedDecisionCount: 2,
    historicalJavaPathCount: 27,
    retainedNotice: 'research/sources/optimalt-yatzy-source/LICENSE',
    excludedPaths: [
      'research/sources/Alga_Yatzy_rules_manual.pdf',
      'research/sources/KTH_2012_optimal_yatzy.pdf',
      'scripts/install-node-autostart.ps1',
      'scripts/uninstall-node-autostart.ps1'
    ]
  });
  for (const excluded of manifest.rightsBoundary.excludedPaths) {
    assert.equal(manifest.entries.some(entry => entry.path === excluded), false, excluded);
    assert.equal(fs.existsSync(path.join(built.packageRoot, ...excluded.split('/'))), false, excluded);
  }
  assert.equal(manifest.entries.some(entry => entry.path.toLowerCase().endsWith('.pdf')), false);
  assert.equal(manifest.entries.filter(entry => entry.path.startsWith('research/sources/optimalt-yatzy-source/')).length, 27);
  assert.equal(manifest.entries.some(entry => entry.path === manifest.rightsBoundary.retainedNotice), true);
});

test('public package metadata contains no private sentinel or absolute source path', t => {
  const built = buildAt(t);
  const { manifest, provenance } = metadataBytes(built.packageRoot);
  const publicText = Buffer.concat([manifest, provenance]).toString('utf8');
  for (const sentinel of syntheticPrivateSentinels) assert.equal(publicText.includes(sentinel), false, sentinel);
  assert.equal(publicText.includes(projectRoot), false);
  assert.equal(publicText.includes(projectRoot.replaceAll('\\', '/')), false);
  assert.equal(/"(?:hostname|username|homeDirectory|workspacePath|email|cpuModel|stack|tempPath)"/u.test(publicText), false);
});

test('one harmless payload-byte change is detected and changes the rebuilt identity', t => {
  const original = buildAt(t, 'original');
  const readme = path.join(original.packageRoot, 'README.md');
  fs.appendFileSync(readme, Buffer.from('\nphase-9c2e-synthetic-tamper\n', 'utf8'));
  assert.throws(() => verifyPublicSourcePackage(original.packageRoot), { code: 'YATZY_PUBLIC_PACKAGE_TAMPERED' });

  const rebuiltContainer = tempContainer(t, 'yatzy-public-package-tamper-rebuild-');
  const rebuilt = buildPublicSourcePackage({
    sourceRoot: original.packageRoot,
    outputRoot: path.join(rebuiltContainer, 'output'),
    environment: publicEnvironment
  });
  assert.notEqual(rebuilt.packagedSourceSha256, original.result.packagedSourceSha256);
});

test('atomic promotion preserves prior output and cleans failed staging', t => {
  const built = buildAt(t, 'atomic-output');
  const before = metadataBytes(built.packageRoot);
  assert.throws(
    () => buildPublicSourcePackage({ sourceRoot: projectRoot, outputRoot: built.outputRoot, environment: publicEnvironment }),
    { code: 'YATZY_FS_UNEXPECTED_TARGET' }
  );
  assert.deepEqual(metadataBytes(built.packageRoot), before);
  assert.deepEqual(fs.readdirSync(built.outputRoot), [PUBLIC_PACKAGE_DIRECTORY]);

  const incompleteSource = buildAt(t, 'incomplete-source').packageRoot;
  fs.rmSync(path.join(incompleteSource, 'README.md'));
  const failedContainer = tempContainer(t, 'yatzy-public-package-failed-');
  const failedOutput = path.join(failedContainer, 'output');
  assert.throws(
    () => buildPublicSourcePackage({ sourceRoot: incompleteSource, outputRoot: failedOutput, environment: publicEnvironment }),
    { code: 'YATZY_PUBLIC_PACKAGE_SOURCE_INVALID' }
  );
  assert.deepEqual(fs.readdirSync(failedOutput), []);
});
