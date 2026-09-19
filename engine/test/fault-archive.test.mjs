import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  auditZip as auditSharedZip,
  createZip as createSharedZip,
  extractZip
} from '../src/util/zip.mjs';
import {
  auditZip,
  cleanRoomTest,
  createZip,
  listZip
} from '../src/v3/archive.mjs';
import { buildResearchBundle } from '../src/analysis/dossier.mjs';
import { artifactInventory } from '../src/v3/experiment-manifest.mjs';
import { auditInventory } from '../src/v3/quality-gates.mjs';
import { auditRunFormats } from '../src/v3/format-audit.mjs';
import { runControlledProcessSync } from '../src/util/child-process.mjs';
import { readPublicSourcePolicy } from '../src/v3/source-snapshot.mjs';
import { buildZipFixture } from './zip-fixture-builder.mjs';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

function temporary(t, prefix = 'yatzy-archive-fault-') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function put(root, relative, bytes) {
  const file = path.join(root, ...relative.split('/'));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, bytes);
  return file;
}

function git(root, args) {
  return runControlledProcessSync('git', args, {
    cwd: root,
    timeoutMs: 30_000,
    maxOutputBytes: 16 * 1024 * 1024,
    encoding: 'utf8'
  }).stdout.trim();
}

function sourceFixtureRepository(t) {
  const container = temporary(t, 'yatzy-archive-source-');
  const root = path.join(container, 'repository');
  fs.mkdirSync(root);
  git(root, ['init', '-q']);
  git(root, ['config', 'user.name', 'Phase 9C2C Fixture']);
  git(root, ['config', 'user.email', 'fixture.invalid@example.invalid']);
  git(root, ['config', 'core.autocrlf', 'false']);
  put(root, '.gitignore', 'ignored/\n*.pdf\nprivate-*.json\n');
  put(root, 'README.md', 'fixture repository\n');
  put(root, 'package.json', '{"name":"fixture","private":true}\n');
  put(root, 'package-lock.json', '{"name":"fixture","lockfileVersion":3}\n');
  put(root, 'src/text.txt', 'committed\n');
  for (const decision of readPublicSourcePolicy().entries.filter(entry => entry.included)) {
    put(root, decision.path, `fixture:${decision.path}\n`);
  }
  git(root, ['add', '-A']);
  git(root, ['commit', '-q', '-m', 'fixture base']);
  return { root, commit: git(root, ['rev-parse', 'HEAD']) };
}

function archiveTemporaryNames(root, outputName) {
  return fs.readdirSync(root).filter(name => name.startsWith(`.${outputName}.archive-`));
}

test('invalid extraction has zero destination, staging, escape, or sentinel side effects', async t => {
  const root = temporary(t), sentinel = path.join(root, 'sentinel.txt');
  fs.writeFileSync(sentinel, 'unchanged');
  const unsafe = path.join(root, 'unsafe.zip');
  fs.writeFileSync(unsafe, buildZipFixture([{ name: '../escape.txt', data: 'private' }]).buffer);
  const unsafeDestination = path.join(root, 'unsafe-output');
  await assert.rejects(() => extractZip(unsafe, unsafeDestination), error => {
    assert.equal(error.code, 'YATZY_ARCHIVE_INVALID_PATH');
    assert.equal(error.message.includes(root), false);
    assert.equal(error.message.includes('private'), false);
    return true;
  });
  assert.equal(fs.existsSync(unsafeDestination), false);
  assert.equal(fs.existsSync(path.join(root, 'escape.txt')), false);

  const corrupt = path.join(root, 'corrupt.zip');
  fs.writeFileSync(corrupt, buildZipFixture([{ name: 'safe/a.txt', data: 'payload', crc: 1 }]).buffer);
  const corruptDestination = path.join(root, 'corrupt-output');
  await assert.rejects(() => extractZip(corrupt, corruptDestination), { code: 'YATZY_ARCHIVE_PAYLOAD_INVALID' });
  assert.equal(fs.existsSync(corruptDestination), false);
  assert.equal(fs.readdirSync(root).some(name => name.startsWith('.archive-extract-')), false);
  assert.equal(fs.readFileSync(sentinel, 'utf8'), 'unchanged');
});

