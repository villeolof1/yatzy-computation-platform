import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { PipelineManager, PUBLIC_SMOKE_PROFILE_ID } from './pipeline/manager.mjs';
import { createStateIndex } from './solver/state-index.mjs';
import { readTables } from './solver/table-format.mjs';
import { PolicyEngine } from './solver/query.mjs';
import { countsToDice, diceToCounts, CATEGORY_NAMES } from './solver/scoring.mjs';

const CONTROL_TOKEN_HEADER = 'X-Yatzy-Control-Token';
const MAX_JSON_BODY_BYTES = 65_536;
const LOOPBACK_HOST = '127.0.0.1';
const here = path.dirname(fileURLToPath(import.meta.url));
const defaultProjectRoot = path.resolve(here, '..', '..');
const defaultWebRoot = path.join(defaultProjectRoot, 'web');

const FIXED_ARTIFACTS = Object.freeze({
  'start-here': Object.freeze({
    relative: 'START_HERE.html',
    name: 'START_HERE.html',
    viewUrl: '/run/start-here'
  }),
  'dossier-html': Object.freeze({
    relative: 'Yatzy_Research_Evidence_Dossier.html',
    name: 'Yatzy_Research_Evidence_Dossier.html',
    viewUrl: '/run/dossier-html'
  }),
  'dossier-pdf': Object.freeze({
    relative: 'Yatzy_Research_Evidence_Dossier.pdf',
    name: 'Yatzy_Research_Evidence_Dossier.pdf'
  }),
  'master-results': Object.freeze({
    relative: 'master_results.json',
    name: 'master_results.json'
  }),
  verification: Object.freeze({
    relative: 'verification.json',
    name: 'verification.json'
  }),
  values: Object.freeze({
    relative: 'values.bin',
    name: 'values.bin'
  }),
  bounds: Object.freeze({
    relative: 'bounds.bin',
    name: 'bounds.bin'
  })
});

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
  }
}

function fail(status, message) {
  throw new HttpError(status, message);
}

function sameFilesystemPath(left, right) {
  const normalize = value => {
    let normalized = path.resolve(value);
    const root = path.parse(normalized).root;
    while (normalized.length > root.length && normalized.endsWith(path.sep)) {
      normalized = normalized.slice(0, -1);
    }
    return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
  };
  return normalize(left) === normalize(right);
}

function isContained(root, target, allowRoot = false) {
  const relative = path.relative(root, target);
  if (relative === '') return allowRoot;
  return relative !== '..'
    && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative);
}

function rawHeaderValues(req, name) {
  const wanted = name.toLowerCase();
  const values = [];
  for (let index = 0; index < req.rawHeaders.length; index += 2) {
    if (req.rawHeaders[index].toLowerCase() === wanted) values.push(req.rawHeaders[index + 1]);
  }
  return values;
}

function validateHost(req, server) {
  const address = server.address();
  if (!address || typeof address === 'string' || !Number.isInteger(address.port)) {
    fail(403, 'Forbidden');
  }
  const values = rawHeaderValues(req, 'host');
  if (values.length !== 1) fail(403, 'Forbidden');
  const allowed = new Set([
    `127.0.0.1:${address.port}`,
    `localhost:${address.port}`
  ]);
  if (!allowed.has(values[0])) fail(403, 'Forbidden');
  return values[0];
}

function parseRequestTarget(rawTarget) {
  if (typeof rawTarget !== 'string'
    || !rawTarget.startsWith('/')
    || rawTarget.startsWith('//')
    || rawTarget.includes('#')) {
    fail(400, 'Malformed request');
  }
  const queryIndex = rawTarget.indexOf('?');
  const rawPath = queryIndex < 0 ? rawTarget : rawTarget.slice(0, queryIndex);
  let pathname;
  try {
    pathname = decodeURIComponent(rawPath);
  } catch {
    fail(400, 'Malformed request');
  }
  if (!pathname.startsWith('/')
    || pathname.startsWith('//')
    || pathname.includes('\\')
    || /[\u0000-\u001f\u007f]/u.test(pathname)) {
    fail(403, 'Forbidden');
  }
  const segments = pathname.split('/').slice(1);
  if (segments.some(segment => segment === '.' || segment === '..' || /^[A-Za-z]:/u.test(segment))) {
    fail(403, 'Forbidden');
  }
  return { pathname };
}

