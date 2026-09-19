import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import util from 'node:util';
import { ChildProcess, spawn } from 'node:child_process';
import { EventEmitter, getEventListeners } from 'node:events';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';
import {
  CHILD_PROCESS_ERROR_CODES,
  ChildProcessPolicyError,
  CONTROLLED_INHERITED_ENVIRONMENT_NAMES,
  createControlledProcessRunner,
  runControlledProcess,
  runControlledProcessSync
} from '../src/util/child-process.mjs';
import { renderDossierPdf } from '../src/analysis/dossier.mjs';
import { cleanRoomTest, createZip, listZip } from '../src/v3/archive.mjs';
import { runGit } from '../src/v3/official-pipeline.mjs';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const sourceRoot = path.join(projectRoot, 'engine', 'src');
const defaultOptions = Object.freeze({
  cwd: projectRoot,
  timeoutMs: 5_000,
  maxOutputBytes: 1024 * 1024,
  encoding: 'utf8'
});
const diagnosticErrors = [];

function ownedTemporaryDirectory(t, prefix = 'yatzy-child-policy-') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function nodeEval(script, values = []) {
  return ['-e', script, '--', ...values];
}

function assertPolicyCode(error, code) {
  assert.ok(error instanceof ChildProcessPolicyError);
  assert.equal(error.code, code);
  return true;
}

async function captureError(execution) {
  try {
    await execution;
  } catch (error) {
    return error;
  }
  assert.fail('expected child-process policy failure');
}

function captureSyncError(execution) {
  try {
    execution();
  } catch (error) {
    return error;
  }
  assert.fail('expected synchronous child-process policy failure');
}

function ownStringValues(value, seen = new Set()) {
  if (value === null || (typeof value !== 'object' && typeof value !== 'function') || seen.has(value)) return [];
  seen.add(value);
  const strings = [];
  let descriptors;
  try {
    descriptors = Object.getOwnPropertyDescriptors(value);
  } catch {
    return strings;
  }
  for (const descriptor of Object.values(descriptors)) {
    if (!Object.hasOwn(descriptor, 'value')) continue;
    if (typeof descriptor.value === 'string') strings.push(descriptor.value);
    else strings.push(...ownStringValues(descriptor.value, seen));
  }
  return strings;
}

function protectedVariants(value) {
  return [...new Set([
    value,
    value.replaceAll('\\', '/'),
    value.replaceAll('/', '\\')
  ])].filter(candidate => candidate.length >= 3);
}

function includesProtected(text, protectedValue) {
  const haystack = process.platform === 'win32' ? text.toLocaleLowerCase('en-US') : text;
  return protectedVariants(protectedValue).some(variant => {
    const needle = process.platform === 'win32' ? variant.toLocaleLowerCase('en-US') : variant;
    const encoded = JSON.stringify(needle).slice(1, -1);
    return haystack.includes(needle) || haystack.includes(encoded);
  });
}

function assertDiagnosticSafe(error, protectedValues) {
  const values = [...new Set(protectedValues.filter(value => typeof value === 'string' && value.length >= 3))];
  const ownNames = Object.getOwnPropertyNames(error);
  const enumerableNames = Object.keys(error);
  const directStrings = [
    error.message,
    error.name,
    error.stack,
    ownNames.join('|'),
    enumerableNames.join('|'),
    ...ownStringValues(error)
  ];
  const formatted = [
    JSON.stringify(error),
    util.inspect(error, { depth: 12 }),
    String(error),
    util.format(error),
    util.format('%s', error),
    util.formatWithOptions({ depth: 12 }, '%o', error)
  ].filter(value => typeof value === 'string');
  for (const protectedValue of values) {
    assert.equal(
      directStrings.some(text => includesProtected(text, protectedValue)),
      false,
      'protected value reached a direct or recursively inspected own property'
    );
    assert.equal(
      formatted.some(text => includesProtected(text, protectedValue)),
      false,
      'protected value reached serialization, inspection, or formatting'
    );
  }
}

function assertSanitizedCause(cause, category) {
  assert.ok(cause);
  assert.equal(Object.getPrototypeOf(cause), null);
  assert.equal(Object.isFrozen(cause), true);
  const approved = new Set(['name', 'code', 'syscall', 'category']);
  for (const name of Object.getOwnPropertyNames(cause)) assert.ok(approved.has(name));
  for (const name of Object.keys(cause)) assert.ok(approved.has(name));
  assert.equal(cause.name, 'SanitizedNativeError');
  assert.equal(cause.category, category);
  if (category === 'unavailable') {
    assert.equal(cause.code, 'ERR_CHILD_PROCESS_CAUSE_UNAVAILABLE');
    assert.equal(cause.syscall, null);
  } else {
    if (cause.code !== undefined) assert.match(cause.code, /^[A-Z][A-Z0-9_]{1,31}$/);
    if (cause.syscall !== undefined) assert.match(cause.syscall, /^(?:spawn|open|stat|lstat|realpath|access|kill|wait|read|write)$/);
  }
  for (const prohibited of ['message', 'stack', 'path', 'dest', 'spawnargs', 'errno']) {
    assert.equal(Object.hasOwn(cause, prohibited), false);
    assert.equal(cause[prohibited], undefined);
  }
}

function recordDiagnosticError(error, protectedValues) {
  diagnosticErrors.push({ error, protectedValues: [...protectedValues] });
  assertDiagnosticSafe(error, protectedValues);
  return error;
}

function retainSpawnedChildLifecycle() {
  const observation = {
    calls: 0,
    child: null,
    events: []
  };
  return {
    observation,
    spawnImpl(command, args, options) {
      observation.calls += 1;
      assert.equal(observation.calls, 1);
      const child = spawn(command, args, options);
      observation.child = child;
      child.once('spawn', () => observation.events.push({ name: 'spawn', child }));
      child.once('exit', (code, signal) => observation.events.push({ name: 'exit', child, code, signal }));
      child.once('close', (code, signal) => observation.events.push({ name: 'close', child, code, signal }));
      return child;
    }
  };
}

function assertSpawnedChildLifecycle(observation, error) {
  assert.equal(observation.calls, 1);
  assert.ok(observation.child instanceof ChildProcess);
  assert.ok(Number.isSafeInteger(observation.child.pid));
  assert.ok(observation.child.pid > 0);
  assert.deepEqual(observation.events.map(event => event.name), ['spawn', 'exit', 'close']);
  for (const event of observation.events) assert.equal(event.child, observation.child);
  for (const event of observation.events.filter(event => event.name !== 'spawn')) {
    assert.ok(event.code !== null || event.signal !== null);
  }
  const stdoutPidText = error.stdoutExcerpt.trim();
  if (stdoutPidText !== '') {
    const stdoutPid = Number(stdoutPidText);
    assert.ok(Number.isSafeInteger(stdoutPid));
    assert.equal(stdoutPid, observation.child.pid);
  }
}

