import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const OWNED_ROOTS = new WeakSet();

function pathFailure(code, message) {
  const error = new Error(`Filesystem ${message}`);
  error.code = code;
  throw error;
}

function pathKey(value) {
  const normalized = path.resolve(value);
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function samePath(a, b) {
  return pathKey(a) === pathKey(b);
}

function isAncestorOrSame(root, target) {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function assertAbsolutePath(value, role) {
  if (typeof value !== 'string' || !value.trim()) pathFailure('YATZY_FS_INVALID_PATH', `${role} must be a nonempty string`);
  if (value !== value.trim() || value.includes('\0')) pathFailure('YATZY_FS_INVALID_PATH', `${role} is malformed`);
  if (process.platform === 'win32') {
    const winValue = value.replaceAll('/', '\\');
    if (winValue.startsWith('\\\\?\\') || winValue.startsWith('\\\\.\\') || winValue.startsWith('\\??\\')) {
      pathFailure('YATZY_FS_INVALID_PATH', `${role} uses a prohibited device path form`);
    }
  }
  if (!path.isAbsolute(value)) pathFailure('YATZY_FS_INVALID_PATH', `${role} must be absolute`);
  const resolved = path.resolve(value);
  const parsed = path.parse(resolved);
  const rawRoot = path.parse(value).root;
  for (const component of value.slice(rawRoot.length).split(process.platform === 'win32' ? /[\\/]/ : /\//).filter(Boolean)) {
    if (component === '.' || component === '..') pathFailure('YATZY_FS_INVALID_PATH', `${role} contains an ambiguous component`);
    if (process.platform === 'win32' && (component.includes(':') || /[. ]$/.test(component))) {
      pathFailure('YATZY_FS_INVALID_PATH', `${role} contains an ambiguous Windows component`);
    }
  }
  if (!parsed.root) pathFailure('YATZY_FS_INVALID_PATH', `${role} has no filesystem root`);
  return resolved;
}

function inspectExistingChain(absolute) {
  const parsed = path.parse(absolute);
  const components = path.relative(parsed.root, absolute).split(path.sep).filter(Boolean);
  let current = parsed.root;
  let nearestExisting = parsed.root;
  let nearestCanonical;
  let finalStat = null;
  for (let index = -1; index < components.length; index += 1) {
    if (index >= 0) current = path.join(current, components[index]);
    let stat;
    try {
      stat = fs.lstatSync(current);
    } catch (error) {
      if (error?.code === 'ENOENT') {
        return { exists: false, nearestExisting, nearestCanonical, stat: null };
      }
      pathFailure('YATZY_FS_UNPROVABLE', 'path containment could not be proven');
    }
    if (stat.isSymbolicLink()) pathFailure('YATZY_FS_REDIRECTION', 'path contains symbolic-link or junction redirection');
    let canonical;
    try {
      canonical = fs.realpathSync.native(current);
    } catch {
      pathFailure('YATZY_FS_UNPROVABLE', 'canonical path identity could not be proven');
    }
    if (!samePath(canonical, current)) pathFailure('YATZY_FS_REDIRECTION', 'path contains canonical redirection');
    nearestExisting = current;
    nearestCanonical = canonical;
    finalStat = stat;
  }
  return { exists: true, nearestExisting, nearestCanonical, stat: finalStat };
}

function assertOutputRootPolicy(root, { protectedRoots = [], forbiddenTrees = [] } = {}) {
  if (samePath(root, path.parse(root).root)) pathFailure('YATZY_FS_BROAD_ROOT', 'output root is a filesystem or volume root');
  const home = assertAbsolutePath(os.homedir(), 'home root');
  const allProtected = [home, ...protectedRoots.map(value => assertAbsolutePath(value, 'protected root'))];
  for (const protectedRoot of allProtected) {
    if (isAncestorOrSame(root, protectedRoot)) pathFailure('YATZY_FS_PROTECTED_ROOT', 'output root is protected or an ancestor of a protected root');
    let canonicalProtected = null;
    try { canonicalProtected = fs.realpathSync.native(protectedRoot); } catch {}
    if (canonicalProtected && isAncestorOrSame(root, canonicalProtected)) pathFailure('YATZY_FS_PROTECTED_ROOT', 'output root overlaps a canonical protected root');
  }
  for (const forbiddenTreeValue of forbiddenTrees) {
    const forbiddenTree = assertAbsolutePath(forbiddenTreeValue, 'forbidden tree');
    if (isAncestorOrSame(root, forbiddenTree) || isAncestorOrSame(forbiddenTree, root)) {
      pathFailure('YATZY_FS_PROTECTED_ROOT', 'output root overlaps a forbidden project tree');
    }
    let canonicalForbidden = null;
    try { canonicalForbidden = fs.realpathSync.native(forbiddenTree); } catch {}
    if (canonicalForbidden && (isAncestorOrSame(root, canonicalForbidden) || isAncestorOrSame(canonicalForbidden, root))) {
      pathFailure('YATZY_FS_PROTECTED_ROOT', 'output root overlaps a canonical forbidden project tree');
    }
  }
}

function createMissingRootComponents(root, inspection) {
  let current = inspection.nearestExisting;
  const missing = path.relative(current, root).split(path.sep).filter(Boolean);
  for (const component of missing) {
    const parentInspection = inspectExistingChain(current);
    if (!parentInspection.exists || !parentInspection.stat?.isDirectory()) pathFailure('YATZY_FS_UNPROVABLE', 'output-root parent is not a proven directory');
    const next = path.join(current, component);
    try {
      fs.mkdirSync(next);
    } catch (error) {
      if (error?.code !== 'EEXIST') pathFailure('YATZY_FS_CREATE_FAILED', 'output-root component could not be created');
    }
    const createdInspection = inspectExistingChain(next);
    if (!createdInspection.exists || !createdInspection.stat?.isDirectory()) pathFailure('YATZY_FS_UNPROVABLE', 'created output-root component is not a proven directory');
    current = next;
  }
}

function assertOwnership(ownership) {
  if (!ownership || typeof ownership !== 'object' || !OWNED_ROOTS.has(ownership)) {
    pathFailure('YATZY_FS_INVALID_OWNERSHIP', 'operation requires a claimed output root');
  }
  return ownership;
}

export function assertRelativePath(value) {
  if (typeof value !== 'string' || !value.length) throw new Error('Relative path must be a nonempty string');
  const normalized = value.replaceAll('\\', '/');
  if (path.posix.isAbsolute(normalized) || path.win32.isAbsolute(value)) throw new Error('Absolute path is prohibited: ' + value);
  if (normalized.includes('\0') || normalized.split('/').some(part => part === '..' || part === '.' || part === '')) throw new Error('Unsafe relative path: ' + value);
  return normalized;
}

export function assertLexicalContainment(root, target, { allowRoot = true } = {}) {
  const resolvedRoot = assertAbsolutePath(root, 'owned root');
  const resolvedTarget = assertAbsolutePath(target, 'target path');
  const relative = path.relative(resolvedRoot, resolvedTarget);
  if (relative === '') {
    if (!allowRoot) pathFailure('YATZY_FS_BROAD_ROOT', 'target may not be the owned root itself');
    return resolvedTarget;
  }
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    pathFailure('YATZY_FS_ESCAPE', 'target escapes the owned root');
  }
  return resolvedTarget;
}

export function resolveWithin(root, relative) {
  const safe = assertRelativePath(relative);
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(resolvedRoot, ...safe.split('/'));
  return assertLexicalContainment(resolvedRoot, resolved, { allowRoot: false });
}

export function claimOutputRoot(value, options = {}) {
  const root = assertAbsolutePath(value, 'output root');
  assertOutputRootPolicy(root, options);
  let inspection = inspectExistingChain(root);
  if (!inspection.exists) {
    createMissingRootComponents(root, inspection);
    inspection = inspectExistingChain(root);
  }
  if (!inspection.exists || !inspection.stat?.isDirectory()) pathFailure('YATZY_FS_INVALID_PATH', 'output root must be a directory');
  assertOutputRootPolicy(inspection.nearestCanonical, options);
  const ownership = Object.freeze({ root, canonicalRoot: inspection.nearestCanonical });
  OWNED_ROOTS.add(ownership);
  return ownership;
}

export function assertOwnedPath(ownershipValue, target, { allowRoot = false, mustExist = null, type = null } = {}) {
  const ownership = assertOwnership(ownershipValue);
  const resolved = assertLexicalContainment(ownership.root, target, { allowRoot });
  const rootInspection = inspectExistingChain(ownership.root);
  if (!rootInspection.exists || !rootInspection.stat?.isDirectory() || !samePath(rootInspection.nearestCanonical, ownership.canonicalRoot)) {
    pathFailure('YATZY_FS_REDIRECTION', 'owned root identity changed');
  }
  const inspection = inspectExistingChain(resolved);
  if (!isAncestorOrSame(ownership.canonicalRoot, inspection.nearestCanonical)) pathFailure('YATZY_FS_ESCAPE', 'canonical target escapes the owned root');
  if (mustExist === true && !inspection.exists) pathFailure('YATZY_FS_MISSING_TARGET', 'required owned target is missing');
  if (mustExist === false && inspection.exists) pathFailure('YATZY_FS_UNEXPECTED_TARGET', 'owned target already exists');
  if (inspection.exists && type === 'file' && !inspection.stat?.isFile()) pathFailure('YATZY_FS_UNEXPECTED_TARGET', 'owned target is not a file');
  if (inspection.exists && type === 'directory' && !inspection.stat?.isDirectory()) pathFailure('YATZY_FS_UNEXPECTED_TARGET', 'owned target is not a directory');
  return resolved;
}

export function resolveOwnedPath(ownership, relative, options = {}) {
  const safe = assertRelativePath(relative);
  return assertOwnedPath(ownership, path.resolve(ownership.root, ...safe.split('/')), options);
}

export function relativePosix(root, file) {
  const resolvedRoot = path.resolve(root), resolvedFile = assertLexicalContainment(resolvedRoot, path.resolve(file), { allowRoot: false });
  const rel = path.relative(resolvedRoot, resolvedFile).split(path.sep).join('/');
  return assertRelativePath(rel);
}