function isProtectedPath(pathname) {
  return pathname.startsWith('/api/') || pathname.startsWith('/run/');
}

function enforceFetchMetadata(req, protectedPath) {
  const values = rawHeaderValues(req, 'sec-fetch-site');
  if (!protectedPath || values.length === 0) return false;
  if (values.length !== 1 || values[0] !== 'same-origin') fail(403, 'Forbidden');
  return true;
}

function enforcePostOrigin(req, authority, fetchMetadataPresent) {
  const values = rawHeaderValues(req, 'origin');
  if (values.length > 1) fail(403, 'Forbidden');
  if (fetchMetadataPresent && values.length !== 1) fail(403, 'Forbidden');
  if (values.length === 1 && values[0] !== `http://${authority}`) fail(403, 'Forbidden');
}

function validControlToken(req, expected) {
  const values = rawHeaderValues(req, CONTROL_TOKEN_HEADER);
  const received = Buffer.from(values.length === 1 ? values[0] : '', 'utf8');
  const candidate = Buffer.alloc(expected.length);
  received.copy(candidate, 0, 0, candidate.length);
  const equal = timingSafeEqual(expected, candidate);
  return values.length === 1 && received.length === expected.length && equal;
}

function drainRequest(req) {
  if (!req.readableEnded && !req.destroyed) req.resume();
}

function validatePostHeaders(req) {
  const encodings = rawHeaderValues(req, 'content-encoding');
  if (encodings.length > 1
    || (encodings.length === 1 && encodings[0].trim().toLowerCase() !== 'identity')) {
    fail(415, 'Unsupported media type');
  }

  const contentTypes = rawHeaderValues(req, 'content-type');
  if (contentTypes.length !== 1
    || !/^application\/json(?:\s*;\s*charset\s*=\s*utf-8)?$/iu.test(contentTypes[0].trim())) {
    fail(415, 'Unsupported media type');
  }

  const lengths = rawHeaderValues(req, 'content-length');
  if (lengths.length > 1) fail(400, 'Malformed request');
  if (lengths.length === 1) {
    if (!/^(?:0|[1-9][0-9]*)$/u.test(lengths[0])) fail(400, 'Malformed request');
    const declared = Number(lengths[0]);
    if (!Number.isSafeInteger(declared)) fail(400, 'Malformed request');
    if (declared > MAX_JSON_BODY_BYTES) fail(413, 'Request body too large');
  }
}

async function readJsonObjectBody(req) {
  validatePostHeaders(req);
  const chunks = [];
  let total = 0;

  await new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      req.off('data', onData);
      req.off('end', onEnd);
      req.off('error', onError);
      req.off('aborted', onAborted);
    };
    const settle = (callback, value) => {
      if (settled) return;
      settled = true;
      cleanup();
      callback(value);
    };
    const onData = chunk => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      total += buffer.length;
      if (total > MAX_JSON_BODY_BYTES) {
        chunks.length = 0;
        req.pause();
        settle(reject, new HttpError(413, 'Request body too large'));
        drainRequest(req);
        return;
      }
      chunks.push(buffer);
    };
    const onEnd = () => settle(resolve);
    const onError = () => settle(reject, new HttpError(400, 'Malformed request'));
    const onAborted = () => settle(reject, new HttpError(400, 'Malformed request'));
    req.on('data', onData);
    req.once('end', onEnd);
    req.once('error', onError);
    req.once('aborted', onAborted);
  });

  if (total === 0) return {};
  let value;
  try {
    value = JSON.parse(Buffer.concat(chunks, total).toString('utf8'));
  } catch {
    fail(400, 'Malformed JSON');
  } finally {
    chunks.length = 0;
  }
  if (value === null || Array.isArray(value) || typeof value !== 'object') {
    fail(400, 'Invalid request object');
  }
  return value;
}

function securityHeaders({ protectedResource = false, html = false, cacheControl } = {}) {
  const headers = {
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer'
  };
  if (protectedResource) headers['cross-origin-resource-policy'] = 'same-origin';
  if (cacheControl) headers['cache-control'] = cacheControl;
  if (html) {
    headers['x-frame-options'] = 'DENY';
    headers['content-security-policy'] = "frame-ancestors 'none'";
  }
  return headers;
}