function withoutComments(source) {
  let result = '';
  let state = 'code';
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    const next = source[index + 1];
    if (state === 'line-comment') {
      if (character === '\n') {
        state = 'code';
        result += '\n';
      } else {
        result += ' ';
      }
    } else if (state === 'block-comment') {
      if (character === '*' && next === '/') {
        result += '  ';
        index += 1;
        state = 'code';
      } else {
        result += character === '\n' ? '\n' : ' ';
      }
    } else if (state === 'single-quote') {
      result += character;
      if (character === '\\') {
        result += next ?? '';
        index += 1;
      } else if (character === "'") {
        state = 'code';
      }
    } else if (state === 'double-quote') {
      result += character;
      if (character === '\\') {
        result += next ?? '';
        index += 1;
      } else if (character === '"') {
        state = 'code';
      }
    } else if (state === 'template') {
      result += character;
      if (character === '\\') {
        result += next ?? '';
        index += 1;
      } else if (character === '`') {
        state = 'code';
      }
    } else if (character === '/' && next === '/') {
      result += '  ';
      index += 1;
      state = 'line-comment';
    } else if (character === '/' && next === '*') {
      result += '  ';
      index += 1;
      state = 'block-comment';
    } else {
      result += character;
      if (character === "'") state = 'single-quote';
      else if (character === '"') state = 'double-quote';
      else if (character === '`') state = 'template';
    }
  }
  return result;
}

test('invalid executable and argument shapes fail before spawn', async () => {
  await assert.rejects(runControlledProcess('', [], defaultOptions), error => assertPolicyCode(error, CHILD_PROCESS_ERROR_CODES.invalid));
  await assert.rejects(runControlledProcess(3, [], defaultOptions), error => assertPolicyCode(error, CHILD_PROCESS_ERROR_CODES.invalid));
  await assert.rejects(runControlledProcess(process.execPath, 'not-an-array', defaultOptions), error => assertPolicyCode(error, CHILD_PROCESS_ERROR_CODES.invalid));
  await assert.rejects(runControlledProcess(process.execPath, ['ok', 1], defaultOptions), error => assertPolicyCode(error, CHILD_PROCESS_ERROR_CODES.invalid));
  const argsWithAccessor = ['ok'];
  Object.defineProperty(argsWithAccessor, '0', { enumerable: true, get: () => 'not-read' });
  await assert.rejects(runControlledProcess(process.execPath, argsWithAccessor, defaultOptions), error => assertPolicyCode(error, CHILD_PROCESS_ERROR_CODES.invalid));
});

test('cwd, timeout, output, shell, and encoding policy is fail-closed', async () => {
  const missing = path.join(os.tmpdir(), `yatzy-no-such-cwd-${process.pid}-${Date.now()}`);
  const cases = [
    { ...defaultOptions, cwd: 'relative' },
    { ...defaultOptions, cwd: missing },
    { ...defaultOptions, timeoutMs: 0 },
    { ...defaultOptions, timeoutMs: -1 },
    { ...defaultOptions, timeoutMs: Number.POSITIVE_INFINITY },
    { ...defaultOptions, maxOutputBytes: 0 },
    { ...defaultOptions, maxOutputBytes: Number.POSITIVE_INFINITY },
    { ...defaultOptions, shell: false },
    { ...defaultOptions, encoding: 'hex' }
  ];
  for (const options of cases) {
    await assert.rejects(runControlledProcess(process.execPath, ['--version'], options), error => assertPolicyCode(error, CHILD_PROCESS_ERROR_CODES.invalid));
  }
});

test('exotic, accessor, symbol, and prototype-pollution inputs are rejected without invoking accessors', async () => {
  await assert.rejects(runControlledProcess(process.execPath, [], Object.create(null)), error => assertPolicyCode(error, CHILD_PROCESS_ERROR_CODES.invalid));
  let accessed = false;
  const accessorOptions = { ...defaultOptions };
  Object.defineProperty(accessorOptions, 'cwd', { enumerable: true, get() { accessed = true; return projectRoot; } });
  await assert.rejects(runControlledProcess(process.execPath, [], accessorOptions), error => assertPolicyCode(error, CHILD_PROCESS_ERROR_CODES.invalid));
  assert.equal(accessed, false);
  const symbolOptions = { ...defaultOptions, [Symbol('unsafe')]: true };
  await assert.rejects(runControlledProcess(process.execPath, [], symbolOptions), error => assertPolicyCode(error, CHILD_PROCESS_ERROR_CODES.invalid));
  const pollutedEnvironment = JSON.parse('{"__proto__":"unsafe"}');
  await assert.rejects(
    runControlledProcess(process.execPath, [], { ...defaultOptions, env: pollutedEnvironment }),
    error => assertPolicyCode(error, CHILD_PROCESS_ERROR_CODES.invalid)
  );
});

test('invalid explicit environments fail before spawn', async () => {
  const accessorEnvironment = {};
  Object.defineProperty(accessorEnvironment, 'SAFE', { enumerable: true, get: () => 'not-read' });
  const cases = [
    null,
    [],
    Object.create(null),
    { SAFE: 1 },
    { PATH: 'caller-overwrite' },
    accessorEnvironment,
    { [Symbol('unsafe')]: 'value' }
  ];
  for (const env of cases) {
    await assert.rejects(
      runControlledProcess(process.execPath, [], { ...defaultOptions, env }),
      error => assertPolicyCode(error, CHILD_PROCESS_ERROR_CODES.invalid)
    );
  }
});

test('shell is always false and caller arguments are copied', () => {
  let captured;
  const runner = createControlledProcessRunner({
    environment: { PATH: 'controlled-path', UNEXPECTED: 'absent' },
    platform: process.platform,
    spawnSyncImpl(executable, args, options) {
      captured = { executable, args, options };
      return { status: 0, signal: null, stdout: Buffer.from('ok'), stderr: Buffer.alloc(0) };
    }
  });
  const args = Object.freeze(['one value', '&', '$(unsafe)', '`unsafe`']);
  const result = runner.runControlledProcessSync('approved-tool', args, defaultOptions);
  assert.equal(result.stdout, 'ok');
  assert.equal(captured.options.shell, false);
  assert.equal(captured.options.windowsHide, true);
  assert.deepEqual(captured.args, args);
  assert.notEqual(captured.args, args);
  assert.deepEqual(args, ['one value', '&', '$(unsafe)', '`unsafe`']);
});

