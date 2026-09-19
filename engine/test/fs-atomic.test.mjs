import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { claimOutputRoot } from '../src/v3/paths.mjs';
import { copyFileAtomic, copyFileAtomicOwned, createOwnedTempDir, ensureOwnedDir, promoteOwnedPath, removeOwnedPath, writeJsonAtomic, writeTextAtomic, writeTextAtomicOwned } from '../src/util/fs.mjs';

test('atomic writers fsync through writable descriptors', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'yatzy-fsync-'));
  try {
    const json = path.join(dir, 'state.json');
    const text = path.join(dir, 'note.txt');
    const copy = path.join(dir, 'copy.txt');
    writeJsonAtomic(json, { ok: true });
    writeTextAtomic(text, 'durable\n');
    copyFileAtomic(text, copy);
    assert.deepEqual(JSON.parse(fs.readFileSync(json, 'utf8')), { ok: true });
    assert.equal(fs.readFileSync(copy, 'utf8'), 'durable\n');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('owned filesystem helpers contain creation removal and atomic promotion', () => {
  const container = fs.mkdtempSync(path.join(os.tmpdir(), 'yatzy-owned-fs-'));
  try {
    const root = path.join(container, 'owned-output');
    const ownership = claimOutputRoot(root);
    const nested = ensureOwnedDir(ownership, path.join(root, 'nested', 'child'));
    assert.ok(fs.statSync(nested).isDirectory());

    const atomic = path.join(nested, 'atomic.txt');
    writeTextAtomicOwned(ownership, atomic, 'first\n', { replaceExisting: false });
    writeTextAtomicOwned(ownership, atomic, 'second\n');
    assert.equal(fs.readFileSync(atomic, 'utf8'), 'second\n');
    const copied = path.join(nested, 'copied.txt');
    copyFileAtomicOwned(ownership, atomic, copied, { replaceExisting: false });
    assert.equal(fs.readFileSync(copied, 'utf8'), 'second\n');

    const staged = createOwnedTempDir(ownership, nested, 'promotion');
    fs.writeFileSync(path.join(staged, 'payload.txt'), 'promoted\n');
    const promoted = path.join(nested, 'promoted');
    promoteOwnedPath(ownership, staged, promoted);
    assert.equal(fs.readFileSync(path.join(promoted, 'payload.txt'), 'utf8'), 'promoted\n');

    const existing = ensureOwnedDir(ownership, path.join(nested, 'existing'));
    fs.writeFileSync(path.join(existing, 'prior.txt'), 'prior\n');
    const arbitraryStage = ensureOwnedDir(ownership, path.join(nested, 'caller-provided'));
    assert.throws(() => promoteOwnedPath(ownership, arbitraryStage, path.join(nested, 'arbitrary-destination')), { code: 'YATZY_FS_UNEXPECTED_TARGET' });
    assert.ok(fs.statSync(arbitraryStage).isDirectory());
    const unexpectedStage = createOwnedTempDir(ownership, nested, 'unexpected');
    assert.throws(() => promoteOwnedPath(ownership, unexpectedStage, existing), { code: 'YATZY_FS_UNEXPECTED_TARGET' });
    assert.equal(fs.readFileSync(path.join(existing, 'prior.txt'), 'utf8'), 'prior\n');
    assert.equal(fs.existsSync(unexpectedStage), false);

    const previous = ensureOwnedDir(ownership, path.join(nested, 'previous'));
    fs.writeFileSync(path.join(previous, 'valid.txt'), 'valid previous output\n');
    const failingStage = createOwnedTempDir(ownership, nested, 'failing');
    fs.writeFileSync(path.join(failingStage, 'new.txt'), 'replacement\n');
    assert.throws(() => promoteOwnedPath(ownership, failingStage, previous, { replaceExisting: true }));
    assert.equal(fs.readFileSync(path.join(previous, 'valid.txt'), 'utf8'), 'valid previous output\n');
    assert.equal(fs.existsSync(failingStage), false);

    const outside = path.join(container, 'outside.txt');
    fs.writeFileSync(outside, 'outside\n');
    assert.throws(() => removeOwnedPath(ownership, outside), { code: 'YATZY_FS_ESCAPE' });
    assert.throws(() => removeOwnedPath(ownership, root, { recursive: true }), { code: 'YATZY_FS_BROAD_ROOT' });
    assert.equal(fs.readFileSync(outside, 'utf8'), 'outside\n');
    assert.equal(removeOwnedPath(ownership, promoted, { recursive: true, allowMissing: false, type: 'directory' }), true);
    assert.equal(fs.existsSync(promoted), false);
  } finally {
    fs.rmSync(container, { recursive: true, force: true });
  }
});