function writeJson(res, status, value, extraHeaders = {}) {
  if (res.headersSent || res.destroyed) return;
  const body = Buffer.from(JSON.stringify(value));
  res.writeHead(status, {
    ...securityHeaders({ protectedResource: true, cacheControl: 'no-store' }),
    'content-type': 'application/json; charset=utf-8',
    'content-length': body.length,
    ...extraHeaders
  });
  res.end(body);
}

function contentType(file) {
  const extension = path.extname(file).toLowerCase();
  return {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.json': 'application/json; charset=utf-8',
    '.pdf': 'application/pdf',
    '.zip': 'application/zip'
  }[extension] || 'application/octet-stream';
}

function validateRootDirectory(root) {
  if (typeof root !== 'string' || !path.isAbsolute(root)) fail(404, 'Not found');
  const resolved = path.resolve(root);
  let stat;
  let real;
  try {
    stat = fs.lstatSync(resolved);
    if (stat.isSymbolicLink() || !stat.isDirectory()) fail(404, 'Not found');
    real = fs.realpathSync.native(resolved);
  } catch (error) {
    if (error instanceof HttpError) throw error;
    if (['ELOOP', 'EINVAL'].includes(error?.code)) fail(403, 'Forbidden');
    fail(404, 'Not found');
  }
  if (!sameFilesystemPath(resolved, real)) fail(403, 'Forbidden');
  return { resolved, real };
}

function relativeParts(relative) {
  if (typeof relative !== 'string'
    || relative.length === 0
    || path.isAbsolute(relative)
    || path.win32.isAbsolute(relative)
    || relative.includes('\\')
    || relative.includes('\u0000')) {
    fail(403, 'Forbidden');
  }
  const parts = relative.split('/');
  if (parts.some(part => part.length === 0
    || part === '.'
    || part === '..'
    || /^[A-Za-z]:/u.test(part))) {
    fail(403, 'Forbidden');
  }
  return parts;
}

function validateContainedFile(root, relative) {
  const rootIdentity = validateRootDirectory(root);
  const parts = relativeParts(relative);
  const target = path.resolve(rootIdentity.resolved, ...parts);
  if (!isContained(rootIdentity.resolved, target)) fail(403, 'Forbidden');

  let current = rootIdentity.resolved;
  for (let index = 0; index < parts.length; index += 1) {
    current = path.join(current, parts[index]);
    let stat;
    let real;
    try {
      stat = fs.lstatSync(current);
      if (stat.isSymbolicLink()) fail(403, 'Forbidden');
      real = fs.realpathSync.native(current);
    } catch (error) {
      if (error instanceof HttpError) throw error;
      if (['ELOOP', 'EINVAL'].includes(error?.code)) fail(403, 'Forbidden');
      fail(404, 'Not found');
    }
    const expectedReal = path.join(rootIdentity.real, ...parts.slice(0, index + 1));
    if (!isContained(rootIdentity.real, real)
      || !sameFilesystemPath(real, expectedReal)
      || (index < parts.length - 1 && !stat.isDirectory())
      || (index === parts.length - 1 && !stat.isFile())) {
      fail(index === parts.length - 1 && !stat.isFile() ? 404 : 403, 'Forbidden');
    }
  }

  const stat = fs.lstatSync(target);
  if (!stat.isFile()) fail(404, 'Not found');
  return { root: rootIdentity, relative, target, stat };
}

function comparableIdentity(stat) {
  return Number.isFinite(stat.ino) && stat.ino !== 0;
}

function sameOpenedIdentity(validated, opened) {
  if (!comparableIdentity(validated) || !comparableIdentity(opened)) return true;
  if (process.platform === 'win32') return validated.ino === opened.ino;
  return validated.dev === opened.dev && validated.ino === opened.ino;
}