test('spaces, quotes, redirects, pipes, dollar-parens, and backticks remain literal arguments', async t => {
  const cwd = ownedTemporaryDirectory(t, 'yatzy child policy cwd ');
  const hostile = ['two words', '"quoted"', '&', '|', ';', '>', '<', '$(whoami)', '`whoami`'];
  const script = 'process.stdout.write(JSON.stringify(process.argv.slice(1)))';
  const result = await runControlledProcess(
    process.execPath,
    nodeEval(script, hostile),
    { ...defaultOptions, cwd }
  );
  assert.deepEqual(JSON.parse(result.stdout), hostile);
});

test('only the documented inherited environment subset and explicit additions reach the child', async () => {
  const explicitName = 'YATZY_CHILD_POLICY_TEST';
  const result = await runControlledProcess(
    process.execPath,
    nodeEval('process.stdout.write(JSON.stringify(process.env))'),
    { ...defaultOptions, env: { [explicitName]: 'present' } }
  );
  const childEnvironment = JSON.parse(result.stdout);
  assert.equal(childEnvironment[explicitName], 'present');
  assert.equal(childEnvironment.YATZY_UNEXPECTED_INHERITED, undefined);
  const allowed = new Set([...CONTROLLED_INHERITED_ENVIRONMENT_NAMES.map(name => process.platform === 'win32' ? name.toUpperCase() : name), explicitName]);
  for (const name of Object.keys(childEnvironment)) {
    assert.ok(allowed.has(process.platform === 'win32' ? name.toUpperCase() : name), `unexpected inherited environment key: ${name}`);
  }
  if (process.platform === 'win32') {
    for (const name of ['LOGONSERVER', 'SYSTEMDRIVE', 'USERDOMAIN', 'USERNAME']) assert.equal(childEnvironment[name], '');
  }
});

test('secret-like explicit environment values are redacted from errors', async () => {
  const secret = 'phase-9c2a-secret-value';
  await assert.rejects(
    runControlledProcess(
      process.execPath,
      nodeEval('process.stderr.write(process.env.YATZY_API_TOKEN);process.exit(7)'),
      { ...defaultOptions, env: { YATZY_API_TOKEN: secret } }
    ),
    error => {
      assertPolicyCode(error, CHILD_PROCESS_ERROR_CODES.nonzero);
      assert.equal(error.exitCode, 7);
      assert.equal(error.stderrExcerpt.includes(secret), false);
      assert.match(error.stderrExcerpt, /\[REDACTED\]/);
      assert.equal(error.message.includes(secret), false);
      assert.equal(JSON.stringify(error).includes(secret), false);
      return true;
    }
  );
});

test('all protected excerpt categories are redacted across every diagnostic surface', async () => {
  const syntheticRoot = path.join(path.parse(projectRoot).root, 'SyntheticPrivate', 'DiagnosticRoot');
  const syntheticHome = path.join(syntheticRoot, 'HomeAlpha');
  const syntheticProfile = path.join(syntheticRoot, 'ProfileBeta');
  const syntheticTemp = path.join(syntheticRoot, 'TempGamma');
  const privateArgument = path.join(syntheticRoot, 'Argument&"Quoted"|Pipe');
  const overlapParent = path.join(syntheticRoot, 'OverlapValue');
  const overlapChild = path.join(overlapParent, 'NestedValue');
  const secret = 'synthetic-token-value-0123456789';
  const runner = createControlledProcessRunner({
    environment: {
      PATH: process.env.PATH ?? '',
      HOME: syntheticHome,
      USERPROFILE: syntheticProfile,
      TEMP: syntheticTemp,
      TMP: syntheticTemp,
      HOMEDRIVE: path.parse(syntheticHome).root.replace(/[\\/]$/, ''),
      HOMEPATH: syntheticHome.slice(path.parse(syntheticHome).root.length - 1)
    },
    platform: process.platform
  });
  const script = [
    "const os=require('node:os')",
    "const path=require('node:path')",
    "const separatorVariant=process.argv[1].replaceAll('\\\\','/')",
    "const caseVariant=process.platform==='win32'?process.cwd().toUpperCase():'public-platform'",
    "const values=['public-context',process.env.HOME,process.env.USERPROFILE,process.env.TEMP,os.tmpdir(),process.cwd(),caseVariant,process.execPath,path.dirname(process.execPath),os.hostname(),process.argv[1],separatorVariant,process.argv[2],process.argv[3],process.env.YATZY_API_TOKEN,'public-tail']",
    "const text=values.join('\\n')",
    'process.stdout.write(text)',
    'process.stderr.write(text)',
    'process.exit(7)'
  ].join(';');
  const error = await captureError(runner.runControlledProcess(
    process.execPath,
    nodeEval(script, [privateArgument, overlapParent, overlapChild]),
    { ...defaultOptions, env: { YATZY_API_TOKEN: secret } }
  ));
  assertPolicyCode(error, CHILD_PROCESS_ERROR_CODES.nonzero);
  const protectedValues = [
    syntheticHome,
    syntheticProfile,
    syntheticTemp,
    os.tmpdir(),
    projectRoot,
    process.execPath,
    path.dirname(process.execPath),
    os.hostname(),
    privateArgument,
    overlapParent,
    overlapChild,
    secret
  ];
  recordDiagnosticError(error, protectedValues);
  assert.match(error.stdoutExcerpt, /public-context/);
  assert.match(error.stderrExcerpt, /public-context/);
  assert.match(error.stdoutExcerpt, /\[REDACTED\]/);
  assert.match(error.stderrExcerpt, /\[REDACTED\]/);
  assert.equal(error.exitCode, 7);
});