test('selected extraction validates corrupt payloads outside the selected prefix', async t => {
  const root = temporary(t), archive = path.join(root, 'selected.zip'), destination = path.join(root, 'selected-output');
  fs.writeFileSync(archive, buildZipFixture([
    { name: 'source_snapshot/good.txt', data: 'good' },
    { name: 'private/bad.txt', data: 'bad', crc: 2 }
  ]).buffer);
  await assert.rejects(() => extractZip(archive, destination, { prefix: 'source_snapshot/' }), { code: 'YATZY_ARCHIVE_PAYLOAD_INVALID' });
  assert.equal(fs.existsSync(destination), false);
});

test('representative invalid structure, path, type, feature, limit, and payload classes never promote', async t => {
  const root = temporary(t), sentinel = put(root, 'sentinel.txt', 'unchanged');
  const cases = [
    ['structure', Buffer.from('not a ZIP archive'), {}, 'YATZY_ARCHIVE_INVALID_STRUCTURE'],
    ['path', buildZipFixture([{ name: 'a/../escape', data: 'x' }]).buffer, {}, 'YATZY_ARCHIVE_INVALID_PATH'],
    ['type', buildZipFixture([{ name: 'link', data: 'x', unixMode: 0o120777 }]).buffer, {}, 'YATZY_ARCHIVE_SPECIAL_ENTRY'],
    ['feature', buildZipFixture([{ name: 'a', data: 'x', method: 12, localMethod: 12 }]).buffer, {}, 'YATZY_ARCHIVE_UNSUPPORTED_FEATURE'],
    ['limit', buildZipFixture([{ name: 'too-long', data: 'x' }]).buffer, { limits: { filenameBytes: 4 } }, 'YATZY_ARCHIVE_LIMIT_EXCEEDED'],
    ['payload', buildZipFixture([{ name: 'a', data: 'x', crc: 2 }]).buffer, {}, 'YATZY_ARCHIVE_PAYLOAD_INVALID']
  ];
  for (const [name, bytes, options, code] of cases) await t.test(name, async () => {
    const archive = put(root, `${name}.zip`, bytes), destination = path.join(root, `${name}-output`);
    await assert.rejects(() => extractZip(archive, destination, options), { code });
    assert.equal(fs.existsSync(destination), false);
    assert.equal(fs.readdirSync(root).some(item => item.startsWith('.archive-extract-')), false);
    assert.equal(fs.readFileSync(sentinel, 'utf8'), 'unchanged');
  });
});

test('missing selected prefix fails before destination promotion', async t => {
  const root = temporary(t), archive = put(root, 'safe.zip', buildZipFixture([{ name: 'other/file.txt', data: 'x' }]).buffer), outputParent = path.join(root, 'unclaimed-parent'), destination = path.join(outputParent, 'missing-prefix');
  await assert.rejects(() => extractZip(archive, destination, { prefix: 'source_snapshot/' }), { code: 'YATZY_ARCHIVE_REQUIRED_ENTRY_MISSING' });
  assert.equal(fs.existsSync(outputParent), false);
  assert.equal(fs.existsSync(destination), false);
});