async function openContainedFile(root, relative) {
  validateContainedFile(root, relative);
  const validated = validateContainedFile(root, relative);
  const noFollow = process.platform === 'win32' ? 0 : (fs.constants.O_NOFOLLOW || 0);
  let handle;
  try {
    handle = await fs.promises.open(validated.target, fs.constants.O_RDONLY | noFollow);
    const openedStat = await handle.stat();
    if (!openedStat.isFile()) fail(404, 'Not found');
    if (!sameOpenedIdentity(validated.stat, openedStat)) fail(403, 'Forbidden');
    return { handle, stat: openedStat, validated };
  } catch (error) {
    if (handle) await handle.close().catch(() => {});
    if (error instanceof HttpError) throw error;
    if (['ELOOP', 'EINVAL'].includes(error?.code)) fail(403, 'Forbidden');
    fail(404, 'Not found');
  }
}

async function readContainedJson(root, relative) {
  const opened = await openContainedFile(root, relative);
  try {
    const text = await opened.handle.readFile({ encoding: 'utf8' });
    return JSON.parse(text);
  } catch (error) {
    if (error instanceof SyntaxError) fail(404, 'Not found');
    throw error;
  } finally {
    await opened.handle.close().catch(() => {});
  }
}

function safeDownloadName(name) {
  return typeof name === 'string'
    && /^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(name)
    && !name.includes('..');
}

function fixedArtifactDescriptor(status, id) {
  const definition = FIXED_ARTIFACTS[id];
  if (!definition || !status?.runDir) return null;
  try {
    const validated = validateContainedFile(status.runDir, definition.relative);
    return {
      id,
      name: definition.name,
      root: status.runDir,
      relative: definition.relative,
      size: validated.stat.size,
      downloadUrl: `/api/download/${id}`,
      ...(definition.viewUrl ? { viewUrl: definition.viewUrl } : {})
    };
  } catch (error) {
    if (error instanceof HttpError) return null;
    throw error;
  }
}

function bundleArtifactDescriptor(status) {
  const runDir = status?.runDir;
  const bundlePath = status?.bundle?.bundlePath;
  if (typeof runDir !== 'string' || typeof bundlePath !== 'string' || !path.isAbsolute(bundlePath)) {
    return null;
  }
  try {
    const runRoot = validateRootDirectory(runDir);
    const resolvedBundle = path.resolve(bundlePath);
    if (!isContained(runRoot.resolved, resolvedBundle)) return null;
    const relative = path.relative(runRoot.resolved, resolvedBundle).split(path.sep).join('/');
    const name = path.basename(resolvedBundle);
    if (!safeDownloadName(name)) return null;
    const validated = validateContainedFile(runRoot.resolved, relative);
    return {
      id: 'bundle',
      name,
      root: runRoot.resolved,
      relative,
      size: validated.stat.size,
      downloadUrl: '/api/download/bundle'
    };
  } catch (error) {
    if (error instanceof HttpError) return null;
    throw error;
  }
}

function artifactDescriptor(status, id) {
  return id === 'bundle'
    ? bundleArtifactDescriptor(status)
    : fixedArtifactDescriptor(status, id);
}

function buildArtifactCatalog(status) {
  const descriptors = [
    ...Object.keys(FIXED_ARTIFACTS).map(id => fixedArtifactDescriptor(status, id)),
    bundleArtifactDescriptor(status)
  ].filter(Boolean);
  return descriptors.map(({ id, name, size, downloadUrl, viewUrl }) => ({
    id,
    name,
    size,
    downloadUrl,
    ...(viewUrl ? { viewUrl } : {})
  }));
}

function defaultQueryEngineLoader({ valuesPath, boundsPath }) {
  const stateIndex = createStateIndex();
  const tables = readTables(valuesPath, boundsPath, stateIndex.totalStates);
  return new PolicyEngine({ ...tables, stateIndex, cacheSize: 2000 });
}

