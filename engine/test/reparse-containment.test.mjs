import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertOwnedPath, claimOutputRoot } from '../src/v3/paths.mjs';
import { ensureOwnedDir } from '../src/util/fs.mjs';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const outerWorkspace = path.dirname(projectRoot);

function removeLink(link) {
  try {
    if (fs.lstatSync(link).isSymbolicLink()) fs.unlinkSync(link);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
}

test('dedicated output roots reject broad and protected locations without mutation', () => {
  const container = fs.mkdtempSync(path.join(os.tmpdir(), 'yatzy-root-policy-'));
  try {
    const protectedAuthority = path.join(container, 'immutable-authority');
    fs.mkdirSync(protectedAuthority);
    const ownership = claimOutputRoot(path.join(container, 'dedicated-output'));
    assert.ok(fs.statSync(ownership.root).isDirectory());
    assert.throws(() => claimOutputRoot(''), { code: 'YATZY_FS_INVALID_PATH' });
    assert.throws(() => claimOutputRoot('relative-output'), { code: 'YATZY_FS_INVALID_PATH' });
    assert.throws(() => claimOutputRoot(path.parse(container).root), { code: 'YATZY_FS_BROAD_ROOT' });
    assert.throws(() => claimOutputRoot(os.homedir()), { code: 'YATZY_FS_PROTECTED_ROOT' });
    assert.throws(() => claimOutputRoot(projectRoot, { forbiddenTrees: [projectRoot] }), { code: 'YATZY_FS_PROTECTED_ROOT' });
    assert.throws(() => claimOutputRoot(outerWorkspace, { protectedRoots: [outerWorkspace] }), { code: 'YATZY_FS_PROTECTED_ROOT' });
    assert.throws(() => claimOutputRoot(protectedAuthority, { protectedRoots: [protectedAuthority] }), { code: 'YATZY_FS_PROTECTED_ROOT' });
    assert.throws(() => claimOutputRoot(container, { protectedRoots: [protectedAuthority] }), { code: 'YATZY_FS_PROTECTED_ROOT' });
    if (process.platform === 'win32') {
      assert.throws(() => claimOutputRoot('\\\\server\\share\\'), { code: 'YATZY_FS_BROAD_ROOT' });
      assert.throws(() => claimOutputRoot('\\\\?\\C:\\unsafe'), { code: 'YATZY_FS_INVALID_PATH' });
      assert.throws(() => claimOutputRoot('\\\\.\\C:\\unsafe'), { code: 'YATZY_FS_INVALID_PATH' });
    }
  } finally {
    fs.rmSync(container, { recursive: true, force: true });
  }
});

test('canonical containment rejects symlink and junction redirection including missing descendants', t => {
  const container = fs.mkdtempSync(path.join(os.tmpdir(), 'yatzy-reparse-'));
  const links = [];
  try {
    const outside = path.join(container, 'outside');
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, 'sentinel.txt'), 'outside remains\n');
    const ownership = claimOutputRoot(path.join(container, 'owned'));

    if (process.platform === 'win32') {
      const junction = path.join(ownership.root, 'junction-escape');
      fs.symlinkSync(outside, junction, 'junction');
      links.push(junction);
      assert.throws(() => assertOwnedPath(ownership, junction), { code: 'YATZY_FS_REDIRECTION' });
      assert.throws(() => assertOwnedPath(ownership, path.join(junction, 'missing', 'child')), { code: 'YATZY_FS_REDIRECTION' });

      const fileTarget = path.join(outside, 'sentinel.txt'), fileLink = path.join(ownership.root, 'file-link');
      try {
        fs.symlinkSync(fileTarget, fileLink, 'file');
        links.push(fileLink);
        assert.throws(() => assertOwnedPath(ownership, fileLink), { code: 'YATZY_FS_REDIRECTION' });
      } catch (error) {
        if (!['EPERM', 'EACCES', 'UNKNOWN'].includes(error?.code)) throw error;
        t.diagnostic(`Windows file-symlink fixture refused by platform (${error.code}); the mandatory junction canonical-redirection fixture passed.`);
      }

      const directoryLink = path.join(ownership.root, 'directory-link');
      try {
        fs.symlinkSync(outside, directoryLink, 'dir');
        links.push(directoryLink);
        assert.throws(() => assertOwnedPath(ownership, directoryLink), { code: 'YATZY_FS_REDIRECTION' });
      } catch (error) {
        if (!['EPERM', 'EACCES', 'UNKNOWN'].includes(error?.code)) throw error;
        t.diagnostic(`Windows directory-symlink fixture refused by platform (${error.code}); the mandatory junction canonical-redirection fixture passed.`);
      }

      const linkedRoot = path.join(container, 'linked-output-root');
      fs.symlinkSync(outside, linkedRoot, 'junction');
      links.push(linkedRoot);
      assert.throws(() => claimOutputRoot(linkedRoot), { code: 'YATZY_FS_REDIRECTION' });
      t.diagnostic('Node exposes junctions as symbolic links; other reparse tags without an observable link or canonical-path change remain fail-closed when identity cannot be proven.');
    } else {
      const symlink = path.join(ownership.root, 'symlink-escape');
      fs.symlinkSync(outside, symlink, 'dir');
      links.push(symlink);
      assert.throws(() => assertOwnedPath(ownership, symlink), { code: 'YATZY_FS_REDIRECTION' });
      assert.throws(() => assertOwnedPath(ownership, path.join(symlink, 'missing', 'child')), { code: 'YATZY_FS_REDIRECTION' });
    }
    assert.equal(fs.readFileSync(path.join(outside, 'sentinel.txt'), 'utf8'), 'outside remains\n');
  } finally {
    for (const link of links.reverse()) removeLink(link);
    fs.rmSync(container, { recursive: true, force: true });
  }
});

test('late recheck rejects a parent replaced by canonical redirection', () => {
  const container = fs.mkdtempSync(path.join(os.tmpdir(), 'yatzy-late-recheck-'));
  let redirectedParent;
  try {
    const outside = path.join(container, 'outside');
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, 'sentinel.txt'), 'unchanged\n');
    const ownership = claimOutputRoot(path.join(container, 'owned'));
    redirectedParent = ensureOwnedDir(ownership, path.join(ownership.root, 'parent'));
    const target = path.join(redirectedParent, 'not-yet-created');
    assert.equal(assertOwnedPath(ownership, target), target);
    fs.rmdirSync(redirectedParent);
    fs.symlinkSync(outside, redirectedParent, process.platform === 'win32' ? 'junction' : 'dir');
    assert.throws(() => ensureOwnedDir(ownership, target), { code: 'YATZY_FS_REDIRECTION' });
    assert.equal(fs.existsSync(path.join(outside, 'not-yet-created')), false);
    assert.equal(fs.readFileSync(path.join(outside, 'sentinel.txt'), 'utf8'), 'unchanged\n');
  } finally {
    if (redirectedParent) removeLink(redirectedParent);
    fs.rmSync(container, { recursive: true, force: true });
  }
});
