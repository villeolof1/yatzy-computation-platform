import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildResearchBundle } from '../src/analysis/dossier.mjs';
import { ensureOwnedDir, listFilesRecursive } from '../src/util/fs.mjs';
import { runControlledProcessSync } from '../src/util/child-process.mjs';
import { buildPaperStaging } from '../src/v3/archive.mjs';
import { claimToEvidenceRegister, prepareV3SourceStage } from '../src/v3/official-pipeline.mjs';
import { claimOutputRoot, relativePosix } from '../src/v3/paths.mjs';
import {
  createSourceSnapshotPlan,
  materializeSourceSnapshot,
  parseGitTreeOutput,
  readPublicSourcePolicy,
  verifySourceSnapshot
} from '../src/v3/source-snapshot.mjs';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const excludedPdfs = [
  'research/sources/Alga_Yatzy_rules_manual.pdf',
  'research/sources/KTH_2012_optimal_yatzy.pdf'
];

function git(root, args, encoding = 'utf8') {
  return runControlledProcessSync('git', args, {
    cwd: root,
    timeoutMs: 30_000,
    maxOutputBytes: 16 * 1024 * 1024,
    encoding
  }).stdout;
}

function put(root, relative, bytes) {
  const file = path.join(root, ...relative.split('/'));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, bytes);
  return file;
}

function fixtureRepository(t) {
  const container = fs.mkdtempSync(path.join(os.tmpdir(), 'yatzy-source-fixture-'));
  const root = path.join(container, 'repository');
  fs.mkdirSync(root);
  git(root, ['init', '-q']);
  git(root, ['config', 'user.name', 'Phase 9C2B Fixture']);
  git(root, ['config', 'user.email', 'fixture.invalid@example.invalid']);
  git(root, ['config', 'core.autocrlf', 'false']);
  put(root, '.gitignore', 'ignored/\n*.pdf\nprivate-*.json\n');
  put(root, 'README.md', 'fixture repository\n');
  put(root, 'package.json', '{"name":"fixture","private":true}\n');
  put(root, 'package-lock.json', '{"name":"fixture","lockfileVersion":3}\n');
  put(root, 'src/text.txt', 'committed\nline\n');
  put(root, 'src/data.bin', Buffer.from([0, 1, 2, 13, 10, 255]));
  for (const decision of readPublicSourcePolicy().entries.filter(entry => entry.included)) {
    put(root, decision.path, `fixture:${decision.path}\n`);
  }
  git(root, ['add', '-A']);
  git(root, ['commit', '-q', '-m', 'fixture base']);
  const commit = git(root, ['rev-parse', 'HEAD']).trim();
  const tree = git(root, ['rev-parse', 'HEAD^{tree}']).trim();
  t.after(() => fs.rmSync(container, { recursive: true, force: true }));
  return { container, root, commit, tree };
}

function commitAll(root, subject) {
  git(root, ['add', '-A', '-f']);
  git(root, ['commit', '-q', '-m', subject]);
  return git(root, ['rev-parse', 'HEAD']).trim();
}

function ownedOutput(t, label = 'output') {
  const container = fs.mkdtempSync(path.join(os.tmpdir(), 'yatzy-source-output-'));
  const root = path.join(container, label);
  const ownership = claimOutputRoot(root);
  t.after(() => fs.rmSync(container, { recursive: true, force: true }));
  return { container, root, ownership };
}

function snapshotBytes(root) {
  const result = new Map();
  for (const file of listFilesRecursive(root)) result.set(relativePosix(root, file), fs.readFileSync(file));
  return result;
}

