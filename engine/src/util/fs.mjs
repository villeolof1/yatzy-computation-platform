import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { assertOwnedPath } from '../v3/paths.mjs';

const OWNED_STAGING = new WeakMap();

function fsFailure(code, message) {
  const error = new Error(`Filesystem ${message}`);
  error.code = code;
  throw error;
}

function lstatOrNull(target) {
  try {
    return fs.lstatSync(target);
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    fsFailure('YATZY_FS_UNPROVABLE', 'target state could not be proven');
  }
}

function freshSiblingPath(file, label = 'staging') {
  return path.join(path.dirname(file), `.${path.basename(file)}.${label}-${randomUUID()}`);
}

function cleanupOwnedStaging(ownership, staged) {
  const registered = OWNED_STAGING.get(ownership);
  if (!registered?.has(staged)) return;
  const stat = lstatOrNull(staged);
  if (stat) removeOwnedPath(ownership, staged, { recursive: stat.isDirectory(), allowMissing: true });
  registered.delete(staged);
}

export function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Flush a completed file through a writable descriptor.
 *
 * On Windows, fsync on a descriptor opened read-only can fail with EPERM.
 * Opening the already-written file as r+ keeps the durability guarantee while
 * remaining portable across Windows, macOS, and Linux.
 */
export function fsyncFile(file) {
  let fd;
  try {
    fd = fs.openSync(file, 'r+');
    fs.fsyncSync(fd);
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

export function writeJsonAtomic(file, value) {
  ensureDir(path.dirname(file));
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`);
  fsyncFile(tmp);
  fs.renameSync(tmp, file);
}

export function writeTextAtomic(file, text) {
  ensureDir(path.dirname(file));
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, text);
  fsyncFile(tmp);
  fs.renameSync(tmp, file);
}

export function readJson(file, fallback = null) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { return fallback; }
}

export function safeUnlink(file) {
  try { fs.unlinkSync(file); } catch {}
}

export function copyFileAtomic(src, dst) {
  ensureDir(path.dirname(dst));
  const tmp = `${dst}.tmp-${process.pid}`;
  fs.copyFileSync(src, tmp);
  fsyncFile(tmp);
  fs.renameSync(tmp, dst);
}

export function listFilesRecursive(root) {
  const out = [];
  function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) out.push(full);
    }
  }
  if (fs.existsSync(root)) walk(root);
  return out.sort();
}

export function ensureOwnedDir(ownership, dir, { mustBeNew = false } = {}) {
  const target = assertOwnedPath(ownership, dir, { allowRoot: true });
  const initial = lstatOrNull(target);
  if (initial) {
    assertOwnedPath(ownership, target, { allowRoot: true, mustExist: true, type: 'directory' });
    if (mustBeNew) fsFailure('YATZY_FS_UNEXPECTED_TARGET', 'owned directory already exists');
    return target;
  }
  const relative = path.relative(ownership.root, target);
  let current = ownership.root;
  for (const component of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, component);
    const stat = lstatOrNull(current);
    if (!stat) {
      assertOwnedPath(ownership, current, { mustExist: false });
      try {
        fs.mkdirSync(current);
      } catch (error) {
        if (error?.code !== 'EEXIST') fsFailure('YATZY_FS_CREATE_FAILED', 'owned directory could not be created');
      }
    }
    assertOwnedPath(ownership, current, { mustExist: true, type: 'directory' });
  }
  return assertOwnedPath(ownership, target, { mustExist: true, type: 'directory' });
}

export function createOwnedTempDir(ownership, parent, prefix = 'staging') {
  if (typeof prefix !== 'string' || !/^[A-Za-z0-9_-]+$/.test(prefix)) fsFailure('YATZY_FS_INVALID_PATH', 'temporary directory prefix is malformed');
  const safeParent = ensureOwnedDir(ownership, parent);
  for (let attempt = 0; attempt < 64; attempt += 1) {
    const target = path.join(safeParent, `.${prefix}-${randomUUID()}`);
    assertOwnedPath(ownership, target, { mustExist: false });
    try {
      fs.mkdirSync(target);
    } catch (error) {
      if (error?.code === 'EEXIST') continue;
      fsFailure('YATZY_FS_CREATE_FAILED', 'owned temporary directory could not be created');
    }
    const safeTarget = assertOwnedPath(ownership, target, { mustExist: true, type: 'directory' });
    let registered = OWNED_STAGING.get(ownership);
    if (!registered) { registered = new Set(); OWNED_STAGING.set(ownership, registered); }
    registered.add(safeTarget);
    return safeTarget;
  }
  fsFailure('YATZY_FS_CREATE_FAILED', 'fresh owned temporary directory could not be allocated');
}

export function removeOwnedPath(ownership, target, { recursive = false, allowMissing = true, type = null } = {}) {
  const safeTarget = assertOwnedPath(ownership, target, { allowRoot: false });
  const stat = lstatOrNull(safeTarget);
  if (!stat) {
    if (allowMissing) return false;
    fsFailure('YATZY_FS_MISSING_TARGET', 'owned removal target is missing');
  }
  if (type === 'file' && !stat.isFile()) fsFailure('YATZY_FS_UNEXPECTED_TARGET', 'owned removal target is not a file');
  if (type === 'directory' && !stat.isDirectory()) fsFailure('YATZY_FS_UNEXPECTED_TARGET', 'owned removal target is not a directory');
  assertOwnedPath(ownership, safeTarget, { mustExist: true, type: stat.isDirectory() ? 'directory' : 'file' });
  if (stat.isDirectory() && !recursive) fs.rmdirSync(safeTarget);
  else fs.rmSync(safeTarget, { recursive: stat.isDirectory() && recursive, force: false });
  return true;
}

export function promoteOwnedPath(ownership, staged, destination, { replaceExisting = false, cleanupOnFailure = true } = {}) {
  let safeStaged;
  try {
    safeStaged = assertOwnedPath(ownership, staged, { mustExist: true });
    if (!OWNED_STAGING.get(ownership)?.has(safeStaged)) fsFailure('YATZY_FS_UNEXPECTED_TARGET', 'promotion source is not a registered fresh staging path');
    const safeDestination = assertOwnedPath(ownership, destination);
    if (path.relative(path.dirname(safeStaged), path.dirname(safeDestination)) !== '') {
      fsFailure('YATZY_FS_CROSS_VOLUME', 'promotion requires same-parent staging');
    }
    if (path.relative(safeStaged, safeDestination) === '') fsFailure('YATZY_FS_INVALID_PATH', 'promotion source and destination must differ');
    const stagedStat = lstatOrNull(safeStaged);
    const destinationStat = lstatOrNull(safeDestination);
    if (destinationStat && !replaceExisting) fsFailure('YATZY_FS_UNEXPECTED_TARGET', 'promotion destination already exists');
    if (destinationStat && stagedStat?.isDirectory() !== destinationStat.isDirectory()) {
      fsFailure('YATZY_FS_UNEXPECTED_TARGET', 'promotion destination type differs from staged output');
    }
    assertOwnedPath(ownership, safeStaged, { mustExist: true, type: stagedStat?.isDirectory() ? 'directory' : 'file' });
    assertOwnedPath(ownership, safeDestination, destinationStat ? { mustExist: true, type: destinationStat.isDirectory() ? 'directory' : 'file' } : { mustExist: false });
    fs.renameSync(safeStaged, safeDestination);
    OWNED_STAGING.get(ownership)?.delete(safeStaged);
    return assertOwnedPath(ownership, safeDestination, { mustExist: true, type: stagedStat?.isDirectory() ? 'directory' : 'file' });
  } catch (error) {
    if (cleanupOnFailure && safeStaged) {
      try {
        cleanupOwnedStaging(ownership, safeStaged);
      } catch (cleanupError) {
        error.cleanupError = cleanupError.message;
      }
    }
    throw error;
  }
}

function writeOwnedAtomic(ownership, file, writer, { replaceExisting = true } = {}) {
  const destination = assertOwnedPath(ownership, file);
  ensureOwnedDir(ownership, path.dirname(destination));
  const staged = freshSiblingPath(destination);
  assertOwnedPath(ownership, staged, { mustExist: false });
  let fd;
  try {
    fd = fs.openSync(staged, 'wx');
    let registered = OWNED_STAGING.get(ownership);
    if (!registered) { registered = new Set(); OWNED_STAGING.set(ownership, registered); }
    registered.add(staged);
    writer(fd, staged);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    return promoteOwnedPath(ownership, staged, destination, { replaceExisting, cleanupOnFailure: true });
  } catch (error) {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch {}
    }
    try { cleanupOwnedStaging(ownership, staged); } catch {}
    throw error;
  }
}

export function writeJsonAtomicOwned(ownership, file, value, options = {}) {
  return writeOwnedAtomic(ownership, file, fd => fs.writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`, 'utf8'), options);
}

export function writeTextAtomicOwned(ownership, file, text, options = {}) {
  return writeOwnedAtomic(ownership, file, fd => fs.writeFileSync(fd, text, 'utf8'), options);
}

export function copyFileAtomicOwned(ownership, src, dst, options = {}) {
  const destination = assertOwnedPath(ownership, dst);
  ensureOwnedDir(ownership, path.dirname(destination));
  const staged = freshSiblingPath(destination, 'copy');
  assertOwnedPath(ownership, staged, { mustExist: false });
  let fd;
  try {
    fd = fs.openSync(staged, 'wx');
    fs.closeSync(fd);
    fd = undefined;
    let registered = OWNED_STAGING.get(ownership);
    if (!registered) { registered = new Set(); OWNED_STAGING.set(ownership, registered); }
    registered.add(staged);
    fs.copyFileSync(src, staged);
    fsyncFile(staged);
    return promoteOwnedPath(ownership, staged, destination, { replaceExisting: options.replaceExisting ?? true, cleanupOnFailure: true });
  } catch (error) {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch {}
    }
    try { cleanupOwnedStaging(ownership, staged); } catch {}
    throw error;
  }
}