test('selected directory prefixes reject impostors before ownership, staging, payload output, or promotion', async t => {
  const root = temporary(t), sentinel = put(root, 'sentinel.txt', 'unchanged');
  const cases = [
    ['regular-exact-key', { name: 'source_snapshot', data: 'impostor' }],
    ['boundary-directory', { name: 'source_snapshot-evil/', data: '' }],
    ['filename-prefix', { name: 'source_snapshot.txt', data: 'impostor' }]
  ];
  for (const [name, entry] of cases) await t.test(name, async () => {
    const archive = put(root, `${name}.zip`, buildZipFixture([entry]).buffer);
    const outputParent = path.join(root, `${name}-unclaimed`), destination = path.join(outputParent, 'output');
    await assert.rejects(() => extractZip(archive, destination, { prefix: 'source_snapshot/' }), { code: 'YATZY_ARCHIVE_REQUIRED_ENTRY_MISSING' });
    const observed = {
      outputRootClaimCount: fs.existsSync(outputParent) ? 1 : 0,
      stagingCreationCount: fs.existsSync(outputParent) && fs.readdirSync(outputParent).some(item => item.startsWith('.archive-extract-')) ? 1 : 0,
      payloadOutputFileCreationCount: fs.existsSync(outputParent) && fs.readdirSync(outputParent, { recursive: true }).some(item => fs.statSync(path.join(outputParent, item)).isFile()) ? 1 : 0,
      promotionCount: fs.existsSync(destination) ? 1 : 0
    };
    assert.deepEqual(observed, { outputRootClaimCount: 0, stagingCreationCount: 0, payloadOutputFileCreationCount: 0, promotionCount: 0 });
    assert.equal(fs.readFileSync(sentinel, 'utf8'), 'unchanged');
  });
});

test('selected directory prefixes extract explicit and implicit directories exactly', async t => {
  await t.test('explicit empty directory', async () => {
    const root = temporary(t), archive = put(root, 'explicit.zip', buildZipFixture([{ name: 'source_snapshot/', data: '' }]).buffer), destination = path.join(root, 'explicit-output');
    const result = await extractZip(archive, destination, { prefix: 'source_snapshot/' });
    assert.equal(result.passed, true);
    const extracted = path.join(destination, 'source_snapshot');
    assert.equal(fs.statSync(extracted).isDirectory(), true);
    assert.deepEqual(fs.readdirSync(extracted), []);
  });

  await t.test('implicit directory descendant', async () => {
    const root = temporary(t), bytes = Buffer.from([0, 1, 2, 253, 254, 255]);
    const archive = put(root, 'implicit.zip', buildZipFixture([{ name: 'source_snapshot/file.bin', data: bytes }]).buffer), destination = path.join(root, 'implicit-output');
    const result = await extractZip(archive, destination, { prefix: 'source_snapshot/' });
    assert.equal(result.passed, true);
    assert.deepEqual(fs.readFileSync(path.join(destination, 'source_snapshot', 'file.bin')), bytes);
  });
});

test('required-entry audit and selected extraction share one directory-prefix predicate', () => {
  const source = fs.readFileSync(path.join(projectRoot, 'engine/src/util/zip.mjs'), 'utf8');
  assert.equal((source.match(/function matchesDirectoryPrefix\(/gu) ?? []).length, 1);
  assert.equal((source.match(/matchesDirectoryPrefix\(/gu) ?? []).length, 3);
  assert.match(source, /entries\.some\(entry => matchesDirectoryPrefix\(entry, item\.key\)\)/u);
  assert.match(source, /return entry => matchesDirectoryPrefix\(entry, parsed\.key\)/u);
});

test('reparse or symbolic-link destination ancestors fail before staging', async t => {
  const root = temporary(t), actual = path.join(root, 'actual'), redirect = path.join(root, 'redirect');
  fs.mkdirSync(actual);
  try {
    fs.symlinkSync(actual, redirect, process.platform === 'win32' ? 'junction' : 'dir');
  } catch (error) {
    if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error?.code)) return t.skip(`link creation unavailable: ${error.code}`);
    throw error;
  }
  const archive = path.join(root, 'safe.zip');
  fs.writeFileSync(archive, buildZipFixture([{ name: 'safe.txt', data: 'safe' }]).buffer);
  await assert.rejects(() => extractZip(archive, path.join(redirect, 'output')), { code: 'YATZY_FS_REDIRECTION' });
  assert.deepEqual(fs.readdirSync(actual), []);
});