function assertSameSnapshot(a, b) {
  const left = snapshotBytes(a), right = snapshotBytes(b);
  assert.deepEqual([...left.keys()], [...right.keys()]);
  for (const [name, bytes] of left) assert.deepEqual(bytes, right.get(name), name);
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function treeBuffer(records, { terminate = true } = {}) {
  return Buffer.from(records.join('\0') + (terminate ? '\0' : ''), 'utf8');
}

function record({ mode = '100644', type = 'blob', id = '1'.repeat(40), size = 1, name = 'safe.txt' } = {}) {
  return `${mode} ${type} ${id}    ${size}\t${name}`;
}

function assertRejectedInventoryWithoutSideEffects(t, records, expectedCode = 'YATZY_SOURCE_UNSAFE_PATH') {
  const container = fs.mkdtempSync(path.join(os.tmpdir(), 'yatzy-source-inventory-'));
  const repositoryRoot = path.join(container, 'repository');
  fs.mkdirSync(repositoryRoot);
  t.after(() => fs.rmSync(container, { recursive: true, force: true }));
  const output = ownedOutput(t, 'path-portability-output');
  const sourceCommit = 'a'.repeat(40);
  const sourceTree = 'b'.repeat(40);
  const counters = { treeEnumerations: 0, blobMetadataReads: 0, blobPayloadReads: 0, payloadWrites: 0, promotions: 0 };
  const runner = (executable, args, options) => {
    assert.equal(executable, 'git');
    if (args[0] === 'rev-parse' && args.at(-1) === `${sourceCommit}^{commit}`) return { stdout: `${sourceCommit}\n` };
    if (args[0] === 'rev-parse' && args.at(-1) === `${sourceCommit}^{tree}`) return { stdout: `${sourceTree}\n` };
    if (args[0] === 'ls-tree') {
      counters.treeEnumerations += 1;
      return { stdout: options.encoding === 'buffer' ? treeBuffer(records) : treeBuffer(records).toString('utf8') };
    }
    if (args[0] === 'cat-file') {
      if (args[1] === '-s' || args[1] === '-t') counters.blobMetadataReads += 1;
      if (args[1] === 'blob') counters.blobPayloadReads += 1;
      throw new Error('Invalid inventory reached blob access.');
    }
    throw new Error(`Unexpected injected Git command: ${args.join(' ')}`);
  };
  assert.throws(() => createSourceSnapshotPlan({ repositoryRoot, sourceCommit, runner }), { code: expectedCode });
  assert.deepEqual(counters, { treeEnumerations: 1, blobMetadataReads: 0, blobPayloadReads: 0, payloadWrites: 0, promotions: 0 });
  assert.deepEqual(fs.readdirSync(output.root), []);
  return counters;
}

test('exact committed bytes, untracked exclusion, frozen identity, and deterministic manifests', t => {
  const fixture = fixtureRepository(t);
  const committedText = Buffer.from(git(fixture.root, ['show', `${fixture.commit}:src/text.txt`], 'buffer'));
  const committedBinary = Buffer.from(git(fixture.root, ['show', `${fixture.commit}:src/data.bin`], 'buffer'));
  const plan = createSourceSnapshotPlan({ repositoryRoot: fixture.root, sourceCommit: fixture.commit });

  put(fixture.root, 'src/text.txt', 'worktree\r\nchanged\r\n');
  put(fixture.root, 'src/data.bin', Buffer.from([9, 9, 9]));
  put(fixture.root, 'untracked.txt', 'untracked\n');
  put(fixture.root, 'ignored/secret.txt', 'ignored\n');
  put(fixture.root, 'untracked/nested/private.txt', 'nested\n');
  put(fixture.root, 'private-machine.json', '{"private":true}\n');
  for (const pdf of excludedPdfs) put(fixture.root, pdf, Buffer.from('%PDF-hostile'));

  const output = ownedOutput(t);
  const first = materializeSourceSnapshot({ plan, ownership: output.ownership, destination: path.join(output.root, 'snapshot-a'), manifestPath: path.join(output.root, 'manifest-a.json'), purpose: 'fixture-source-snapshot' });
  assert.deepEqual(fs.readFileSync(path.join(first.destination, 'src/text.txt')), committedText);
  assert.deepEqual(fs.readFileSync(path.join(first.destination, 'src/data.bin')), committedBinary);
  assert.equal(first.manifest.entries.find(entry => entry.path === 'src/text.txt').sha256, sha256(committedText));
  assert.equal(first.manifest.entries.find(entry => entry.path === 'src/data.bin').byteLength, committedBinary.length);
  for (const hostile of ['untracked.txt', 'ignored/secret.txt', 'untracked/nested/private.txt', 'private-machine.json', ...excludedPdfs]) {
    assert.equal(first.manifest.entries.some(entry => entry.path === hostile), false, hostile);
    assert.equal(fs.existsSync(path.join(first.destination, ...hostile.split('/'))), false, hostile);
  }

  put(fixture.root, 'later.txt', 'later commit\n');
  const laterCommit = commitAll(fixture.root, 'later worktree state');
  assert.notEqual(laterCommit, fixture.commit);
  const second = materializeSourceSnapshot({ plan, ownership: output.ownership, destination: path.join(output.root, 'snapshot-b'), manifestPath: path.join(output.root, 'manifest-b.json'), purpose: 'fixture-source-snapshot' });
  assertSameSnapshot(first.destination, second.destination);
  assert.deepEqual(fs.readFileSync(first.manifestPath), fs.readFileSync(second.manifestPath));
  assert.equal(second.manifest.sourceCommit, fixture.commit);
  assert.equal(second.manifest.sourceTree, fixture.tree);
  assert.equal(second.manifest.entryCount, second.manifest.entries.length);
  assert.equal(second.manifest.totalBytes, second.manifest.entries.reduce((sum, entry) => sum + entry.byteLength, 0));
  assert.deepEqual(second.manifest.entries.map(entry => entry.path), [...second.manifest.entries.map(entry => entry.path)].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b))));
  const manifestText = fs.readFileSync(second.manifestPath, 'utf8');
  assert.equal(manifestText.includes(fixture.container), false);
  assert.equal(/timestamp|createdAt|hostname|username|environment/iu.test(manifestText), false);
});

