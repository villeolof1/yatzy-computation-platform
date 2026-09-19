import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { fileURLToPath } from 'node:url';
import {
  createYatzyServer,
  parseProductionPort
} from '../src/server.mjs';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const appSourcePath = path.join(projectRoot, 'web', 'app.js');

class FakeManager extends EventEmitter {
  constructor(statusValue) {
    super();
    this.statusValue = statusValue;
    this.calls = { status: 0, smoke: 0, pause: 0, resume: 0, stop: 0 };
  }

  status() {
    this.calls.status += 1;
    return this.statusValue;
  }

  async runPublicSmoke() {
    this.calls.smoke += 1;
    return { profileId: 'public-smoke-v1', referenceValue: 2.301432126285 };
  }

  async pause() {
    this.calls.pause += 1;
  }

  async resume() {
    this.calls.resume += 1;
  }

  async stop() {
    this.calls.stop += 1;
  }
}

function writeFile(file, contents) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, contents);
}

function makeFixture() {
  const container = fs.mkdtempSync(path.join(os.tmpdir(), 'yatzy-server-security-'));
  const webRoot = path.join(container, 'web');
  const runDir = path.join(container, 'run');
  const outsideDir = path.join(container, 'outside');
  const links = [];

  writeFile(path.join(webRoot, 'index.html'), '<!doctype html><title>Yatzy local test</title>\n');
  writeFile(path.join(webRoot, 'app.js'), fs.readFileSync(appSourcePath));
  writeFile(path.join(webRoot, 'styles.css'), 'body { color: #111; }\n');
  fs.mkdirSync(path.join(webRoot, 'directory'));

  const artifacts = {
    'START_HERE.html': '<!doctype html><img src="figures/svg/listed.svg">\n',
    'Yatzy_Research_Evidence_Dossier.html': '<!doctype html><img src="figures/svg/listed.svg">\n',
    'Yatzy_Research_Evidence_Dossier.pdf': Buffer.from('%PDF-tiny-test\n'),
    'master_results.json': '{"result":"master"}\n',
    'verification.json': '{"passed":true}\n',
    'values.bin': Buffer.from('values-test'),
    'bounds.bin': Buffer.from('bounds-test')
  };
  for (const [name, contents] of Object.entries(artifacts)) {
    writeFile(path.join(runDir, name), contents);
  }
  writeFile(path.join(runDir, 'unlisted.txt'), 'unlisted-run-secret\n');
  writeFile(path.join(runDir, 'figures', 'svg', 'listed.svg'), '<svg><text>listed</text></svg>\n');
  writeFile(path.join(runDir, 'figures', 'svg', 'unlisted.svg'), '<svg><text>unlisted</text></svg>\n');
  writeFile(path.join(runDir, 'analysis', 'analysis_inventory.json'), JSON.stringify({
    figuresSvg: ['listed.svg']
  }));
  const bundlePath = path.join(runDir, 'export', 'bundle-test.zip');
  writeFile(bundlePath, Buffer.from('bundle-exact-bytes'));
  const outsideSecret = path.join(outsideDir, 'outside-secret.txt');
  writeFile(outsideSecret, 'OUTSIDE-SECRET-BYTES\n');

  const status = {
    status: 'COMPLETE',
    runId: 'fake-run',
    runDir,
    rulesHash: 'rules-test',
    bundle: { bundlePath }
  };
  const manager = new FakeManager(status);
  const query = { calls: 0 };
  const queryEngineLoader = () => {
    query.calls += 1;
    return {
      universe: { keepers: [Uint8Array.from([0, 0, 0, 0, 0, 0])] },
      rollId: () => 0,
      allActions: () => [{
        type: 'score',
        id: 0,
        immediate: 1,
        bonus: 0,
        value: 1
      }]
    };
  };

  return {
    container,
    webRoot,
    runDir,
    outsideDir,
    outsideSecret,
    bundlePath,
    links,
    status,
    manager,
    query,
    queryEngineLoader
  };
}