function queryResult(engine, query) {
  let counts;
  try {
    if (!Array.isArray(query.dice) || query.dice.length !== 5) fail(400, 'Invalid request');
    counts = diceToCounts(query.dice);
  } catch (error) {
    if (error instanceof HttpError) throw error;
    fail(400, 'Invalid request');
  }
  const rollId = engine.rollId(counts);
  if (rollId < 0) fail(400, 'Invalid request');
  const mask = Number(query.usedMask) || 0;
  const upper = Math.min(63, Math.max(0, Number(query.upperSubtotal) || 0));
  const rerolls = Math.min(2, Math.max(0, Number(query.rerollsRemaining) || 0));
  const actions = engine.allActions(mask, upper, rollId, rerolls).slice(0, 30).map((action, index) => (
    action.type === 'score'
      ? {
          rank: index + 1,
          type: 'score',
          category: action.id,
          categoryName: CATEGORY_NAMES[action.id],
          immediate: action.immediate,
          bonus: action.bonus,
          value: action.value
        }
      : {
          rank: index + 1,
          type: 'reroll',
          keeper: Array.from(engine.universe.keepers[action.keeperId]),
          keeperDice: countsToDice(engine.universe.keepers[action.keeperId]),
          value: action.value
        }
  ));
  return { dice: query.dice, mask, upper, rerolls, optimal: actions[0], actions };
}

async function streamOpenedFile({
  req,
  res,
  root,
  relative,
  protectedResource,
  downloadName,
  cacheControl,
  activeStreams
}) {
  const opened = await openContainedFile(root, relative);
  const html = path.extname(opened.validated.target).toLowerCase() === '.html';
  const headers = {
    ...securityHeaders({ protectedResource, html, cacheControl }),
    'content-type': contentType(opened.validated.target),
    'content-length': opened.stat.size
  };
  if (downloadName) {
    if (!safeDownloadName(downloadName)) {
      await opened.handle.close().catch(() => {});
      fail(404, 'Not found');
    }
    headers['content-disposition'] = `attachment; filename="${downloadName}"`;
  }

  let stream;
  try {
    stream = opened.handle.createReadStream({ autoClose: true });
    activeStreams.add(stream);
    res.writeHead(200, headers);
  } catch (error) {
    activeStreams.delete(stream);
    await opened.handle.close().catch(() => {});
    throw error;
  }

  await new Promise(resolve => {
    let finished = false;
    const cleanup = () => {
      if (finished) return;
      finished = true;
      activeStreams.delete(stream);
      req.off('aborted', abort);
      res.off('close', abort);
      resolve();
    };
    const abort = () => stream.destroy();
    req.once('aborted', abort);
    res.once('close', abort);
    stream.once('close', cleanup);
    stream.once('error', () => {
      if (!res.destroyed) res.destroy();
      cleanup();
    });
    stream.pipe(res);
  });
}