test('production rights policy is exact and requires the complete Java notice-bearing subtree', () => {
  const policy = readPublicSourcePolicy();
  const included = policy.entries.filter(entry => entry.included);
  const java = included.filter(entry => entry.path.startsWith(policy.completeSubtree.prefix));
  assert.equal(policy.defaultDisposition, 'exclude_unreviewed');
  assert.equal(included.length, 28);
  assert.equal(java.length, 27);
  assert.equal(included.filter(entry => entry.path === policy.requiredMetadata).length, 1);
  assert.equal(included.filter(entry => entry.path === policy.requiredNotice).length, 1);
  assert.equal(java.every(entry => entry.disposition === 'retained_third_party_mit' && entry.requiredNotice === policy.requiredNotice), true);
  for (const pdf of excludedPdfs) assert.deepEqual(policy.entries.find(entry => entry.path === pdf), { path: pdf, disposition: 'excluded_rights_unresolved', included: false, requiredNotice: null });
  assert.equal(policy.entries.some(entry => entry.path.endsWith('/')), false);
});

test('new, partial, and rights-unresolved research source trees fail before output', async t => {
  await t.test('new unreviewed tracked source', t => {
    const fixture = fixtureRepository(t);
    put(fixture.root, 'research/sources/new-source.txt', 'unreviewed\n');
    const commit = commitAll(fixture.root, 'new unreviewed source');
    assert.throws(() => createSourceSnapshotPlan({ repositoryRoot: fixture.root, sourceCommit: commit }), { code: 'YATZY_SOURCE_RIGHTS_DENIED' });
  });
  await t.test('partial Java subtree', t => {
    const fixture = fixtureRepository(t);
    const removed = readPublicSourcePolicy().entries.find(entry => entry.included && entry.path.startsWith('research/sources/optimalt-yatzy-source/src/')).path;
    fs.rmSync(path.join(fixture.root, ...removed.split('/')));
    const commit = commitAll(fixture.root, 'partial subtree');
    assert.throws(() => createSourceSnapshotPlan({ repositoryRoot: fixture.root, sourceCommit: commit }), { code: 'YATZY_SOURCE_RIGHTS_INCOMPLETE' });
  });
  await t.test('both unresolved PDFs tracked', t => {
    const fixture = fixtureRepository(t);
    for (const pdf of excludedPdfs) put(fixture.root, pdf, Buffer.from('%PDF-tracked'));
    const commit = commitAll(fixture.root, 'tracked excluded pdfs');
    assert.throws(() => createSourceSnapshotPlan({ repositoryRoot: fixture.root, sourceCommit: commit }), { code: 'YATZY_SOURCE_RIGHTS_DENIED' });
  });
});