function removeLink(link) {
  try {
    if (fs.lstatSync(link).isSymbolicLink()) fs.unlinkSync(link);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
}

async function startFixture(t) {
  const fixture = makeFixture();
  const instance = createYatzyServer({
    manager: fixture.manager,
    webRoot: fixture.webRoot,
    projectRoot: fixture.container,
    queryEngineLoader: fixture.queryEngineLoader
  });
  const address = await instance.listen(0);
  const context = {
    ...fixture,
    ...instance,
    address,
    port: address.port,
    authority: `127.0.0.1:${address.port}`
  };
  t.after(async () => {
    await instance.close();
    for (const link of fixture.links.reverse()) removeLink(link);
    fs.rmSync(fixture.container, { recursive: true, force: true });
  });
  return context;
}

function request(context, {
  requestPath = '/api/status',
  method = 'GET',
  host = context.authority,
  headers = {},
  body,
  chunks
} = {}) {
  return new Promise((resolve, reject) => {
    const requestHeaders = { ...headers };
    if (host !== null) requestHeaders.Host = host;
    const req = http.request({
      hostname: '127.0.0.1',
      port: context.port,
      path: requestPath,
      method,
      headers: requestHeaders,
      setHost: host !== null
    }, res => {
      const responseChunks = [];
      res.on('data', chunk => responseChunks.push(chunk));
      res.on('end', () => resolve({
        status: res.statusCode,
        headers: res.headers,
        body: Buffer.concat(responseChunks)
      }));
    });
    req.once('error', reject);
    if (chunks) {
      for (const chunk of chunks) req.write(chunk);
      req.end();
    } else {
      req.end(body);
    }
  });
}

function rawRequest(context, lines) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: '127.0.0.1', port: context.port });
    const chunks = [];
    socket.setTimeout(3000, () => socket.destroy(new Error('raw request timed out')));
    socket.once('connect', () => socket.write(lines.join('\r\n')));
    socket.on('data', chunk => chunks.push(chunk));
    socket.once('error', reject);
    socket.once('close', hadError => {
      if (!hadError) resolve(Buffer.concat(chunks).toString('latin1'));
    });
  });
}

function openSse(context) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1',
      port: context.port,
      path: '/api/events',
      headers: {
        Host: context.authority,
        'Sec-Fetch-Site': 'same-origin'
      }
    }, res => {
      res.once('data', chunk => resolve({ req, res, firstChunk: chunk }));
    });
    req.once('error', reject);
    req.end();
  });
}

function json(response) {
  return JSON.parse(response.body.toString('utf8'));
}

async function bootstrap(context, host = context.authority) {
  const response = await request(context, {
    requestPath: '/api/bootstrap',
    host,
    headers: { 'Sec-Fetch-Site': 'same-origin' }
  });
  assert.equal(response.status, 200);
  return { response, token: json(response).controlToken };
}

function authenticatedHeaders(token, extra = {}) {
  return {
    'Content-Type': 'application/json',
    'X-Yatzy-Control-Token': token,
    ...extra
  };
}

test('server import is side-effect free and production ports are bounded', async () => {
  const sigintBefore = process.listenerCount('SIGINT');
  const sigtermBefore = process.listenerCount('SIGTERM');
  const imported = await import(`../src/server.mjs?side-effect-check=${Date.now()}`);
  assert.equal(typeof imported.createYatzyServer, 'function');
  assert.equal(process.listenerCount('SIGINT'), sigintBefore);
  assert.equal(process.listenerCount('SIGTERM'), sigtermBefore);
  assert.equal(parseProductionPort(undefined), 4317);
  assert.equal(parseProductionPort('1'), 1);
  assert.equal(parseProductionPort('65535'), 65535);
  for (const value of ['', '0', '-1', '1.5', '65536', 'NaN']) {
    assert.throws(() => parseProductionPort(value), /PORT/);
  }
});