test('token-like protected literals are removed before generic redaction on both streams', async () => {
  const protectedValues = [
    'PRIVATEPREFIX-token=ABCDEF123456-PRIVATESUFFIX',
    'PRIVATEPREFIX bearer ABCDEF123456 PRIVATESUFFIX',
    'PRIVATEPREFIX-secret=ABCDEF123456-PRIVATESUFFIX'
  ];
  const script = [
    "const values=process.argv.slice(1)",
    "const text='public-before\\n'+values.join('\\npublic-between\\n')+'\\npublic-after'",
    'process.stdout.write(text)',
    'process.stderr.write(text)',
    'process.exit(17)'
  ].join(';');
  const error = await captureError(runControlledProcess(
    process.execPath,
    nodeEval(script, protectedValues),
    defaultOptions
  ));
  assertPolicyCode(error, CHILD_PROCESS_ERROR_CODES.nonzero);
  recordDiagnosticError(error, [
    ...protectedValues,
    'PRIVATEPREFIX',
    'PRIVATESUFFIX',
    'ABCDEF123456'
  ]);
  for (const excerpt of [error.stdoutExcerpt, error.stderrExcerpt]) {
    assert.match(excerpt, /public-before/);
    assert.match(excerpt, /public-after/);
    assert.match(excerpt, /\[REDACTED\]/);
    assert.doesNotMatch(excerpt, /PRIVATEPREFIX|PRIVATESUFFIX|ABCDEF123456/);
  }
});

test('control characters inside protected literals cannot leave normalized near-copies', async () => {
  const cases = [
    'TABPRIVATEPREFIX\tCONTROLVALUE-TABPRIVATESUFFIX',
    'CRPRIVATEPREFIX\rCONTROLVALUE-CRPRIVATESUFFIX',
    'LFPRIVATEPREFIX\nCONTROLVALUE-LFPRIVATESUFFIX',
    'C0PRIVATEPREFIX\u0001CONTROLVALUE-C0PRIVATESUFFIX'
  ];
  const script = [
    "const text='public-before\\n'+process.argv.slice(1).join('\\npublic-between\\n')+'\\npublic-after'",
    'process.stdout.write(text)',
    'process.stderr.write(text)',
    'process.exit(18)'
  ].join(';');
  const error = await captureError(runControlledProcess(
    process.execPath,
    nodeEval(script, cases),
    defaultOptions
  ));
  const nearCopies = cases.map(value => value.replace(/[\u0000-\u001F\u007F]/g, '\uFFFD'));
  recordDiagnosticError(error, [
    ...cases,
    ...nearCopies,
    'PRIVATEPREFIX',
    'PRIVATESUFFIX',
    'CONTROLVALUE'
  ]);
  for (const excerpt of [error.stdoutExcerpt, error.stderrExcerpt]) {
    assert.match(excerpt, /public-before/);
    assert.match(excerpt, /public-after/);
    assert.match(excerpt, /\[REDACTED\]/);
    assert.doesNotMatch(excerpt, /PRIVATEPREFIX|PRIVATESUFFIX|CONTROLVALUE/);
    assert.doesNotMatch(excerpt, /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/);
  }
});

test('path-bearing token-like arguments leave no complete or partial private marker', async () => {
  const syntheticRoot = path.join(path.parse(projectRoot).root, 'SyntheticPrivate', 'R2Argument');
  const privateArgument = path.join(
    syntheticRoot,
    'PATHPRIVATEPREFIX-token=ABCDEF123456-PATHPRIVATESUFFIX'
  );
  const script = "process.stdout.write('public-before\\n'+process.argv[1]+'\\npublic-after');process.stderr.write(process.argv[1]);process.exit(19)";
  const error = await captureError(runControlledProcess(
    process.execPath,
    nodeEval(script, [privateArgument]),
    defaultOptions
  ));
  recordDiagnosticError(error, [
    privateArgument,
    syntheticRoot,
    'PATHPRIVATEPREFIX',
    'PATHPRIVATESUFFIX',
    'ABCDEF123456'
  ]);
  for (const excerpt of [error.stdoutExcerpt, error.stderrExcerpt]) {
    assert.match(excerpt, /\[REDACTED\]/);
    assert.doesNotMatch(excerpt, /PATHPRIVATEPREFIX|PATHPRIVATESUFFIX|ABCDEF123456/);
  }
});

test('longest-first protected replacement handles overlapping token-like values', async () => {
  const shorter = 'token=OVERLAPSECRET012345';
  const longer = `OVERLAPPRIVATEPREFIX-${shorter}-OVERLAPPRIVATESUFFIX`;
  const script = "const text=process.argv[1]+'|public-middle|'+process.argv[2];process.stdout.write(text);process.stderr.write(text);process.exit(20)";
  const error = await captureError(runControlledProcess(
    process.execPath,
    nodeEval(script, [longer, shorter]),
    defaultOptions
  ));
  recordDiagnosticError(error, [
    longer,
    shorter,
    'OVERLAPPRIVATEPREFIX',
    'OVERLAPPRIVATESUFFIX',
    'OVERLAPSECRET012345'
  ]);
  for (const excerpt of [error.stdoutExcerpt, error.stderrExcerpt]) {
    assert.match(excerpt, /public-middle/);
    assert.match(excerpt, /\[REDACTED\]/);
    assert.doesNotMatch(excerpt, /OVERLAPPRIVATEPREFIX|OVERLAPPRIVATESUFFIX|OVERLAPSECRET012345/);
  }
});

test('truncation boundaries redact multiple and overlapping protected values before the 4096-byte limit', async () => {
  const syntheticRoot = path.join(path.parse(projectRoot).root, 'SyntheticPrivate', 'BoundaryRoot');
  const protectedValue = path.join(syntheticRoot, 'BoundaryProtectedValue-Unique0123456789');
  const overlappingValue = path.join(protectedValue, 'NestedOverlapUnique9876543210');
  const cases = [
    `${'A'.repeat(4084)}${protectedValue}|after`,
    `${'B'.repeat(4096 - Buffer.byteLength(protectedValue) + 2)}${protectedValue}|after`,
    `public|${protectedValue}|middle|${protectedValue}|tail`,
    `${'C'.repeat(4084)}${overlappingValue}|after`
  ];
  for (const output of cases) {
    const script = `process.stdout.write(${JSON.stringify(output)});process.stderr.write(${JSON.stringify(output)});process.exit(8)`;
    const error = await captureError(runControlledProcess(
      process.execPath,
      nodeEval(script, [protectedValue, overlappingValue]),
      defaultOptions
    ));
    assertPolicyCode(error, CHILD_PROCESS_ERROR_CODES.nonzero);
    recordDiagnosticError(error, [protectedValue, overlappingValue]);
    assert.ok(Buffer.byteLength(error.stdoutExcerpt) <= 4096);
    assert.ok(Buffer.byteLength(error.stderrExcerpt) <= 4096);
    for (const value of [protectedValue, overlappingValue]) {
      for (let length = 3; length < value.length; length += 1) {
        assert.equal(error.stdoutExcerpt.includes(value.slice(0, length)), false);
        assert.equal(error.stdoutExcerpt.includes(value.slice(-length)), false);
        assert.equal(error.stderrExcerpt.includes(value.slice(0, length)), false);
        assert.equal(error.stderrExcerpt.includes(value.slice(-length)), false);
      }
    }
  }
});