test('tracked symlink and gitlink modes fail closed from real Git trees', async t => {
  await t.test('symlink mode', t => {
    const fixture = fixtureRepository(t);
    const target = put(fixture.root, 'link-target.txt', 'target\n');
    const blob = git(fixture.root, ['hash-object', '-w', target]).trim();
    git(fixture.root, ['update-index', '--add', '--cacheinfo', `120000,${blob},unsafe-link`]);
    git(fixture.root, ['commit', '-q', '-m', 'symlink entry']);
    const commit = git(fixture.root, ['rev-parse', 'HEAD']).trim();
    assert.throws(() => createSourceSnapshotPlan({ repositoryRoot: fixture.root, sourceCommit: commit }), { code: 'YATZY_SOURCE_UNSUPPORTED_ENTRY' });
  });
  await t.test('gitlink mode', t => {
    const fixture = fixtureRepository(t);
    git(fixture.root, ['update-index', '--add', '--cacheinfo', `160000,${fixture.commit},unsafe-gitlink`]);
    git(fixture.root, ['commit', '-q', '-m', 'gitlink entry']);
    const commit = git(fixture.root, ['rev-parse', 'HEAD']).trim();
    assert.throws(() => createSourceSnapshotPlan({ repositoryRoot: fixture.root, sourceCommit: commit }), { code: 'YATZY_SOURCE_UNSUPPORTED_ENTRY' });
  });
});

test('malformed modes, records, duplicates, case collisions, and unsafe paths fail before writing', () => {
  assert.throws(() => parseGitTreeOutput(treeBuffer([record({ mode: '100600' })])), { code: 'YATZY_SOURCE_UNSUPPORTED_ENTRY' });
  assert.throws(() => parseGitTreeOutput(treeBuffer([record({ type: 'tree' })])), { code: 'YATZY_SOURCE_UNSUPPORTED_ENTRY' });
  assert.throws(() => parseGitTreeOutput(Buffer.from('malformed\0')), { code: 'YATZY_SOURCE_TREE_MALFORMED' });
  assert.throws(() => parseGitTreeOutput(treeBuffer([record()], { terminate: false })), { code: 'YATZY_SOURCE_TREE_MALFORMED' });
  assert.throws(() => parseGitTreeOutput(treeBuffer([record({ name: 'same.txt' }), record({ id: '2'.repeat(40), name: 'same.txt' })])), { code: 'YATZY_SOURCE_DUPLICATE_PATH' });
  assert.throws(() => parseGitTreeOutput(treeBuffer([record({ name: 'Case.txt' }), record({ id: '2'.repeat(40), name: 'case.txt' })])), { code: 'YATZY_SOURCE_CASE_COLLISION' });
  for (const unsafe of ['../escape', 'C:/drive', 'a\\b', 'con/file', 'a//b', '/absolute', 'trailing./file']) {
    assert.throws(() => parseGitTreeOutput(treeBuffer([record({ name: unsafe })])), { code: 'YATZY_SOURCE_UNSAFE_PATH' }, unsafe);
  }
});

test('Windows path portability rejects invalid characters before blob extraction', async t => {
  for (const character of ['<', '>', '"', '|', '?', '*', ':']) {
    await t.test(`leaf U+${character.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')}`, t => {
      assertRejectedInventoryWithoutSideEffects(t, [record({ name: `leaf${character}name.txt` })]);
    });
    await t.test(`directory U+${character.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')}`, t => {
      assertRejectedInventoryWithoutSideEffects(t, [record({ name: `directory${character}name/file.txt` })]);
    });
  }
  const valid = "ordinary-()[]{}!@#$%^&+_=,;'`~.txt";
  assert.deepEqual(parseGitTreeOutput(treeBuffer([record({ name: valid })])).map(entry => entry.path), [valid]);
});

test('Windows path portability rejects controls and normalized reserved devices before blob extraction', async t => {
  for (const control of ['\u0001', '\u001f']) {
    await t.test(`control U+${control.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')}`, t => {
      assertRejectedInventoryWithoutSideEffects(t, [record({ name: `bad${control}name.txt` })]);
    });
  }
  await t.test('NUL at the raw parser boundary', t => {
    assertRejectedInventoryWithoutSideEffects(t, [record({ name: 'bad\0name.txt' })], 'YATZY_SOURCE_TREE_MALFORMED');
  });
  for (const name of ['CON', 'con.txt', 'PRN.log', 'AUX', 'NUL.data', 'COM1', 'com9.bin', 'LPT1', 'lpt9.txt']) {
    await t.test(`reserved leaf ${name}`, t => {
      assertRejectedInventoryWithoutSideEffects(t, [record({ name })]);
    });
    await t.test(`reserved directory ${name}`, t => {
      assertRejectedInventoryWithoutSideEffects(t, [record({ name: `${name}/file.txt` })]);
    });
  }
  for (const name of ['CON.', 'con.txt ', 'LPT9.data.', 'AUX .txt', 'NUL...log']) {
    await t.test(`reserved normalization ${JSON.stringify(name)}`, t => {
      assertRejectedInventoryWithoutSideEffects(t, [record({ name })]);
    });
  }
  for (const name of ['console.txt', 'com10.log', 'lpt10.data']) {
    assert.equal(parseGitTreeOutput(treeBuffer([record({ name })]))[0].path, name);
  }
});