test('creator fault injection leaves no final or temporary archive at every stage', async t => {
  for (const stage of ['write', 'finalize', 'verify', 'promote']) {
    await t.test(stage, async () => {
      const root = temporary(t, `yatzy-create-${stage}-`), source = put(root, 'source.txt', 'payload'), output = path.join(root, 'final.zip');
      await assert.rejects(() => createSharedZip(output, [{ source, name: 'source.txt' }], {
        faultInjector(actual) { if (actual === stage) throw new Error(`injected ${stage}`); }
      }), { code: 'YATZY_ARCHIVE_CREATION_FAILED' });
      assert.equal(fs.existsSync(output), false);
      assert.deepEqual(archiveTemporaryNames(root, path.basename(output)), []);
      assert.equal(fs.readFileSync(source, 'utf8'), 'payload');
    });
  }
});

test('creator refuses replacement and preserves an existing final archive byte-for-byte', async t => {
  const root = temporary(t), source = put(root, 'source.txt', 'new payload'), output = put(root, 'final.zip', 'existing final');
  await assert.rejects(() => createSharedZip(output, [{ source, name: 'source.txt' }]), { code: 'YATZY_FS_UNEXPECTED_TARGET' });
  assert.equal(fs.readFileSync(output, 'utf8'), 'existing final');
  assert.deepEqual(archiveTemporaryNames(root, path.basename(output)), []);
});

test('creator binds each planned source identity before streaming', async t => {
  const root = temporary(t), source = put(root, 'source.txt', 'approved'), backup = path.join(root, 'source-approved.txt'), output = path.join(root, 'identity.zip');
  await assert.rejects(() => createSharedZip(output, [{ source, name: 'source.txt' }], {
    faultInjector(stage) {
      if (stage === 'write') {
        fs.renameSync(source, backup);
        fs.writeFileSync(source, 'replacement');
      }
    }
  }), error => {
    assert.equal(error.code, 'YATZY_ARCHIVE_SOURCE_INVALID');
    assert.equal(error.cause, undefined);
    assert.equal(error.message.includes(root), false);
    return true;
  });
  assert.equal(fs.existsSync(output), false);
  assert.deepEqual(archiveTemporaryNames(root, path.basename(output)), []);
});

test('creator enforces archive and compressed output ceilings while streaming', async t => {
  for (const [name, limits] of [['archive', { archiveFileBytes: 80 }], ['compressed', { compressedBytesPerEntry: 8 }]]) await t.test(name, async () => {
    const root = temporary(t, `yatzy-create-limit-${name}-`), source = put(root, 'source.bin', Buffer.alloc(64, 7)), output = path.join(root, 'limited.zip');
    await assert.rejects(() => createSharedZip(output, [{ source, name: 'source.bin' }], { limits }), { code: 'YATZY_ARCHIVE_LIMIT_EXCEEDED' });
    assert.equal(fs.existsSync(output), false);
    assert.deepEqual(archiveTemporaryNames(root, path.basename(output)), []);
  });
});

test('bounded official archive layouts use shared create, list, audit, and clean-room extraction', async t => {
  const root = temporary(t), fullSource = path.join(root, 'full'), paperSource = path.join(root, 'paper');
  put(fullSource, 'canonical/primary/policy.bin', Buffer.from([1, 2, 3]));
  put(fullSource, 'source_snapshot/engine/test/tiny.test.mjs', "import test from 'node:test'; import assert from 'node:assert/strict'; test('ok',()=>assert.equal(1,1));\n");
  put(paperSource, 'canonical_identity.json', '{}\n');
  put(paperSource, 'figures/figure.txt', 'figure\n');
  const full = path.join(root, 'full.zip'), paper = path.join(root, 'paper.zip');
  createZip(fullSource, full); createZip(paperSource, paper);
  assert.deepEqual(listZip(full), [
    'canonical/',
    'canonical/primary/',
    'canonical/primary/policy.bin',
    'source_snapshot/',
    'source_snapshot/engine/',
    'source_snapshot/engine/test/',
    'source_snapshot/engine/test/tiny.test.mjs'
  ]);
  assert.equal((await auditZip(full, ['source_snapshot/', 'canonical/primary/policy.bin'])).passed, true);
  assert.equal((await auditZip(paper, ['canonical_identity.json', 'figures/'])).passed, true);
  const clean = path.join(root, 'clean-room');
  assert.equal(cleanRoomTest(full, clean).passed, true);
  assert.equal(fs.existsSync(path.join(clean, 'source_snapshot', 'engine', 'test', 'tiny.test.mjs')), true);
});