test('async spawn failure exposes only the approved sanitized cause schema', async () => {
  const syntheticRoot = path.join(path.parse(projectRoot).root, 'SyntheticPrivate', 'SpawnFailure');
  const executable = path.join(syntheticRoot, 'Missing Tool.exe');
  const privateArgument = path.join(syntheticRoot, 'Private&Argument.txt');
  const error = await captureError(runControlledProcess(executable, [privateArgument], defaultOptions));
  assertPolicyCode(error, CHILD_PROCESS_ERROR_CODES.spawn);
  assertSanitizedCause(error.cause, 'spawn');
  recordDiagnosticError(error, [syntheticRoot, executable, privateArgument, projectRoot]);
  assert.equal(error.executable, 'approved-executable');
});

test('hostile cause accessors are never invoked and cannot replace the policy error', async () => {
  const trapMarker = 'ACCESSOR_TRAP_PRIVATE_PATH_MARKER';
  let getterCalls = 0;
  const cause = {};
  for (const key of ['code', 'syscall', 'name', 'arbitrary']) {
    Object.defineProperty(cause, key, {
      enumerable: true,
      get() {
        getterCalls += 1;
        throw new Error(`${trapMarker}-${key}`);
      }
    });
  }
  const runner = createControlledProcessRunner({
    environment: { PATH: process.env.PATH ?? '' },
    platform: process.platform,
    spawnImpl() {
      throw cause;
    }
  });
  const error = await captureError(runner.runControlledProcess('approved-tool', [], defaultOptions));
  assertPolicyCode(error, CHILD_PROCESS_ERROR_CODES.spawn);
  assert.equal(getterCalls, 0);
  assertSanitizedCause(error.cause, 'spawn');
  recordDiagnosticError(error, [trapMarker]);
});

test('throwing descriptor traps and revoked proxies produce a generic unavailable cause', async () => {
  const cases = [];
  const descriptorMarker = 'DESCRIPTOR_TRAP_PRIVATE_PATH_MARKER';
  cases.push({
    marker: descriptorMarker,
    cause: new Proxy({}, {
      getOwnPropertyDescriptor() {
        throw new Error(descriptorMarker);
      }
    })
  });
  const revokedMarker = 'REVOKED_PROXY_PRIVATE_PATH_MARKER';
  const revoked = Proxy.revocable({}, {});
  revoked.revoke();
  cases.push({ marker: revokedMarker, cause: revoked.proxy });

  for (const { marker, cause } of cases) {
    const runner = createControlledProcessRunner({
      environment: { PATH: process.env.PATH ?? '' },
      platform: process.platform,
      spawnImpl() {
        throw cause;
      }
    });
    const error = await captureError(runner.runControlledProcess('approved-tool', [], defaultOptions));
    assertPolicyCode(error, CHILD_PROCESS_ERROR_CODES.spawn);
    assertSanitizedCause(error.cause, 'unavailable');
    recordDiagnosticError(error, [marker]);
  }
});

test('cause inspection does not enumerate and retains only approved own string data', async () => {
  const ownKeysMarker = 'OWNKEYS_TRAP_PRIVATE_PATH_MARKER';
  let ownKeysCalls = 0;
  const cause = new Proxy(
    {
      code: 'ENOENT',
      syscall: 'spawn approved-tool',
      path: ownKeysMarker,
      nested: { private: ownKeysMarker }
    },
    {
      ownKeys() {
        ownKeysCalls += 1;
        throw new Error(ownKeysMarker);
      }
    }
  );
  const runner = createControlledProcessRunner({
    environment: { PATH: process.env.PATH ?? '' },
    platform: process.platform,
    spawnImpl() {
      throw cause;
    }
  });
  const error = await captureError(runner.runControlledProcess('approved-tool', [], defaultOptions));
  assertPolicyCode(error, CHILD_PROCESS_ERROR_CODES.spawn);
  assert.equal(ownKeysCalls, 0);
  assertSanitizedCause(error.cause, 'spawn');
  assert.equal(error.cause.code, 'ENOENT');
  assert.equal(error.cause.syscall, 'spawn');
  recordDiagnosticError(error, [ownKeysMarker]);
});

test('hostile synchronous native causes cannot escape during error classification', () => {
  const accessorMarker = 'SYNC_ACCESSOR_PRIVATE_PATH_MARKER';
  let getterCalls = 0;
  const accessorCause = {};
  Object.defineProperty(accessorCause, 'code', {
    enumerable: true,
    get() {
      getterCalls += 1;
      throw new Error(accessorMarker);
    }
  });
  Object.defineProperty(accessorCause, 'syscall', {
    enumerable: true,
    get() {
      getterCalls += 1;
      throw new Error(accessorMarker);
    }
  });
  const accessorRunner = createControlledProcessRunner({
    environment: { PATH: process.env.PATH ?? '' },
    platform: process.platform,
    spawnSyncImpl() {
      return {
        status: null,
        signal: null,
        stdout: Buffer.alloc(0),
        stderr: Buffer.alloc(0),
        error: accessorCause
      };
    }
  });
  const accessorError = captureSyncError(
    () => accessorRunner.runControlledProcessSync('approved-tool', [], defaultOptions)
  );
  assertPolicyCode(accessorError, CHILD_PROCESS_ERROR_CODES.spawn);
  assert.equal(getterCalls, 0);
  assertSanitizedCause(accessorError.cause, 'spawn');
  recordDiagnosticError(accessorError, [accessorMarker]);

  const proxyMarker = 'SYNC_DESCRIPTOR_PRIVATE_PATH_MARKER';
  const proxyCause = new Proxy({}, {
    getOwnPropertyDescriptor() {
      throw new Error(proxyMarker);
    }
  });
  const proxyRunner = createControlledProcessRunner({
    environment: { PATH: process.env.PATH ?? '' },
    platform: process.platform,
    spawnSyncImpl() {
      return {
        status: null,
        signal: null,
        stdout: Buffer.alloc(0),
        stderr: Buffer.alloc(0),
        error: proxyCause
      };
    }
  });
  const proxyError = captureSyncError(
    () => proxyRunner.runControlledProcessSync('approved-tool', [], defaultOptions)
  );
  assertPolicyCode(proxyError, CHILD_PROCESS_ERROR_CODES.spawn);
  assertSanitizedCause(proxyError.cause, 'unavailable');
  recordDiagnosticError(proxyError, [proxyMarker]);
});