test('Windows path portability rejects every case-folded prefix and file-directory alias before blob extraction', async t => {
  const collisions = [
    ['Research/Sources/one.txt', 'research/sources/two.txt'],
    ['alpha/Beta/one.txt', 'alpha/beta/two.txt'],
    ['alpha/Beta/Gamma/one.txt', 'alpha/Beta/gamma/two.txt'],
    ['Data', 'data/item.txt'],
    ['Data', 'Data/item.txt']
  ];
  for (const [first, second] of collisions) {
    await t.test(`${first} aliases ${second}`, t => {
      assertRejectedInventoryWithoutSideEffects(t, [record({ name: first }), record({ id: '2'.repeat(40), name: second })], 'YATZY_SOURCE_CASE_COLLISION');
    });
  }
  const shared = parseGitTreeOutput(treeBuffer([
    record({ name: 'alpha/Beta/one.txt' }),
    record({ id: '2'.repeat(40), name: 'alpha/Beta/two.txt' })
  ]));
  assert.deepEqual(shared.map(entry => entry.path), ['alpha/Beta/one.txt', 'alpha/Beta/two.txt']);
});

test('destination ownership rejects existing, escaping, and redirected targets without unrelated deletion', t => {
  const fixture = fixtureRepository(t);
  const plan = createSourceSnapshotPlan({ repositoryRoot: fixture.root, sourceCommit: fixture.commit });
  const output = ownedOutput(t);
  const existing = path.join(output.root, 'existing');
  fs.mkdirSync(existing);
  put(existing, 'unrelated.txt', 'preserve\n');
  assert.throws(() => materializeSourceSnapshot({ plan, ownership: output.ownership, destination: existing, manifestPath: path.join(output.root, 'existing.json'), purpose: 'destination-test' }), { code: 'YATZY_FS_UNEXPECTED_TARGET' });
  assert.equal(fs.readFileSync(path.join(existing, 'unrelated.txt'), 'utf8'), 'preserve\n');
  assert.throws(() => materializeSourceSnapshot({ plan, ownership: output.ownership, destination: path.join(output.container, 'escape'), manifestPath: path.join(output.container, 'escape.json'), purpose: 'destination-test' }), { code: 'YATZY_FS_ESCAPE' });

  const target = path.join(output.container, 'junction-target');
  fs.mkdirSync(target);
  const redirected = path.join(output.root, 'redirected');
  try {
    fs.symlinkSync(target, redirected, process.platform === 'win32' ? 'junction' : 'dir');
    assert.throws(() => materializeSourceSnapshot({ plan, ownership: output.ownership, destination: path.join(redirected, 'snapshot'), manifestPath: path.join(redirected, 'manifest.json'), purpose: 'destination-test' }), { code: 'YATZY_FS_REDIRECTION' });
  } catch (error) {
    if (!['EPERM', 'EACCES', 'UNKNOWN'].includes(error?.code)) throw error;
  }
  assert.equal(fs.readdirSync(output.root).some(name => name.startsWith('.source-snapshot-')), false);
});