test('bounded research bundle uses production shared writer and verifier', async t => {
  const fixture = sourceFixtureRepository(t), root = temporary(t, 'yatzy-research-bundle-'), runDir = path.join(root, 'run');
  fs.mkdirSync(runDir);
  put(runDir, 'START_HERE.html', '<h1>start</h1>\n');
  put(runDir, 'master_results.json', '{}\n');
  put(runDir, 'values.bin', Buffer.from([1, 2]));
  put(runDir, 'bounds.bin', Buffer.from([3, 4]));
  const result = await buildResearchBundle({
    projectRoot: fixture.root,
    runDir,
    master: {},
    copyToDownloads: false,
    sourceCommit: fixture.commit
  });
  assert.equal(result.downloadsCopy, null);
  const audit = await auditSharedZip(result.bundlePath, ['START_HERE.html', 'checksums.sha256', 'exact_model/values.bin', 'source_snapshot/']);
  assert.equal(audit.passed, true);
  assert.equal(listZip(result.bundlePath).some(name => name.endsWith('.pdf')), false);
});

test('production archive trust scan finds no external list or extract command', () => {
  const files = [
    'engine/src/util/zip.mjs',
    'engine/src/v3/archive.mjs',
    'engine/src/v3/official-pipeline.mjs',
    'engine/src/analysis/dossier.mjs'
  ];
  const sources = Object.fromEntries(files.map(file => [file, fs.readFileSync(path.join(projectRoot, ...file.split('/')), 'utf8')]));
  for (const [file, source] of Object.entries(sources)) {
    assert.equal(/\btar(?:\.exe)?\b|\b(?:unzip|7z)(?:\.exe)?\b|['"]-[tx]f['"]/iu.test(source), false, file);
  }
  assert.match(sources['engine/src/v3/archive.mjs'], /util\/zip\.mjs/u);
  assert.match(sources['engine/src/analysis/dossier.mjs'], /util\/zip\.mjs/u);
  assert.equal(/validatePathName|INVALID_PATH.*filename/u.test(sources['engine/src/v3/archive.mjs']), false);
  assert.equal(/validatePathName|INVALID_PATH.*filename/u.test(sources['engine/src/analysis/dossier.mjs']), false);
});

test('V3 adapter preserves shared archive policy codes without external-process diagnostics', async t => {
  const root = temporary(t), archive = put(root, 'unsafe.zip', buildZipFixture([{ name: '../escape', data: 'x' }]).buffer);
  const clean = path.join(root, 'clean');
  assert.throws(() => cleanRoomTest(archive, clean), { code: 'YATZY_ARCHIVE_INVALID_PATH' });
  assert.equal(fs.existsSync(clean), false);
});

test('archive reopens and rejects missing required entries', async t => {
  const root = temporary(t), source = path.join(root, 'source'); fs.mkdirSync(source); put(source, 'a.txt', 'ok');
  const zip = path.join(root, 'archive.zip'); createZip(source, zip);
  assert.equal((await auditZip(zip, ['a.txt'])).passed, true);
  await assert.rejects(() => auditZip(zip, ['missing.txt']), { code: 'YATZY_ARCHIVE_REQUIRED_ENTRY_MISSING' });
});

test('inventory detects post-hash corruption', async t => {
  const root = temporary(t); put(root, 'a.txt', 'before'); const inventory = await artifactInventory(root); put(root, 'a.txt', 'after');
  await assert.rejects(() => auditInventory(root, inventory));
});

test('format audit stops on corrupted analysis, figure, and binary boundaries', t => {
  for (const [name, data] of [['bad.json', '{'], ['bad.csv', 'header-only'], ['bad.svg', 'not svg'], ['bad.png', 'not png'], ['bad.bin', 'BADMAGIC']]) {
    const root = temporary(t, 'yatzy-format-'); put(root, name, data); assert.throws(() => auditRunFormats(root), /Format audit failed/u);
  }
});