export function createYatzyServer({
  manager,
  webRoot = defaultWebRoot,
  projectRoot = defaultProjectRoot,
  queryEngineLoader = defaultQueryEngineLoader
}) {
  if (!manager || typeof manager.status !== 'function') {
    throw new TypeError('A manager-like object with status() is required');
  }
  if (typeof webRoot !== 'string' || typeof projectRoot !== 'string') {
    throw new TypeError('webRoot and projectRoot are required filesystem paths');
  }
  if (typeof queryEngineLoader !== 'function') {
    throw new TypeError('queryEngineLoader must be a function');
  }

  const tokenText = randomBytes(32).toString('base64url');
  const expectedToken = Buffer.from(tokenText, 'utf8');
  const clients = new Set();
  const sockets = new Set();
  const activeStreams = new Set();
  let queryCache = null;
  let closePromise = null;

  const broadcast = status => {
    const data = `data: ${JSON.stringify(status)}\n\n`;
    for (const response of clients) {
      if (!response.destroyed) response.write(data);
    }
  };
  if (typeof manager.on === 'function') manager.on('update', broadcast);

  const loadQueryEngine = status => {
    if (!status?.runDir) fail(404, 'A completed value table is not available');
    const values = validateContainedFile(status.runDir, 'values.bin');
    const bounds = validateContainedFile(status.runDir, 'bounds.bin');
    if (status.status !== 'COMPLETE' && !values.stat.isFile()) {
      fail(404, 'A completed value table is not available');
    }
    if (queryCache?.runDir === status.runDir) return queryCache.engine;
    const engine = queryEngineLoader({
      status,
      runDir: status.runDir,
      valuesPath: values.target,
      boundsPath: bounds.target
    });
    queryCache = { runDir: status.runDir, engine };
    return engine;
  };

  const server = http.createServer(async (req, res) => {
    try {
      const authority = validateHost(req, server);
      const target = parseRequestTarget(req.url);
      const protectedPath = isProtectedPath(target.pathname);
      const fetchMetadataPresent = enforceFetchMetadata(req, protectedPath);
      let requestBody = null;

      if (req.method === 'POST' && protectedPath) {
        enforcePostOrigin(req, authority, fetchMetadataPresent);
        if (!validControlToken(req, expectedToken)) fail(401, 'Unauthorized');
        requestBody = await readJsonObjectBody(req);
      }

      if (target.pathname === '/api/bootstrap') {
        if (req.method !== 'GET') fail(405, 'Method not allowed');
        return writeJson(res, 200, { controlToken: tokenText });
      }

      if (target.pathname === '/api/events') {
        if (req.method !== 'GET') fail(405, 'Method not allowed');
        res.writeHead(200, {
          ...securityHeaders({ protectedResource: true, cacheControl: 'no-store' }),
          'content-type': 'text/event-stream',
          connection: 'keep-alive'
        });
        res.write(`data: ${JSON.stringify(manager.status())}\n\n`);
        clients.add(res);
        req.once('close', () => clients.delete(res));
        return;
      }

      if (target.pathname === '/api/status') {
        if (req.method !== 'GET') fail(405, 'Method not allowed');
        return writeJson(res, 200, manager.status());
      }

      if (target.pathname === '/api/pipeline/start') {
        if (req.method !== 'POST') fail(405, 'Method not allowed');
        const requestedProfile = requestBody.profileId ?? PUBLIC_SMOKE_PROFILE_ID;
        if (requestedProfile !== PUBLIC_SMOKE_PROFILE_ID) fail(409, 'The browser may launch only public-smoke-v1. Registered full research requires the explicit acknowledged CLI route.');
        return writeJson(res, 200, await manager.runPublicSmoke());
      }

      if (target.pathname === '/api/pipeline/pause') {
        if (req.method !== 'POST') fail(405, 'Method not allowed');
        await manager.pause();
        return writeJson(res, 200, manager.status());
      }

      if (target.pathname === '/api/pipeline/resume') {
        if (req.method !== 'POST') fail(405, 'Method not allowed');
        await manager.resume();
        return writeJson(res, 200, manager.status());
      }

      if (target.pathname === '/api/pipeline/stop') {
        if (req.method !== 'POST') fail(405, 'Method not allowed');
        await manager.stop();
        return writeJson(res, 200, manager.status());
      }

      if (target.pathname === '/api/query') {
        if (req.method !== 'POST') fail(405, 'Method not allowed');
        const status = manager.status();
        const engine = await loadQueryEngine(status);
        return writeJson(res, 200, queryResult(engine, requestBody));
      }

      if (target.pathname === '/api/artifacts') {
        if (req.method !== 'GET') fail(405, 'Method not allowed');
        const files = buildArtifactCatalog(manager.status());
        return writeJson(res, 200, { files });
      }

      if (target.pathname.startsWith('/api/download/')) {
        if (req.method !== 'GET') fail(405, 'Method not allowed');
        const id = target.pathname.slice('/api/download/'.length);
        if (!id || id.includes('/')) fail(404, 'Artifact not found');
        const descriptor = artifactDescriptor(manager.status(), id);
        if (!descriptor) fail(404, 'Artifact not found');
        return await streamOpenedFile({
          req,
          res,
          root: descriptor.root,
          relative: descriptor.relative,
          protectedResource: true,
          downloadName: descriptor.name,
          cacheControl: 'no-store',
          activeStreams
        });
      }

      if (target.pathname.startsWith('/api/')) fail(404, 'Not found');

      if (target.pathname === '/run/start-here' || target.pathname === '/run/dossier-html') {
        if (req.method !== 'GET') fail(405, 'Method not allowed');
        const status = manager.status();
        const id = target.pathname === '/run/start-here' ? 'start-here' : 'dossier-html';
        const descriptor = fixedArtifactDescriptor(status, id);
        if (!descriptor) fail(404, 'Not found');
        return await streamOpenedFile({
          req,
          res,
          root: descriptor.root,
          relative: descriptor.relative,
          protectedResource: true,
          cacheControl: 'no-store',
          activeStreams
        });
      }

      if (target.pathname.startsWith('/run/figures/svg/')) {
        if (req.method !== 'GET') fail(405, 'Method not allowed');
        const name = target.pathname.slice('/run/figures/svg/'.length);
        if (!safeDownloadName(name) || !name.endsWith('.svg')) fail(404, 'Not found');
        const status = manager.status();
        if (!status?.runDir) fail(404, 'Not found');
        const inventory = await readContainedJson(status.runDir, 'analysis/analysis_inventory.json');
        if (!Array.isArray(inventory.figuresSvg) || !inventory.figuresSvg.includes(name)) {
          fail(404, 'Not found');
        }
        return await streamOpenedFile({
          req,
          res,
          root: status.runDir,
          relative: `figures/svg/${name}`,
          protectedResource: true,
          cacheControl: 'no-store',
          activeStreams
        });
      }

      if (target.pathname.startsWith('/run/')) fail(404, 'Not found');
      if (req.method !== 'GET') fail(405, 'Method not allowed');

      const relative = target.pathname === '/' ? 'index.html' : target.pathname.slice(1);
      return await streamOpenedFile({
        req,
        res,
        root: webRoot,
        relative,
        protectedResource: false,
        cacheControl: relative === 'index.html' ? 'no-store' : 'public, max-age=300',
        activeStreams
      });
    } catch (error) {
      drainRequest(req);
      if (error instanceof HttpError) {
        const message = {
          400: 'Malformed request',
          401: 'Unauthorized',
          403: 'Forbidden',
          404: 'Not found',
          405: 'Method not allowed',
          413: 'Request body too large',
          415: 'Unsupported media type'
        }[error.status] || 'Request failed';
        const extraHeaders = error.status === 413 ? { connection: 'close' } : {};
        if (error.status === 413) res.shouldKeepAlive = false;
        return writeJson(res, error.status, { error: message }, extraHeaders);
      }
      console.error('Yatzy HTTP request failed');
      return writeJson(res, 500, { error: 'Internal server error' });
    }
  });

  server.on('connection', socket => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });

  const listen = (port = 0) => {
    if (!Number.isInteger(port) || port < 0 || port > 65_535) {
      return Promise.reject(new RangeError('Port must be an integer from 0 through 65535'));
    }
    if (server.listening) return Promise.reject(new Error('Server is already listening'));
    return new Promise((resolve, reject) => {
      const onError = error => {
        server.off('listening', onListening);
        reject(error);
      };
      const onListening = () => {
        server.off('error', onError);
        resolve(server.address());
      };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(port, LOOPBACK_HOST);
    });
  };

  const close = () => {
    if (closePromise) return closePromise;
    closePromise = new Promise(resolve => {
      if (typeof manager.off === 'function') manager.off('update', broadcast);
      for (const response of clients) response.end();
      clients.clear();
      for (const stream of activeStreams) stream.destroy();
      activeStreams.clear();
      for (const socket of sockets) socket.destroy();
      sockets.clear();
      if (!server.listening) {
        resolve();
        return;
      }
      server.close(() => resolve());
    });
    return closePromise;
  };

  return { server, listen, close, projectRoot };
}

export function parseProductionPort(value) {
  if (value === undefined) return 4317;
  if (!/^[1-9][0-9]*$/u.test(value)) throw new Error('PORT must be an integer from 1 through 65535');
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error('PORT must be an integer from 1 through 65535');
  }
  return port;
}

function isDirectEntry() {
  if (!process.argv[1]) return false;
  return sameFilesystemPath(process.argv[1], fileURLToPath(import.meta.url));
}

export async function runProductionServer() {
  const port = parseProductionPort(process.env.PORT);
  const manager = new PipelineManager(defaultProjectRoot);
  const instance = createYatzyServer({
    manager,
    webRoot: defaultWebRoot,
    projectRoot: defaultProjectRoot
  });
  await instance.listen(port);
  console.log(`Yatzy Computation Platform: http://127.0.0.1:${port}`);
  console.log(`Data directory: ${manager.dataRoot}`);
  console.log(`Ruleset SHA-256: ${manager.rulesHash}`);
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.once(signal, async () => {
      await instance.close();
      process.exit(0);
    });
  }
  return instance;
}

if (isDirectEntry()) await runProductionServer();