test('factory injects a fake manager, binds only IPv4 loopback, rotates tokens, and closes SSE', async t => {
  const first = await startFixture(t);
  const second = await startFixture(t);
  assert.equal(first.address.address, '127.0.0.1');
  assert.equal(first.address.family, 'IPv4');
  const firstBootstrap = await bootstrap(first);
  const secondBootstrap = await bootstrap(second);
  assert.notEqual(firstBootstrap.token, secondBootstrap.token);

  const status = await request(first);
  assert.equal(status.status, 200);
  assert.equal(first.manager.calls.status, 1);

  const sse = await openSse(first);
  assert.match(sse.firstChunk.toString('utf8'), /^data: /);
  const closed = new Promise(resolve => sse.res.once('close', resolve));
  await first.close();
  await closed;
});

test('Host authority is exact, duplicate-safe, and checked before manager access', async t => {
  const context = await startFixture(t);
  const accepted127 = await request(context);
  const acceptedLocalhost = await request(context, { host: `localhost:${context.port}` });
  assert.equal(accepted127.status, 200);
  assert.equal(acceptedLocalhost.status, 200);
  context.manager.calls.status = 0;

  const rejected = [
    `127.0.0.1:${context.port + 1}`,
    `attacker.example:${context.port}`,
    `localhost.attacker:${context.port}`,
    `127.0.0.1.attacker:${context.port}`,
    `localhost.:${context.port}`,
    `localhost:${context.port}, attacker.example:${context.port}`,
    `user@localhost:${context.port}`,
    `[::1]:${context.port}`
  ];
  for (const host of rejected) {
    const response = await request(context, { host });
    assert.equal(response.status, 403, `Host should be rejected: ${String(host)}`);
  }
  assert.equal(context.manager.calls.status, 0);

  const missingHost = await rawRequest(context, [
    'GET /api/status HTTP/1.0',
    'Connection: close',
    '',
    ''
  ]);
  assert.match(missingHost, /^HTTP\/1\.1 403 /);
  assert.equal(context.manager.calls.status, 0);

  const raw = await rawRequest(context, [
    'GET /api/status HTTP/1.1',
    `Host: ${context.authority}`,
    `Host: localhost:${context.port}`,
    'Connection: close',
    '',
    ''
  ]);
  assert.match(raw, /^HTTP\/1\.1 (?:400|403) /);
  assert.equal(context.manager.calls.status, 0);

  const wrongWithForwarded = await request(context, {
    host: `attacker.example:${context.port}`,
    headers: {
      'X-Forwarded-Host': context.authority,
      Forwarded: `host=${context.authority}`
    }
  });
  assert.equal(wrongWithForwarded.status, 403);
  const correctWithForwarded = await request(context, {
    headers: {
      'X-Forwarded-Host': `attacker.example:${context.port}`,
      Forwarded: `host=attacker.example:${context.port}`
    }
  });
  assert.equal(correctWithForwarded.status, 200);
});