test('primitive, callable, and custom-prototype causes are reduced without prototype trust', () => {
  const causes = [null, 'primitive-private-marker', 42, Symbol('symbol-private-marker'), function exoticCause() {}];
  for (const cause of causes) {
    const error = new ChildProcessPolicyError(
      CHILD_PROCESS_ERROR_CODES.spawn,
      'Child process could not be started.',
      {},
      cause
    );
    assertPolicyCode(error, CHILD_PROCESS_ERROR_CODES.spawn);
    assertSanitizedCause(error.cause, 'spawn');
    recordDiagnosticError(error, ['primitive-private-marker', 'symbol-private-marker']);
  }

  let inheritedGetterCalls = 0;
  const prototype = {};
  Object.defineProperty(prototype, 'code', {
    get() {
      inheritedGetterCalls += 1;
      throw new Error('PROTOTYPE_PRIVATE_PATH_MARKER');
    }
  });
  const customCause = Object.create(prototype);
  customCause.path = 'PROTOTYPE_PRIVATE_PATH_MARKER';
  const customError = new ChildProcessPolicyError(
    CHILD_PROCESS_ERROR_CODES.spawn,
    'Child process could not be started.',
    {},
    customCause
  );
  assert.equal(inheritedGetterCalls, 0);
  assertSanitizedCause(customError.cause, 'spawn');
  assert.equal(customError.cause.code, undefined);
  recordDiagnosticError(customError, ['PROTOTYPE_PRIVATE_PATH_MARKER']);

  const noCause = new ChildProcessPolicyError(
    CHILD_PROCESS_ERROR_CODES.spawn,
    'Child process could not be started.',
    {},
    undefined
  );
  assert.equal(noCause.cause, undefined);
});

test('invalid cwd exposes no rejected path or raw filesystem cause', async () => {
  const missingCwd = path.join(path.parse(projectRoot).root, 'SyntheticPrivate', 'MissingCwdUnique');
  const error = await captureError(runControlledProcess(
    process.execPath,
    [],
    { ...defaultOptions, cwd: missingCwd }
  ));
  assertPolicyCode(error, CHILD_PROCESS_ERROR_CODES.invalid);
  assertSanitizedCause(error.cause, 'filesystem');
  recordDiagnosticError(error, [missingCwd, projectRoot, process.execPath]);
  assert.deepEqual(Object.keys(error), ['name', 'code']);

  const invalidInputError = await captureError(runControlledProcess('', [], defaultOptions));
  assertPolicyCode(invalidInputError, CHILD_PROCESS_ERROR_CODES.invalid);
  assertSanitizedCause(invalidInputError.cause, 'validation');
  recordDiagnosticError(invalidInputError, [projectRoot, process.execPath]);
});

test('path quote metacharacter arguments and explicit secret values never reach diagnostics', async () => {
  const syntheticRoot = path.join(path.parse(projectRoot).root, 'SyntheticPrivate', 'ArgumentSurface');
  const privateArgument = `${path.join(syntheticRoot, 'quoted value')}&"quoted"|pipe;redirect>`;
  const secret = 'argument-surface-secret-0123456789';
  const script = "process.stdout.write('public-before\\n'+process.argv[1]+'\\n'+process.env.YATZY_AUTHORIZATION+'\\npublic-after');process.stderr.write(process.argv[1]+'\\n'+process.env.YATZY_AUTHORIZATION);process.exit(9)";
  const error = await captureError(runControlledProcess(
    process.execPath,
    nodeEval(script, [privateArgument]),
    { ...defaultOptions, env: { YATZY_AUTHORIZATION: secret } }
  ));
  assertPolicyCode(error, CHILD_PROCESS_ERROR_CODES.nonzero);
  recordDiagnosticError(error, [syntheticRoot, privateArgument, secret, projectRoot, process.execPath]);
  assert.match(error.stdoutExcerpt, /public-before/);
  assert.match(error.stdoutExcerpt, /public-after/);

  const signalRunner = createControlledProcessRunner({
    environment: { PATH: process.env.PATH ?? '' },
    platform: process.platform,
    spawnImpl() {
      const child = new EventEmitter();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.kill = () => true;
      queueMicrotask(() => {
        child.stdout.emit('data', Buffer.from(`${privateArgument}\n${secret}`));
        child.emit('close', null, 'SIGTERM');
      });
      return child;
    }
  });
  const signalError = await captureError(signalRunner.runControlledProcess(
    process.execPath,
    [privateArgument],
    { ...defaultOptions, env: { YATZY_AUTHORIZATION: secret } }
  ));
  assertPolicyCode(signalError, CHILD_PROCESS_ERROR_CODES.signal);
  recordDiagnosticError(signalError, [syntheticRoot, privateArgument, secret, projectRoot, process.execPath]);
});

test('synchronous native failures use approved sanitized causes', () => {
  const syntheticRoot = path.join(path.parse(projectRoot).root, 'SyntheticPrivate', 'SyncFailure');
  const missingExecutable = path.join(syntheticRoot, 'MissingSyncTool.exe');
  const spawnError = captureSyncError(
    () => runControlledProcessSync(missingExecutable, [syntheticRoot], defaultOptions)
  );
  assertPolicyCode(spawnError, CHILD_PROCESS_ERROR_CODES.spawn);
  assertSanitizedCause(spawnError.cause, 'spawn');
  recordDiagnosticError(spawnError, [syntheticRoot, missingExecutable, projectRoot]);

  const timeoutError = captureSyncError(
    () => runControlledProcessSync(
      process.execPath,
      nodeEval("process.stdout.write(process.argv[1]);setInterval(()=>{},1000)", [syntheticRoot]),
      { ...defaultOptions, timeoutMs: 100 }
    )
  );
  assertPolicyCode(timeoutError, CHILD_PROCESS_ERROR_CODES.timeout);
  assertSanitizedCause(timeoutError.cause, 'timeout');
  recordDiagnosticError(timeoutError, [syntheticRoot, projectRoot, process.execPath]);

  const outputError = captureSyncError(
    () => runControlledProcessSync(
      process.execPath,
      nodeEval("process.stdout.write(Buffer.alloc(4096,65))", [syntheticRoot]),
      { ...defaultOptions, maxOutputBytes: 1024 }
    )
  );
  assertPolicyCode(outputError, CHILD_PROCESS_ERROR_CODES.stdout);
  assertSanitizedCause(outputError.cause, 'output');
  recordDiagnosticError(outputError, [syntheticRoot, projectRoot, process.execPath]);
});