test('official bounded source stage uses one frozen plan and exact package and research blobs', t => {
  const fixture = fixtureRepository(t);
  const committedPackage = Buffer.from(git(fixture.root, ['show', `${fixture.commit}:package.json`], 'buffer'));
  const plan = createSourceSnapshotPlan({ repositoryRoot: fixture.root, sourceCommit: fixture.commit });
  put(fixture.root, 'package.json', '{"name":"hostile-worktree"}\n');
  for (const pdf of excludedPdfs) put(fixture.root, pdf, Buffer.from('%PDF-untracked'));
  const output = ownedOutput(t);
  const runDir = ensureOwnedDir(output.ownership, path.join(output.root, 'run'), { mustBeNew: true });
  const result = prepareV3SourceStage({ ownership: output.ownership, runDir, sourcePlan: plan });
  assert.deepEqual(fs.readFileSync(path.join(runDir, 'package.json')), committedPackage);
  assert.equal(result.snapshot.manifest.sourceCommit, fixture.commit);
  assert.equal(result.research.manifest.entryCount, 28);
  assert.equal(fs.existsSync(path.join(runDir, 'research', 'sources', 'optimalt-yatzy-source', 'LICENSE')), true);
  for (const pdf of excludedPdfs) assert.equal(fs.existsSync(path.join(runDir, ...pdf.split('/'))), false);
  assert.throws(() => prepareV3SourceStage({ ownership: output.ownership, runDir: ensureOwnedDir(output.ownership, path.join(output.root, 'invalid-run'), { mustBeNew: true }), sourcePlan: {} }), { code: 'YATZY_SOURCE_PLAN_INVALID' });
  assert.deepEqual(fs.readdirSync(path.join(output.root, 'invalid-run')), []);
});

test('official bounded source stage removes every partial artifact after extraction failure', t => {
  const fixture = fixtureRepository(t);
  let blobCalls = 0;
  let failAfter = Number.POSITIVE_INFINITY;
  const runner = (executable, args, options) => {
    if (args[0] === 'cat-file' && args[1] === 'blob' && ++blobCalls > failAfter) {
      const error = new Error('injected extraction failure');
      error.code = 'YATZY_TEST_INJECTED';
      throw error;
    }
    return runControlledProcessSync(executable, args, options);
  };
  const plan = createSourceSnapshotPlan({ repositoryRoot: fixture.root, sourceCommit: fixture.commit, runner });
  failAfter = plan.entries.length * 2;
  const output = ownedOutput(t);
  const runDir = ensureOwnedDir(output.ownership, path.join(output.root, 'run'), { mustBeNew: true });
  assert.throws(() => prepareV3SourceStage({ ownership: output.ownership, runDir, sourcePlan: plan }), /injected extraction failure/);
  assert.deepEqual(fs.readdirSync(runDir), []);
});

test('paper staging accepts only verified generated research membership', t => {
  const fixture = fixtureRepository(t);
  const plan = createSourceSnapshotPlan({ repositoryRoot: fixture.root, sourceCommit: fixture.commit });
  const output = ownedOutput(t);
  const runDir = ensureOwnedDir(output.ownership, path.join(output.root, 'run'), { mustBeNew: true });
  prepareV3SourceStage({ ownership: output.ownership, runDir, sourcePlan: plan });
  put(runDir, 'hostile-unrelated.txt', 'not selected\n');
  const stage = path.join(output.root, 'paper');
  buildPaperStaging(runDir, stage, { sourcePlan: plan });
  assert.equal(fs.existsSync(path.join(stage, 'research', 'sources', 'SOURCE_METADATA.json')), true);
  assert.equal(fs.existsSync(path.join(stage, 'research', 'sources', 'optimalt-yatzy-source', 'LICENSE')), true);
  assert.equal(fs.existsSync(path.join(stage, 'hostile-unrelated.txt')), false);
  const redirectTarget = ensureOwnedDir(output.ownership, path.join(output.root, 'redirect-target'), { mustBeNew: true });
  put(redirectTarget, 'private.txt', 'private\n');
  const redirect = path.join(runDir, 'research', 'sources', 'redirected');
  fs.symlinkSync(redirectTarget, redirect, process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => buildPaperStaging(runDir, path.join(output.root, 'paper-redirected'), { sourcePlan: plan }), { code: 'YATZY_SOURCE_VERIFY_FAILED' });
  assert.equal(fs.existsSync(path.join(output.root, 'paper-redirected')), false);
  fs.rmdirSync(redirect);
  assert.equal(fs.existsSync(path.join(redirectTarget, 'private.txt')), true);
  put(runDir, 'research/sources/new-source.txt', 'hostile\n');
  assert.throws(() => buildPaperStaging(runDir, path.join(output.root, 'paper-invalid'), { sourcePlan: plan }), { code: 'YATZY_SOURCE_VERIFY_FAILED' });
  assert.equal(fs.existsSync(path.join(output.root, 'paper-invalid')), false);
});