test('Fetch Metadata, Origin, and no-CORS rules distinguish browser and local clients', async t => {
  const context = await startFixture(t);
  const { token } = await bootstrap(context);

  const sameOriginGet = await request(context, {
    headers: { 'Sec-Fetch-Site': 'same-origin' }
  });
  assert.equal(sameOriginGet.status, 200);
  context.manager.calls.status = 0;
  for (const value of ['cross-site', 'same-site', 'none', 'same-origin, cross-site']) {
    const response = await request(context, { headers: { 'Sec-Fetch-Site': value } });
    assert.equal(response.status, 403);
  }
  assert.equal(context.manager.calls.status, 0);

  const browserHeaders = authenticatedHeaders(token, {
    'Sec-Fetch-Site': 'same-origin',
    Origin: `http://${context.authority}`
  });
  const acceptedBrowser = await request(context, {
    requestPath: '/api/pipeline/pause',
    method: 'POST',
    headers: browserHeaders
  });
  assert.equal(acceptedBrowser.status, 200);
  assert.equal(context.manager.calls.pause, 1);

  const acceptedLocalhostBrowser = await request(context, {
    requestPath: '/api/pipeline/pause',
    method: 'POST',
    host: `localhost:${context.port}`,
    headers: authenticatedHeaders(token, {
      'Sec-Fetch-Site': 'same-origin',
      Origin: `http://localhost:${context.port}`
    })
  });
  assert.equal(acceptedLocalhostBrowser.status, 200);
  assert.equal(context.manager.calls.pause, 2);

  const badOrigins = [
    `https://${context.authority}`,
    `http://127.0.0.1:${context.port + 1}`,
    `http://attacker.example:${context.port}`,
    'null',
    `http://${context.authority} http://attacker.example:${context.port}`
  ];
  for (const origin of badOrigins) {
    const response = await request(context, {
      requestPath: '/api/pipeline/pause',
      method: 'POST',
      headers: authenticatedHeaders(token, {
        'Sec-Fetch-Site': 'same-origin',
        Origin: origin
      })
    });
    assert.equal(response.status, 403);
  }
  const missingBrowserOrigin = await request(context, {
    requestPath: '/api/pipeline/pause',
    method: 'POST',
    headers: authenticatedHeaders(token, { 'Sec-Fetch-Site': 'same-origin' })
  });
  assert.equal(missingBrowserOrigin.status, 403);
  assert.equal(context.manager.calls.pause, 2);

  const localClient = await request(context, {
    requestPath: '/api/pipeline/pause',
    method: 'POST',
    headers: authenticatedHeaders(token)
  });
  assert.equal(localClient.status, 200);
  assert.equal(context.manager.calls.pause, 3);

  const options = await request(context, {
    requestPath: '/api/status',
    method: 'OPTIONS',
    headers: {
      Origin: `http://attacker.example:${context.port}`,
      'Access-Control-Request-Method': 'GET',
      'Sec-Fetch-Site': 'same-origin'
    }
  });
  assert.equal(options.status, 405);
  const getControl = await request(context, { requestPath: '/api/pipeline/start' });
  const postStatus = await request(context, {
    requestPath: '/api/status',
    method: 'POST',
    headers: authenticatedHeaders(token),
    body: '{}'
  });
  const postStatic = await request(context, {
    requestPath: '/',
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}'
  });
  assert.equal(getControl.status, 405);
  assert.equal(postStatus.status, 405);
  assert.equal(postStatic.status, 405);
  for (const response of [sameOriginGet, acceptedBrowser, localClient, options]) {
    assert.equal(response.headers['access-control-allow-origin'], undefined);
    assert.equal(response.headers['access-control-allow-credentials'], undefined);
  }
});