test('cleanup failure uses the approved sanitized cause and stable prior code', async () => {
  const syntheticRoot = path.join(path.parse(projectRoot).root, 'SyntheticPrivate', 'CleanupFailure');
  const runner = createControlledProcessRunner({
    environment: { PATH: process.env.PATH ?? '' },
    platform: process.platform,
    spawnImpl() {
      const child = new EventEmitter();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.kill = () => {
        const error = new Error(`native cleanup rejected ${syntheticRoot}`);
        error.code = 'EPERM';
        error.syscall = `kill ${syntheticRoot}`;
        error.path = syntheticRoot;
        throw error;
      };
      return child;
    }
  });
  const keepAlive = setTimeout(() => {}, 1_000);
  let error;
  try {
    error = await captureError(runner.runControlledProcess(
      process.execPath,
      [syntheticRoot],
      { ...defaultOptions, timeoutMs: 10 }
    ));
  } finally {
    clearTimeout(keepAlive);
  }
  assertPolicyCode(error, CHILD_PROCESS_ERROR_CODES.cleanup);
  assert.equal(error.priorCode, CHILD_PROCESS_ERROR_CODES.timeout);
  assertSanitizedCause(error.cause, 'cleanup');
  recordDiagnosticError(error, [syntheticRoot, projectRoot, process.execPath]);
});

test('stdout, stderr, Unicode, and exact bytes are captured on success', async () => {
  const result = await runControlledProcess(
    process.execPath,
    nodeEval("process.stdout.write('hello π');process.stderr.write('warning ✓')"),
    defaultOptions
  );
  assert.equal(result.stdout, 'hello π');
  assert.equal(result.stderr, 'warning ✓');
  const bytes = await runControlledProcess(
    process.execPath,
    nodeEval('process.stdout.write(Buffer.from([0,1,2,255]))'),
    { ...defaultOptions, encoding: 'buffer' }
  );
  assert.deepEqual([...bytes.stdout], [0, 1, 2, 255]);
});

test('stdout overflow is deterministic and bounded', async () => {
  const limit = 1024;
  await assert.rejects(
    runControlledProcess(
      process.execPath,
      nodeEval('process.stdout.write(Buffer.alloc(4096, 65))'),
      { ...defaultOptions, maxOutputBytes: limit }
    ),
    error => {
      assertPolicyCode(error, CHILD_PROCESS_ERROR_CODES.stdout);
      assert.ok(Buffer.byteLength(error.stdoutExcerpt) <= limit);
      return true;
    }
  );
});

test('stderr overflow is deterministic and bounded', async () => {
  const limit = 1024;
  await assert.rejects(
    runControlledProcess(
      process.execPath,
      nodeEval('process.stderr.write(Buffer.alloc(4096, 66))'),
      { ...defaultOptions, maxOutputBytes: limit }
    ),
    error => {
      assertPolicyCode(error, CHILD_PROCESS_ERROR_CODES.stderr);
      assert.ok(Buffer.byteLength(error.stderrExcerpt) <= limit);
      return true;
    }
  );
});

test('nonzero exit and spawn failure have stable categories without shell strings', async () => {
  await assert.rejects(
    runControlledProcess(process.execPath, nodeEval('process.exit(23)'), defaultOptions),
    error => {
      assertPolicyCode(error, CHILD_PROCESS_ERROR_CODES.nonzero);
      assert.equal(error.exitCode, 23);
      assert.equal(error.message.includes(projectRoot), false);
      assert.equal(error.message.includes('process.exit'), false);
      return true;
    }
  );
  await assert.rejects(
    runControlledProcess(`yatzy-missing-executable-${process.pid}-${Date.now()}`, [], defaultOptions),
    error => assertPolicyCode(error, CHILD_PROCESS_ERROR_CODES.spawn)
  );
});

test('timeout terminates the directly spawned process', async () => {
  const { observation, spawnImpl } = retainSpawnedChildLifecycle();
  const runner = createControlledProcessRunner({ spawnImpl });
  let error;
  try {
    await runner.runControlledProcess(
      process.execPath,
      nodeEval("process.stdout.write(String(process.pid)+'\\n');setInterval(()=>{},1000)"),
      { ...defaultOptions, timeoutMs: 100 }
    );
  } catch (caught) {
    error = caught;
  }
  assertPolicyCode(error, CHILD_PROCESS_ERROR_CODES.timeout);
  assertSpawnedChildLifecycle(observation, error);
});

test('already-aborted input fails before spawn', async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    runControlledProcess(process.execPath, nodeEval('process.stdout.write("not-run")'), { ...defaultOptions, signal: controller.signal }),
    error => assertPolicyCode(error, CHILD_PROCESS_ERROR_CODES.aborted)
  );
});

test('active abort terminates the direct child, settles once, and removes its listener', async () => {
  const controller = new AbortController();
  const { observation, spawnImpl } = retainSpawnedChildLifecycle();
  const runner = createControlledProcessRunner({ spawnImpl });
  let settlements = 0;
  const execution = runner.runControlledProcess(
    process.execPath,
    nodeEval("process.stdout.write(String(process.pid)+'\\n');setInterval(()=>{},1000)"),
    { ...defaultOptions, signal: controller.signal }
  ).then(
    value => {
      settlements += 1;
      return value;
    },
    error => {
      settlements += 1;
      throw error;
    }
  );
  setTimeout(() => controller.abort(), 100);
  let error;
  try {
    await execution;
  } catch (caught) {
    error = caught;
  }
  assertPolicyCode(error, CHILD_PROCESS_ERROR_CODES.aborted);
  assert.equal(settlements, 1);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  assertSpawnedChildLifecycle(observation, error);
});

test('synchronous runner enforces success, nonzero, timeout, and output ceilings', () => {
  const success = runControlledProcessSync(process.execPath, nodeEval("process.stdout.write('sync-ok')"), defaultOptions);
  assert.equal(success.stdout, 'sync-ok');
  assert.throws(
    () => runControlledProcessSync(process.execPath, nodeEval('process.exit(9)'), defaultOptions),
    error => assertPolicyCode(error, CHILD_PROCESS_ERROR_CODES.nonzero)
  );
  assert.throws(
    () => runControlledProcessSync(process.execPath, nodeEval('setInterval(()=>{},1000)'), { ...defaultOptions, timeoutMs: 100 }),
    error => assertPolicyCode(error, CHILD_PROCESS_ERROR_CODES.timeout)
  );
  assert.throws(
    () => runControlledProcessSync(process.execPath, nodeEval('process.stdout.write(Buffer.alloc(4096))'), { ...defaultOptions, maxOutputBytes: 1024 }),
    error => assertPolicyCode(error, CHILD_PROCESS_ERROR_CODES.stdout)
  );
  assert.throws(
    () => runControlledProcessSync(process.execPath, nodeEval('process.stderr.write(Buffer.alloc(4096))'), { ...defaultOptions, maxOutputBytes: 1024 }),
    error => assertPolicyCode(error, CHILD_PROCESS_ERROR_CODES.stderr)
  );
});