test('dossier bundle uses extracted Git objects, shared rights policy, and a generated manifest', async t => {
  const fixture = fixtureRepository(t);
  put(fixture.root, 'src/text.txt', 'modified worktree\n');
  put(fixture.root, 'research/sources/private-untracked.txt', 'private\n');
  for (const pdf of excludedPdfs) put(fixture.root, pdf, Buffer.from('%PDF-untracked'));
  const output = ownedOutput(t, 'run');
  put(output.root, 'START_HERE.html', '<h1>start</h1>\n');
  put(output.root, 'master_results.json', '{}\n');
  put(output.root, 'values.bin', Buffer.from([1, 2]));
  put(output.root, 'bounds.bin', Buffer.from([3, 4]));
  let captured = null;
  const archiveWriter = async (bundlePath, entries) => {
    captured = entries.map(entry => entry.name);
    fs.writeFileSync(bundlePath, 'bounded archive fixture\n');
    return { entryCount: entries.length };
  };
  const result = await buildResearchBundle({
    projectRoot: fixture.root,
    runDir: output.root,
    master: {},
    copyToDownloads: false,
    sourceCommit: fixture.commit,
    archiveWriter,
    archiveVerifier: () => ({ passed: true })
  });
  assert.equal(result.downloadsCopy, null);
  assert.equal(captured.includes('START_HERE.html'), true);
  assert.equal(captured.includes('exact_model/values.bin'), true);
  assert.equal(captured.includes('generated/source_snapshot_manifest.json'), true);
  assert.equal(captured.includes('source_snapshot/src/text.txt'), true);
  assert.equal(captured.some(name => name.includes('private-untracked') || excludedPdfs.some(pdf => name.endsWith(pdf))), false);
  assert.equal(fs.readFileSync(path.join(output.root, 'export', 'source_snapshot', 'src', 'text.txt'), 'utf8'), 'committed\nline\n');
});

test('evidence register retains claim labels without implying bundled excluded PDFs', () => {
  const register = claimToEvidenceRegister();
  assert.deepEqual(Object.keys(register), ['canonicalValue', 'policyReproducibility', 'decisionValues', 'upperEstimands', 'pairedComparisons', 'historicalCompatibility']);
  const text = JSON.stringify(register);
  for (const pdf of excludedPdfs) assert.equal(text.includes(pdf), false);
  assert.equal(register.historicalCompatibility.includes('research/sources/SOURCE_METADATA.json'), true);
  assert.equal(register.historicalCompatibility.includes('research/sources/optimalt-yatzy-source'), true);
  assert.equal(/permission|redistribut/iu.test(text), false);
});

test('production structural scan has no broad worktree source or research membership copy', () => {
  const archive = fs.readFileSync(path.join(projectRoot, 'engine/src/v3/archive.mjs'), 'utf8');
  const official = fs.readFileSync(path.join(projectRoot, 'engine/src/v3/official-pipeline.mjs'), 'utf8');
  const dossier = fs.readFileSync(path.join(projectRoot, 'engine/src/analysis/dossier.mjs'), 'utf8');
  assert.equal(/snapshotSource|fs\.cpSync\(projectRoot/u.test(archive + official + dossier), false);
  assert.equal(/function\s+copyResearch|sourceRoots\s*=|relativeEntries\(r,`source_snapshot/u.test(official + dossier), false);
  assert.equal(/KTH_2012_optimal_yatzy\.pdf|Alga_Yatzy_rules_manual\.pdf/u.test(official + dossier), false);
  assert.equal(official.includes('materializeResearchSources'), true);
  assert.equal(dossier.includes('materializeSourceSnapshot'), true);
  assert.equal(archive.includes('verifyResearchSources'), true);
  assert.equal(archive.includes("for (const dir of ['analysis', 'tables', 'figures', 'schemas', 'data-dictionary', 'decision', 'structural', 'estimands', 'paired', 'historical', 'research'])"), true);
});

test('current production policy file and generated schema remain valid JSON', () => {
  const policy = JSON.parse(fs.readFileSync(path.join(projectRoot, 'engine/src/v3/public-source-policy.json'), 'utf8'));
  assert.equal(policy.schemaVersion, 1);
  assert.equal(policy.entries.length, 30);
  assert.deepEqual(policy, readPublicSourcePolicy());
});