test('bootstrap and every POST route enforce token secrecy before body or route effects', async t => {
  const context = await startFixture(t);
  const { response: bootstrapResponse, token } = await bootstrap(context);
  assert.equal(bootstrapResponse.headers['cache-control'], 'no-store');
  assert.equal(bootstrapResponse.headers['set-cookie'], undefined);
  assert.ok(token.length >= 43);

  const routes = [
    ['/api/pipeline/start', 'smoke'],
    ['/api/pipeline/pause', 'pause'],
    ['/api/pipeline/resume', 'resume'],
    ['/api/pipeline/stop', 'stop'],
    ['/api/query', 'query']
  ];
  for (const [requestPath] of routes) {
    const missing = await request(context, {
      requestPath,
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{malformed'
    });
    assert.equal(missing.status, 401);
    const wrong = await request(context, {
      requestPath,
      method: 'POST',
      headers: authenticatedHeaders('wrong-token'),
      body: '{}'
    });
    assert.equal(wrong.status, 401);
  }
  assert.equal(context.manager.calls.smoke, 0);
  assert.equal(context.manager.calls.pause, 0);
  assert.equal(context.manager.calls.resume, 0);
  assert.equal(context.manager.calls.stop, 0);
  assert.equal(context.query.calls, 0);

  const root = await request(context, { requestPath: '/' });
  const app = await request(context, { requestPath: '/app.js' });
  const status = await request(context);
  const artifacts = await request(context, { requestPath: '/api/artifacts' });
  for (const response of [root, app, status, artifacts]) {
    assert.equal(response.body.includes(Buffer.from(token)), false);
  }
  assert.equal(root.headers['set-cookie'], undefined);
  assert.equal(app.headers['set-cookie'], undefined);

  const sse = await openSse(context);
  assert.equal(sse.firstChunk.includes(Buffer.from(token)), false);
  sse.req.destroy();
  sse.res.destroy();
});

test('valid authenticated controls call only the intended operation exactly once', async t => {
  const context = await startFixture(t);
  const { token } = await bootstrap(context);

  const controls = [
    ['/api/pipeline/start', 'smoke', { profileId: 'public-smoke-v1' }, 200],
    ['/api/pipeline/pause', 'pause', {}, 200],
    ['/api/pipeline/resume', 'resume', {}, 200],
    ['/api/pipeline/stop', 'stop', {}, 200]
  ];
  for (const [requestPath, counter, body, expectedStatus] of controls) {
    const before = context.manager.calls[counter];
    const response = await request(context, {
      requestPath,
      method: 'POST',
      headers: authenticatedHeaders(token),
      body: JSON.stringify(body)
    });
    assert.equal(response.status, expectedStatus);
    assert.equal(context.manager.calls[counter], before + 1);
  }
  assert.equal(context.manager.calls.smoke, 1);

  const queryResponse = await request(context, {
    requestPath: '/api/query',
    method: 'POST',
    headers: authenticatedHeaders(token),
    body: JSON.stringify({
      dice: [1, 2, 3, 4, 5],
      rerollsRemaining: 0,
      usedMask: 0,
      upperSubtotal: 0
    })
  });
  assert.equal(queryResponse.status, 200);
  assert.equal(context.query.calls, 1);
  assert.equal(json(queryResponse).optimal.type, 'score');
});

test('browser start defaults to smoke and rejects registered full selection', async t => {
  const context = await startFixture(t);
  const { token } = await bootstrap(context);
  const ordinary = await request(context, {
    requestPath: '/api/pipeline/start',
    method: 'POST',
    headers: authenticatedHeaders(token),
    body: '{}'
  });
  assert.equal(ordinary.status, 200);
  assert.equal(json(ordinary).profileId, 'public-smoke-v1');
  assert.equal(context.manager.calls.smoke, 1);
  const beforeRejectedInventory = fs.readdirSync(context.container, { recursive: true }).sort();

  const full = await request(context, {
    requestPath: '/api/pipeline/start',
    method: 'POST',
    headers: authenticatedHeaders(token),
    body: JSON.stringify({ profileId: 'registered-full-v3' })
  });
  assert.equal(full.status, 409);
  assert.equal(json(full).error, 'Request failed');
  assert.equal(context.manager.calls.smoke, 1);
  assert.deepEqual(fs.readdirSync(context.container, { recursive: true }).sort(), beforeRejectedInventory);
});

test('JSON media, encoding, parsing, and inclusive 65536-byte boundary are enforced', async t => {
  const context = await startFixture(t);
  const { token } = await bootstrap(context);
  const post = (headers, body, chunks) => request(context, {
    requestPath: '/api/pipeline/start',
    method: 'POST',
    headers: { 'X-Yatzy-Control-Token': token, ...headers },
    body,
    chunks
  });

  let before = context.manager.calls.smoke;
  const ordinary = await post({ 'Content-Type': 'application/json' }, '{}');
  const charset = await post({ 'Content-Type': 'application/json; charset=UTF-8' }, '{}');
  const identityEncoding = await post({
    'Content-Type': 'application/json',
    'Content-Encoding': 'identity'
  }, '{}');
  assert.equal(ordinary.status, 200);
  assert.equal(charset.status, 200);
  assert.equal(identityEncoding.status, 200);
  assert.equal(context.manager.calls.smoke, before + 3);

  before = context.manager.calls.smoke;
  for (const contentType of ['application/x-www-form-urlencoded', 'text/plain']) {
    const response = await post({ 'Content-Type': contentType }, '{}');
    assert.equal(response.status, 415);
  }
  const encoded = await post({
    'Content-Type': 'application/json',
    'Content-Encoding': 'gzip'
  }, '{}');
  assert.equal(encoded.status, 415);
  assert.equal(context.manager.calls.smoke, before);

  for (const body of ['{', '[]', 'null', '"text"', '1', 'true']) {
    const response = await post({ 'Content-Type': 'application/json' }, body);
    assert.equal(response.status, 400, `body should be rejected: ${body}`);
  }
  assert.equal(context.manager.calls.smoke, before);

  const declared = await post({
    'Content-Type': 'application/json',
    'Content-Length': '65537'
  });
  assert.equal(declared.status, 413);

  const chunked = await post(
    {
      'Content-Type': 'application/json',
      'Transfer-Encoding': 'chunked'
    },
    undefined,
    [Buffer.alloc(40_000, 0x61), Buffer.alloc(25_537, 0x62)]
  );
  assert.equal(chunked.status, 413, JSON.stringify({
    headers: chunked.headers,
    body: chunked.body.toString('utf8')
  }));
  assert.equal(context.manager.calls.smoke, before);

  const prefix = '{"padding":"';
  const suffix = '"}';
  const boundary = prefix + 'a'.repeat(65_536 - Buffer.byteLength(prefix) - Buffer.byteLength(suffix)) + suffix;
  assert.equal(Buffer.byteLength(boundary), 65_536);
  const acceptedBoundary = await post({
    'Content-Type': 'application/json',
    'Content-Length': String(Buffer.byteLength(boundary))
  }, boundary);
  assert.equal(acceptedBoundary.status, 200);
  assert.equal(context.manager.calls.smoke, before + 1);
  assert.equal(fs.statSync(context.outsideSecret).size, 21);
});

test('artifact catalog exposes only logical identities and exact declared bytes', async t => {
  const context = await startFixture(t);
  const listing = await request(context, { requestPath: '/api/artifacts' });
  assert.equal(listing.status, 200);
  const listingText = listing.body.toString('utf8');
  assert.equal(listingText.includes(context.runDir), false);
  assert.equal(listingText.includes(context.container), false);
  const files = json(listing).files;
  assert.deepEqual(files.map(file => file.id).sort(), [
    'bounds',
    'bundle',
    'dossier-html',
    'dossier-pdf',
    'master-results',
    'start-here',
    'values',
    'verification'
  ]);
  for (const file of files) {
    assert.match(file.downloadUrl, /^\/api\/download\/[a-z-]+$/);
    assert.equal(Object.hasOwn(file, 'path'), false);
  }

  const master = await request(context, { requestPath: '/api/download/master-results' });
  assert.equal(master.status, 200);
  assert.deepEqual(master.body, fs.readFileSync(path.join(context.runDir, 'master_results.json')));
  assert.equal(master.headers['content-disposition'], 'attachment; filename="master_results.json"');

  const bundle = await request(context, { requestPath: '/api/download/bundle' });
  assert.equal(bundle.status, 200);
  assert.deepEqual(bundle.body, Buffer.from('bundle-exact-bytes'));
  assert.equal(bundle.headers['content-disposition'], 'attachment; filename="bundle-test.zip"');

  context.status.bundle.bundlePath = context.outsideSecret;
  const outsideBundle = await request(context, { requestPath: '/api/download/bundle' });
  const outsideListing = await request(context, { requestPath: '/api/artifacts' });
  assert.equal(outsideBundle.status, 404);
  assert.equal(json(outsideListing).files.some(file => file.id === 'bundle'), false);

  const unsafeNameBundle = path.join(context.runDir, 'export', 'bad name.zip');
  writeFile(unsafeNameBundle, 'unsafe-name-bundle');
  context.status.bundle.bundlePath = unsafeNameBundle;
  const unsafeNameResponse = await request(context, { requestPath: '/api/download/bundle' });
  assert.equal(unsafeNameResponse.status, 404);
  context.status.bundle.bundlePath = context.bundlePath;

  for (const requestPath of [
    '/api/download/unknown',
    '/api/download/file/unlisted.txt',
    '/api/download/file/%2e%2e/outside/outside-secret.txt',
    '/api/download/C:%5Coutside-secret.txt',
    '/api/download/dossier-pdf%22%0d%0aX-Injected:%20yes'
  ]) {
    const response = await request(context, { requestPath });
    assert.ok([400, 403, 404].includes(response.status));
    assert.equal(response.body.includes(Buffer.from('OUTSIDE-SECRET-BYTES')), false);
    assert.equal(response.headers['x-injected'], undefined);
  }

  const unlistedRun = await request(context, { requestPath: '/run/unlisted.txt' });
  const startHere = await request(context, { requestPath: '/run/start-here' });
  const unlistedSvg = await request(context, { requestPath: '/run/figures/svg/unlisted.svg' });
  const listedSvg = await request(context, { requestPath: '/run/figures/svg/listed.svg' });
  assert.equal(unlistedRun.status, 404);
  assert.equal(startHere.status, 200);
  assert.equal(unlistedSvg.status, 404);
  assert.equal(listedSvg.status, 200);
  assert.deepEqual(listedSvg.body, fs.readFileSync(path.join(context.runDir, 'figures', 'svg', 'listed.svg')));
  assert.equal(fs.statSync(context.outsideSecret).size, 21);
});

test('bundle, run, and static containment reject traversal and redirected ancestors', async t => {
  const context = await startFixture(t);
  const linkType = process.platform === 'win32' ? 'junction' : 'dir';

  const redirectedStatic = path.join(context.webRoot, 'redirected');
  fs.symlinkSync(context.outsideDir, redirectedStatic, linkType);
  context.links.push(redirectedStatic);
  const staticEscape = await request(context, { requestPath: '/redirected/outside-secret.txt' });
  assert.ok([403, 404].includes(staticEscape.status));
  assert.equal(staticEscape.body.includes(Buffer.from('OUTSIDE-SECRET-BYTES')), false);

  const redirectedExport = path.join(context.runDir, 'redirected-export');
  fs.symlinkSync(context.outsideDir, redirectedExport, linkType);
  context.links.push(redirectedExport);
  context.status.bundle.bundlePath = path.join(redirectedExport, 'outside-secret.txt');
  const redirectedBundle = await request(context, { requestPath: '/api/download/bundle' });
  const listing = await request(context, { requestPath: '/api/artifacts' });
  assert.equal(redirectedBundle.status, 404);
  assert.equal(json(listing).files.some(file => file.id === 'bundle'), false);
  assert.equal(redirectedBundle.body.includes(Buffer.from('OUTSIDE-SECRET-BYTES')), false);

  const sibling = path.join(context.container, 'run-evil');
  writeFile(path.join(sibling, 'sibling-secret.txt'), 'SIBLING-PREFIX-SECRET\n');
  for (const requestPath of [
    '/%2e%2e/outside/outside-secret.txt',
    '/run/%2e%2e/outside/outside-secret.txt',
    '/run/%2e%2e/run-evil/sibling-secret.txt',
    '/C:%5Coutside-secret.txt',
    '/directory'
  ]) {
    const response = await request(context, { requestPath });
    assert.ok([403, 404].includes(response.status));
    assert.equal(response.body.includes(Buffer.from('OUTSIDE-SECRET-BYTES')), false);
    assert.equal(response.body.includes(Buffer.from('SIBLING-PREFIX-SECRET')), false);
  }

  if (process.platform === 'win32') {
    assert.equal(fs.lstatSync(redirectedStatic).isSymbolicLink(), true);
    t.diagnostic('Mandatory Windows directory-junction rejection passed.');
    const fileLink = path.join(context.webRoot, 'optional-file-link.txt');
    try {
      fs.symlinkSync(context.outsideSecret, fileLink, 'file');
      context.links.push(fileLink);
      const fileLinkResponse = await request(context, { requestPath: '/optional-file-link.txt' });
      assert.ok([403, 404].includes(fileLinkResponse.status));
    } catch (error) {
      if (!['EPERM', 'EACCES', 'UNKNOWN'].includes(error?.code)) throw error;
      t.diagnostic(`Windows file-symlink creation unavailable (${error.code}); mandatory directory junction coverage passed.`);
    }
  }
  assert.equal(fs.statSync(context.outsideSecret).size, 21);
});

test('static, protected, active-content, and anti-framing headers are bounded', async t => {
  const context = await startFixture(t);
  const root = await request(context, { requestPath: '/' });
  const app = await request(context, { requestPath: '/app.js' });
  const styles = await request(context, { requestPath: '/styles.css' });
  const dossier = await request(context, {
    requestPath: '/run/dossier-html',
    headers: { 'Sec-Fetch-Site': 'same-origin' }
  });
  assert.equal(root.status, 200);
  assert.equal(app.status, 200);
  assert.equal(styles.status, 200);
  assert.equal(dossier.status, 200);
  assert.equal(root.headers['x-frame-options'], 'DENY');
  assert.match(root.headers['content-security-policy'], /frame-ancestors 'none'/);
  assert.equal(dossier.headers['x-frame-options'], 'DENY');
  assert.match(dossier.headers['content-security-policy'], /frame-ancestors 'none'/);
  for (const response of [root, app, styles, dossier]) {
    assert.equal(response.headers['x-content-type-options'], 'nosniff');
    assert.equal(response.headers['referrer-policy'], 'no-referrer');
  }
  assert.equal(dossier.headers['cross-origin-resource-policy'], 'same-origin');
  assert.equal(app.headers['access-control-allow-origin'], undefined);
});

test('browser source uses module-memory bootstrap, bounded POST retry, and logical artifact URLs', () => {
  const source = fs.readFileSync(appSourcePath, 'utf8');
  assert.match(source, /fetch\('\/api\/bootstrap'/);
  assert.match(source, /\['X-Yatzy-Control-Token'\]/);
  assert.match(source, /method==='POST'/);
  assert.match(source, /res\.status===401&&attempt===0/);
  assert.match(source, /attempt<2/);
  assert.match(source, /new EventSource\('\/api\/events'\)/);
  assert.doesNotMatch(source, /new EventSource\([^)]*controlToken/);
  assert.doesNotMatch(source, /(?:localStorage|sessionStorage)\.(?:setItem|getItem)\([^)]*controlToken/);
  assert.match(source, /localStorage\.setItem\('yatzy\.settings'/);
  assert.match(source, /x\.downloadUrl/);
  assert.match(source, /x\.viewUrl/);
  assert.match(source, /href="\/run\/dossier-html"/);
  assert.match(source, /href="\/api\/download\/dossier-pdf"/);
  assert.doesNotMatch(source, /\/api\/download\/file\//);
  assert.doesNotMatch(source, /[?&](?:token|controlToken)=/);
});