test('synchronous runner rejects an already-aborted signal before spawn', () => {
  const controller = new AbortController();
  controller.abort();
  assert.throws(
    () => runControlledProcessSync(process.execPath, [], { ...defaultOptions, signal: controller.signal }),
    error => assertPolicyCode(error, CHILD_PROCESS_ERROR_CODES.aborted)
  );
});

test('Git identity wrapper delegates exact safe options to the shared async API', async () => {
  const calls = [];
  const output = await runGit(['rev-parse', 'HEAD'], async (executable, args, options) => {
    calls.push({ executable, args, options });
    return { status: 0, signal: null, stdout: 'abc123\n', stderr: '' };
  });
  assert.equal(output, 'abc123');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].executable, 'git');
  assert.deepEqual(calls[0].args, ['rev-parse', 'HEAD']);
  assert.equal(path.isAbsolute(calls[0].options.cwd), true);
  assert.equal(calls[0].options.timeoutMs, 30_000);
  assert.equal(calls[0].options.maxOutputBytes, 1024 * 1024);
  assert.equal(calls[0].options.shell, undefined);
});

test('archive and clean-room Node call sites run through the shared synchronous policy', t => {
  const root = ownedTemporaryDirectory(t, 'yatzy-policy-archive-');
  const sourceSnapshot = path.join(root, 'source_snapshot');
  const testDirectory = path.join(sourceSnapshot, 'engine', 'test');
  fs.mkdirSync(testDirectory, { recursive: true });
  fs.writeFileSync(
    path.join(testDirectory, 'tiny.test.mjs'),
    "import test from 'node:test';import assert from 'node:assert/strict';test('tiny',()=>assert.equal(1,1));\n"
  );
  const archive = path.join(root, 'controlled.zip');
  createZip(root, archive);
  assert.ok(listZip(archive).some(name => name.includes('tiny.test.mjs')));
  const clean = path.join(root, 'clean');
  const report = cleanRoomTest(archive, clean);
  assert.equal(report.passed, true);
  assert.equal(report.exitCode, 0);
});

test('browser caller delegates exact policy and preserves successful rendering', t => {
  const root = ownedTemporaryDirectory(t, 'yatzy-policy-browser-');
  const dossier = path.join(root, 'dossier.html');
  fs.writeFileSync(dossier, '<!doctype html><title>test</title>');
  const calls = [];
  const browser = path.join(root, 'Browser With Spaces.exe');
  const result = renderDossierPdf(dossier, {}, {
    browsers: [browser],
    runner(executable, args, options) {
      calls.push({ executable, args, options });
      const outputArgument = args.find(value => value.startsWith('--print-to-pdf='));
      fs.writeFileSync(outputArgument.slice('--print-to-pdf='.length), Buffer.alloc(1200, 1));
      return { status: 0, signal: null, stdout: '', stderr: '' };
    }
  });
  assert.equal(result.browser, browser);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].executable, browser);
  assert.equal(path.isAbsolute(calls[0].options.cwd), true);
  assert.equal(calls[0].options.timeoutMs, 30_000);
  assert.equal(calls[0].options.maxOutputBytes, 1024 * 1024);
  assert.equal(calls[0].args.some(value => value.includes('dossier.html')), true);
});

test('browser execution failure preserves the existing simple-PDF fallback', t => {
  const root = ownedTemporaryDirectory(t, 'yatzy-policy-browser-fallback-');
  const dossier = path.join(root, 'dossier.html');
  fs.writeFileSync(dossier, '<!doctype html><title>test</title>');
  const fallback = renderDossierPdf(dossier, {
    exact: { midpoint: 1 },
    simulation: { totalGames: 1, mean: 1, bonusFrequency: 0, yatzyFrequency: 0 }
  }, {
    browsers: ['approved-browser'],
    runner() {
      throw new ChildProcessPolicyError(CHILD_PROCESS_ERROR_CODES.nonzero, 'failed');
    }
  });
  assert.equal(fallback.browser, null);
  assert.equal(fallback.fallback, true);
  assert.ok(fs.statSync(fallback.pdf).size > 0);
});

test('production source has no direct child-process import outside the shared module', () => {
  const approved = path.join(sourceRoot, 'util', 'child-process.mjs');
  const files = [];
  const visit = directory => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(absolute);
      else if (entry.isFile() && entry.name.endsWith('.mjs')) files.push(absolute);
    }
  };
  visit(sourceRoot);
  const failures = [];
  for (const file of files) {
    if (file === approved) continue;
    const code = withoutComments(fs.readFileSync(file, 'utf8'));
    if (/(?:from\s*|import\s*\()\s*['"](?:node:)?child_process['"]/.test(code)) {
      failures.push(path.relative(projectRoot, file).replaceAll('\\', '/'));
    }
  }
  assert.deepEqual(failures, []);
});

test('tracked production caller set imports only the shared policy and the test-only exception stays explicit', () => {
  const productionCallers = [
    'engine/src/analysis/dossier.mjs',
    'engine/src/v3/archive.mjs',
    'engine/src/v3/official-pipeline.mjs'
  ];
  for (const relative of productionCallers) {
    const source = fs.readFileSync(path.join(projectRoot, relative), 'utf8');
    assert.match(source, /util\/child-process\.mjs/);
    assert.doesNotMatch(source, /from\s+['"]node:child_process['"]/);
  }
  const testOnly = fs.readFileSync(path.join(projectRoot, 'engine/test/config-profiles.test.mjs'), 'utf8');
  assert.match(testOnly, /from\s+['"]node:child_process['"]/);
});

test('recursive diagnostic leak scan passes for every newly captured error', () => {
  assert.ok(diagnosticErrors.length >= 20);
  for (const { error, protectedValues } of diagnosticErrors) {
    assertDiagnosticSafe(error, protectedValues);
    if (error.cause !== undefined) {
      assertSanitizedCause(error.cause, error.cause.category);
    }
  }
});
