import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';

const ERROR_CODES = Object.freeze({
  invalid: 'YATZY_CHILD_POLICY_INVALID',
  spawn: 'YATZY_CHILD_SPAWN_FAILED',
  timeout: 'YATZY_CHILD_TIMEOUT',
  stdout: 'YATZY_CHILD_STDOUT_LIMIT',
  stderr: 'YATZY_CHILD_STDERR_LIMIT',
  nonzero: 'YATZY_CHILD_NONZERO_EXIT',
  signal: 'YATZY_CHILD_SIGNAL',
  aborted: 'YATZY_CHILD_ABORTED',
  cleanup: 'YATZY_CHILD_CLEANUP_FAILED'
});

const COMMON_ENVIRONMENT = Object.freeze([
  'PATH',
  'HOME',
  'TEMP',
  'TMP',
  'TMPDIR',
  'LANG',
  'LC_ALL',
  'TZ'
]);

const WINDOWS_ENVIRONMENT = Object.freeze([
  'PATHEXT',
  'SYSTEMROOT',
  'WINDIR',
  'COMSPEC',
  'USERPROFILE',
  'HOMEDRIVE',
  'HOMEPATH',
  'APPDATA',
  'LOCALAPPDATA',
  'PROGRAMDATA',
  'PROGRAMFILES',
  'PROGRAMFILES(X86)'
]);

const WINDOWS_SUPPRESSED_ENVIRONMENT = Object.freeze([
  'LOGONSERVER',
  'SYSTEMDRIVE',
  'USERDOMAIN',
  'USERNAME'
]);

const POSIX_ENVIRONMENT = Object.freeze([
  'XDG_CONFIG_HOME',
  'XDG_CACHE_HOME',
  'XDG_RUNTIME_DIR'
]);

const OPTION_KEYS = new Set(['cwd', 'timeoutMs', 'maxOutputBytes', 'env', 'encoding', 'signal']);
const FACTORY_KEYS = new Set(['spawnImpl', 'spawnSyncImpl', 'environment', 'platform']);
const MAX_TIMEOUT_MS = 24 * 60 * 60 * 1000;
const MAX_OUTPUT_BYTES = 256 * 1024 * 1024;
const ERROR_EXCERPT_BYTES = 4096;
const MIN_REDACTION_LENGTH = 3;
const REDACTION_MARKER = '[REDACTED]';
const TERMINATION_GRACE_MS = 250;
const CLEANUP_DEADLINE_MS = 1000;
const SAFE_NATIVE_SYSCALLS = new Set([
  'spawn',
  'open',
  'stat',
  'lstat',
  'realpath',
  'access',
  'kill',
  'wait',
  'read',
  'write'
]);

function invalidPolicy(cause) {
  return new ChildProcessPolicyError(
    ERROR_CODES.invalid,
    'Invalid child-process policy input.',
    {},
    cause
  );
}

function ownDataDescriptors(value, allowedKeys, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    throw invalidPolicy(new TypeError(`${label} must be a plain object`));
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key !== 'string' || !allowedKeys.has(key)) {
      throw invalidPolicy(new TypeError(`${label} contains an unsupported key`));
    }
    const descriptor = descriptors[key];
    if (!descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) {
      throw invalidPolicy(new TypeError(`${label} must contain enumerable data properties only`));
    }
  }
  return descriptors;
}

function validateExecutable(executable) {
  if (typeof executable !== 'string' || executable.length === 0 || executable.trim().length === 0 || executable.includes('\0')) {
    throw invalidPolicy(new TypeError('executable must be a non-empty string'));
  }
  return executable;
}

function validateArguments(args) {
  if (!Array.isArray(args) || Object.getPrototypeOf(args) !== Array.prototype) {
    throw invalidPolicy(new TypeError('args must be a plain array'));
  }
  const descriptors = Object.getOwnPropertyDescriptors(args);
  if (Reflect.ownKeys(descriptors).some(key => typeof key !== 'string')) {
    throw invalidPolicy(new TypeError('args may not contain symbol properties'));
  }
  for (let index = 0; index < args.length; index += 1) {
    const descriptor = descriptors[String(index)];
    if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value') || typeof descriptor.value !== 'string' || descriptor.value.includes('\0')) {
      throw invalidPolicy(new TypeError('every argument must be an own string data property'));
    }
  }
  for (const key of Object.keys(descriptors)) {
    if (key === 'length') continue;
    if (!/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= args.length) {
      throw invalidPolicy(new TypeError('args contains a non-index property'));
    }
  }
  return args.slice();
}

function validateWorkingDirectory(cwd) {
  if (typeof cwd !== 'string' || cwd.length === 0 || cwd.includes('\0') || !path.isAbsolute(cwd)) {
    throw invalidPolicy(new TypeError('cwd must be an absolute path'));
  }
  try {
    const canonical = fs.realpathSync.native(path.resolve(cwd));
    if (!fs.statSync(canonical).isDirectory()) throw new TypeError('cwd is not a directory');
    return canonical;
  } catch (error) {
    throw invalidPolicy(error);
  }
}

function validatePositiveInteger(value, maximum, label) {
  if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) {
    throw invalidPolicy(new TypeError(`${label} must be a positive bounded integer`));
  }
  return value;
}

function isSensitiveEnvironmentName(name) {
  return /(?:secret|token|password|passphrase|credential|authorization|api[_-]?key)/i.test(name);
}

function isPrivateEnvironmentName(name) {
  return /^(?:HOME|USERPROFILE|HOMEDRIVE|HOMEPATH|TEMP|TMP|TMPDIR|USERNAME|USER|APPDATA|LOCALAPPDATA|XDG_CONFIG_HOME|XDG_CACHE_HOME|XDG_RUNTIME_DIR)$/i.test(name);
}

function isPathBearing(value) {
  return /(?:^[A-Za-z]:[\\/]|^\\\\|^\/|[\\/])/.test(value);
}

function environmentKey(name, platform) {
  return platform === 'win32' ? name.toUpperCase() : name;
}

function validateEnvironmentRecord(value) {
  if (value === undefined) return Object.freeze({ values: Object.freeze({}) });
  if (value === null || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    throw invalidPolicy(new TypeError('env must be a plain object'));
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const values = {};
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key !== 'string' || key === '__proto__' || key === 'prototype' || key === 'constructor' || key.length === 0 || key.includes('=') || key.includes('\0')) {
      throw invalidPolicy(new TypeError('env contains an invalid name'));
    }
    const descriptor = descriptors[key];
    if (!descriptor.enumerable || !Object.hasOwn(descriptor, 'value') || typeof descriptor.value !== 'string' || descriptor.value.includes('\0')) {
      throw invalidPolicy(new TypeError('env values must be enumerable own strings'));
    }
    values[key] = descriptor.value;
  }
  return Object.freeze({ values: Object.freeze(values) });
}

function snapshotInheritedEnvironment(environment, platform, trustedProcessEnvironment = false) {
  if (
    environment === null
    || typeof environment !== 'object'
    || Array.isArray(environment)
    || (!trustedProcessEnvironment && Object.getPrototypeOf(environment) !== Object.prototype)
  ) {
    throw invalidPolicy(new TypeError('inherited environment must be a plain object'));
  }
  const descriptors = Object.getOwnPropertyDescriptors(environment);
  if (Reflect.ownKeys(descriptors).some(key => typeof key !== 'string')) {
    throw invalidPolicy(new TypeError('inherited environment may not contain symbols'));
  }
  const descriptorMap = new Map();
  for (const [name, descriptor] of Object.entries(descriptors)) {
    if (!Object.hasOwn(descriptor, 'value') || typeof descriptor.value !== 'string') {
      throw invalidPolicy(new TypeError('inherited environment must contain string data properties'));
    }
    descriptorMap.set(environmentKey(name, platform), { name, value: descriptor.value });
  }
  const allowedNames = [
    ...COMMON_ENVIRONMENT,
    ...(platform === 'win32' ? [...WINDOWS_ENVIRONMENT, ...WINDOWS_SUPPRESSED_ENVIRONMENT] : POSIX_ENVIRONMENT)
  ];
  const inherited = Object.create(null);
  const controlledKeys = new Set();
  for (const requestedName of allowedNames) {
    const normalized = environmentKey(requestedName, platform);
    controlledKeys.add(normalized);
    const entry = descriptorMap.get(normalized);
    if (entry) inherited[entry.name] = entry.value;
  }
  if (platform === 'win32') {
    for (const name of WINDOWS_SUPPRESSED_ENVIRONMENT) inherited[name] = '';
  }
  return Object.freeze({
    inherited: Object.freeze(inherited),
    controlledKeys: Object.freeze(controlledKeys),
    allowedNames: Object.freeze(allowedNames.slice())
  });
}

function buildEnvironment(snapshot, additions, platform) {
  const explicit = validateEnvironmentRecord(additions);
  const result = Object.create(null);
  const explicitRedactionValues = [];
  for (const [name, value] of Object.entries(snapshot.inherited)) result[name] = value;
  for (const [name, value] of Object.entries(explicit.values)) {
    if (snapshot.controlledKeys.has(environmentKey(name, platform))) {
      throw invalidPolicy(new TypeError('env may not overwrite a controlled inherited variable'));
    }
    result[name] = value;
    if (isSensitiveEnvironmentName(name) || isPrivateEnvironmentName(name) || isPathBearing(value)) {
      explicitRedactionValues.push(value);
    }
  }
  return { environment: result, explicitRedactionValues: Object.freeze(explicitRedactionValues) };
}

function validateOptions(options, snapshot, platform) {
  const descriptors = ownDataDescriptors(options, OPTION_KEYS, 'options');
  for (const required of ['cwd', 'timeoutMs', 'maxOutputBytes']) {
    if (!descriptors[required]) throw invalidPolicy(new TypeError(`missing ${required}`));
  }
  const cwd = validateWorkingDirectory(descriptors.cwd.value);
  const timeoutMs = validatePositiveInteger(descriptors.timeoutMs.value, MAX_TIMEOUT_MS, 'timeoutMs');
  const maxOutputBytes = validatePositiveInteger(descriptors.maxOutputBytes.value, MAX_OUTPUT_BYTES, 'maxOutputBytes');
  const encoding = descriptors.encoding?.value ?? 'utf8';
  if (encoding !== 'utf8' && encoding !== 'buffer') throw invalidPolicy(new TypeError('encoding must be utf8 or buffer'));
  const signal = descriptors.signal?.value;
  if (signal !== undefined && !(signal instanceof AbortSignal)) throw invalidPolicy(new TypeError('signal must be an AbortSignal'));
  const { environment, explicitRedactionValues } = buildEnvironment(snapshot, descriptors.env?.value, platform);
  return Object.freeze({ cwd, timeoutMs, maxOutputBytes, encoding, signal, environment, explicitRedactionValues });
}

function environmentValue(environment, requestedName, platform) {
  const requestedKey = environmentKey(requestedName, platform);
  for (const [name, value] of Object.entries(environment)) {
    if (environmentKey(name, platform) === requestedKey) return value;
  }
  return '';
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function buildRedactionContext(executable, args, options, platform) {
  const caseInsensitive = platform === 'win32';
  const pathApi = platform === 'win32' ? path.win32 : path.posix;
  const values = new Map();
  const add = (candidate, pathBearing = false) => {
    if (typeof candidate !== 'string' || candidate.length < MIN_REDACTION_LENGTH || /^[\\/]+$/.test(candidate)) return;
    const variants = new Set([candidate]);
    if (pathBearing || isPathBearing(candidate)) {
      variants.add(pathApi.normalize(candidate));
      if (candidate.includes('\\')) variants.add(candidate.replaceAll('\\', '/'));
      if (candidate.includes('/')) variants.add(candidate.replaceAll('/', '\\'));
    }
    for (const value of variants) {
      if (value.length < MIN_REDACTION_LENGTH || /^[\\/]+$/.test(value)) continue;
      const key = caseInsensitive ? value.toLocaleLowerCase('en-US') : value;
      if (!values.has(key)) values.set(key, value);
    }
  };

  add(executable, true);
  add(pathApi.dirname(executable), true);
  for (const argument of args) add(argument, isPathBearing(argument));
  add(options.cwd, true);

  for (const [name, value] of Object.entries(options.environment)) {
    if (isPrivateEnvironmentName(name) || isSensitiveEnvironmentName(name) || isPathBearing(value)) {
      add(value, isPathBearing(value));
    }
  }
  for (const value of options.explicitRedactionValues) add(value, isPathBearing(value));

  const homeDrive = environmentValue(options.environment, 'HOMEDRIVE', platform);
  const homePath = environmentValue(options.environment, 'HOMEPATH', platform);
  if (homeDrive && homePath) add(`${homeDrive}${homePath}`, true);

  try {
    add(os.homedir(), true);
  } catch {
    // The environment-derived home values above remain authoritative.
  }
  try {
    add(os.tmpdir(), true);
  } catch {
    // The environment-derived temporary values above remain authoritative.
  }
  try {
    add(os.hostname());
  } catch {
    // Hostname is optional when the platform cannot provide it safely.
  }
  try {
    add(os.userInfo().username);
  } catch {
    // Username is optional when the platform cannot provide it safely.
  }

  const ordered = [...values.values()].sort((left, right) => {
    const byteDifference = Buffer.byteLength(right) - Buffer.byteLength(left);
    return byteDifference || right.length - left.length || left.localeCompare(right);
  });
  return Object.freeze({
    caseInsensitive,
    values: Object.freeze(ordered),
    maxValueBytes: ordered.reduce((maximum, value) => Math.max(maximum, Buffer.byteLength(value)), 0)
  });
}

function redactBoundaryPrefix(value, context) {
  for (const protectedValue of context.values) {
    const maximum = Math.min(protectedValue.length - 1, value.length);
    for (let length = maximum; length >= MIN_REDACTION_LENGTH; length -= 1) {
      const tail = value.slice(-length);
      const prefix = protectedValue.slice(0, length);
      const matches = context.caseInsensitive
        ? tail.toLocaleLowerCase('en-US') === prefix.toLocaleLowerCase('en-US')
        : tail === prefix;
      if (matches) return `${value.slice(0, -length)}${REDACTION_MARKER}`;
    }
  }
  return value;
}

function redact(text, context) {
  let value = text;
  for (const protectedValue of context.values) {
    value = value.replace(
      new RegExp(escapeRegExp(protectedValue), context.caseInsensitive ? 'gi' : 'g'),
      REDACTION_MARKER
    );
  }
  return redactBoundaryPrefix(value, context)
    .replace(/(bearer\s+)[A-Za-z0-9._~+\/=-]+/gi, `$1${REDACTION_MARKER}`)
    .replace(/((?:secret|token|password|passphrase|credential|authorization|api[_-]?key)\s*[:=]\s*)[^\s,;]+/gi, `$1${REDACTION_MARKER}`)
    .replace(/\0/g, '\uFFFD')
    .replace(/[\u0001-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '\uFFFD');
}

function truncateUtf8(value, maximumBytes) {
  if (Buffer.byteLength(value) <= maximumBytes) return value;
  let result = '';
  let bytes = 0;
  for (const character of value) {
    const characterBytes = Buffer.byteLength(character);
    if (bytes + characterBytes > maximumBytes) break;
    result += character;
    bytes += characterBytes;
  }
  return result;
}

function excerpt(buffer, context) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) return '';
  const lookaheadBytes = Math.min(
    buffer.length,
    ERROR_EXCERPT_BYTES + Math.max(0, context.maxValueBytes - 1)
  );
  const redacted = redact(buffer.subarray(0, lookaheadBytes).toString('utf8'), context);
  return truncateUtf8(redacted, ERROR_EXCERPT_BYTES);
}

function executableIdentifier(executable) {
  const identifier = path.basename(executable);
  return /^[A-Za-z0-9._-]{1,128}$/.test(identifier) ? identifier : 'approved-executable';
}

function errorDetails(executable, options, context, stdout, stderr, extra = {}) {
  return {
    executable: executableIdentifier(executable),
    timeoutMs: options.timeoutMs,
    stdoutExcerpt: excerpt(stdout, context),
    stderrExcerpt: excerpt(stderr, context),
    ...extra
  };
}

function asOutput(buffer, encoding) {
  return encoding === 'buffer' ? Buffer.from(buffer) : buffer.toString('utf8');
}

function resultFromBuffers(stdout, stderr, encoding) {
  return Object.freeze({
    status: 0,
    signal: null,
    stdout: asOutput(stdout, encoding),
    stderr: asOutput(stderr, encoding)
  });
}

function appendBounded(chunks, total, chunk, limit) {
  const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
  const remaining = Math.max(0, limit - total);
  if (remaining > 0) chunks.push(buffer.subarray(0, remaining));
  return { total: total + Math.min(buffer.length, remaining), overflow: buffer.length > remaining };
}

function codeForSyncBufferOverflow(result, limit) {
  const stdoutLength = Buffer.isBuffer(result.stdout) ? result.stdout.length : 0;
  const stderrLength = Buffer.isBuffer(result.stderr) ? result.stderr.length : 0;
  if (stderrLength >= limit && stdoutLength < limit) return ERROR_CODES.stderr;
  return ERROR_CODES.stdout;
}

function causeCategory(code, syscall) {
  if (code === ERROR_CODES.invalid) {
    return ['stat', 'lstat', 'realpath', 'access', 'open'].includes(syscall) ? 'filesystem' : 'validation';
  }
  if (code === ERROR_CODES.spawn) return 'spawn';
  if (code === ERROR_CODES.timeout) return 'timeout';
  if (code === ERROR_CODES.stdout || code === ERROR_CODES.stderr) return 'output';
  if (code === ERROR_CODES.cleanup) return 'cleanup';
  return 'native';
}

function createSanitizedCause(code, syscall, category) {
  const descriptor = Object.create(null);
  descriptor.name = 'SanitizedNativeError';
  if (code !== undefined) descriptor.code = code;
  if (syscall !== undefined) descriptor.syscall = syscall;
  descriptor.category = category;
  return Object.freeze(descriptor);
}

function ownStringDataProperty(value, key) {
  const property = Object.getOwnPropertyDescriptor(value, key);
  if (!property || !Object.hasOwn(property, 'value') || typeof property.value !== 'string') return undefined;
  return property.value;
}

function safelyInspectCauseCode(cause) {
  if (cause === null || (typeof cause !== 'object' && typeof cause !== 'function')) return undefined;
  try {
    return ownStringDataProperty(cause, 'code');
  } catch {
    return undefined;
  }
}

function sanitizeCause(cause, outerCode) {
  try {
    if (cause === null || (typeof cause !== 'object' && typeof cause !== 'function')) {
      return createSanitizedCause(undefined, undefined, causeCategory(outerCode));
    }
    const rawCode = ownStringDataProperty(cause, 'code');
    const nativeCode = rawCode && /^[A-Z][A-Z0-9_]{1,31}$/.test(rawCode) ? rawCode : undefined;
    const rawSyscall = ownStringDataProperty(cause, 'syscall');
    const syscallMatch = typeof rawSyscall === 'string' ? /^([A-Za-z]+)/.exec(rawSyscall) : null;
    const candidateSyscall = syscallMatch?.[1].toLowerCase();
    const syscall = candidateSyscall && SAFE_NATIVE_SYSCALLS.has(candidateSyscall) ? candidateSyscall : undefined;
    return createSanitizedCause(nativeCode, syscall, causeCategory(outerCode, syscall));
  } catch {
    return createSanitizedCause(
      'ERR_CHILD_PROCESS_CAUSE_UNAVAILABLE',
      null,
      'unavailable'
    );
  }
}

export class ChildProcessPolicyError extends Error {
  constructor(code, message, details = {}, cause) {
    const sanitizedCause = cause === undefined ? undefined : sanitizeCause(cause, code);
    super(message, sanitizedCause === undefined ? undefined : { cause: sanitizedCause });
    this.name = 'ChildProcessPolicyError';
    this.stack = `${this.name}: ${this.message}`;
    this.code = code;
    for (const [key, value] of Object.entries(details)) this[key] = value;
  }
}

export const CHILD_PROCESS_ERROR_CODES = ERROR_CODES;

export function createControlledProcessRunner(factoryOptions = {}) {
  const descriptors = ownDataDescriptors(factoryOptions, FACTORY_KEYS, 'factory options');
  const spawnImpl = descriptors.spawnImpl?.value ?? spawn;
  const spawnSyncImpl = descriptors.spawnSyncImpl?.value ?? spawnSync;
  const environment = descriptors.environment?.value ?? process.env;
  const platform = descriptors.platform?.value ?? process.platform;
  if (typeof spawnImpl !== 'function' || typeof spawnSyncImpl !== 'function') throw invalidPolicy(new TypeError('spawn implementations must be functions'));
  if (platform !== 'win32' && platform !== 'linux' && platform !== 'darwin' && platform !== 'aix' && platform !== 'freebsd' && platform !== 'openbsd' && platform !== 'sunos') {
    throw invalidPolicy(new TypeError('unsupported platform'));
  }
  const environmentSnapshot = snapshotInheritedEnvironment(environment, platform, !descriptors.environment);

  async function runControlledProcess(executableValue, argsValue, optionsValue) {
    const executable = validateExecutable(executableValue);
    const args = validateArguments(argsValue);
    const options = validateOptions(optionsValue, environmentSnapshot, platform);
    const redactionContext = buildRedactionContext(executable, args, options, platform);
    if (options.signal?.aborted) {
      throw new ChildProcessPolicyError(
        ERROR_CODES.aborted,
        'Child process execution was aborted before launch.',
        errorDetails(executable, options, redactionContext, Buffer.alloc(0), Buffer.alloc(0))
      );
    }

    return await new Promise((resolve, reject) => {
      let child;
      let settled = false;
      let terminalCode = null;
      let timeout;
      let forceTimer;
      let cleanupTimer;
      let stdoutTotal = 0;
      let stderrTotal = 0;
      const stdoutChunks = [];
      const stderrChunks = [];

      const currentStdout = () => Buffer.concat(stdoutChunks, stdoutTotal);
      const currentStderr = () => Buffer.concat(stderrChunks, stderrTotal);

      const removeRuntimeHooks = () => {
        if (timeout) clearTimeout(timeout);
        if (forceTimer) clearTimeout(forceTimer);
        if (cleanupTimer) clearTimeout(cleanupTimer);
        options.signal?.removeEventListener('abort', onAbort);
      };

      const finish = (error, result) => {
        if (settled) return;
        settled = true;
        removeRuntimeHooks();
        if (error) reject(error);
        else resolve(result);
      };

      const terminalError = (code, message, extra = {}, cause) => new ChildProcessPolicyError(
        code,
        message,
        errorDetails(executable, options, redactionContext, currentStdout(), currentStderr(), extra),
        cause
      );

      const terminate = code => {
        if (settled || terminalCode) return;
        terminalCode = code;
        try {
          child?.kill('SIGTERM');
        } catch (error) {
          finish(terminalError(ERROR_CODES.cleanup, 'Child process cleanup failed.', { priorCode: code }, error));
          return;
        }
        forceTimer = setTimeout(() => {
          try {
            child?.kill('SIGKILL');
          } catch (error) {
            finish(terminalError(ERROR_CODES.cleanup, 'Child process cleanup failed.', { priorCode: code }, error));
            return;
          }
          cleanupTimer = setTimeout(() => {
            finish(terminalError(ERROR_CODES.cleanup, 'Child process did not close after termination.', { priorCode: code }));
          }, CLEANUP_DEADLINE_MS);
          cleanupTimer.unref?.();
        }, TERMINATION_GRACE_MS);
        forceTimer.unref?.();
      };

      const onAbort = () => terminate(ERROR_CODES.aborted);
      timeout = setTimeout(() => terminate(ERROR_CODES.timeout), options.timeoutMs);
      timeout.unref?.();

      try {
        child = spawnImpl(executable, args, {
          cwd: options.cwd,
          env: options.environment,
          shell: false,
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'pipe']
        });
      } catch (error) {
        finish(terminalError(ERROR_CODES.spawn, 'Child process could not be started.', {}, error));
        return;
      }

      child.stdout?.on('data', chunk => {
        const update = appendBounded(stdoutChunks, stdoutTotal, chunk, options.maxOutputBytes);
        stdoutTotal = update.total;
        if (update.overflow) terminate(ERROR_CODES.stdout);
      });
      child.stderr?.on('data', chunk => {
        const update = appendBounded(stderrChunks, stderrTotal, chunk, options.maxOutputBytes);
        stderrTotal = update.total;
        if (update.overflow) terminate(ERROR_CODES.stderr);
      });
      child.once('error', error => {
        if (terminalCode) return;
        finish(terminalError(ERROR_CODES.spawn, 'Child process could not be started.', {}, error));
      });
      child.once('close', (status, signal) => {
        if (settled) return;
        const stdout = currentStdout();
        const stderr = currentStderr();
        if (terminalCode === ERROR_CODES.timeout) {
          finish(terminalError(ERROR_CODES.timeout, 'Child process timed out.'));
        } else if (terminalCode === ERROR_CODES.stdout) {
          finish(terminalError(ERROR_CODES.stdout, 'Child process stdout exceeded its byte limit.'));
        } else if (terminalCode === ERROR_CODES.stderr) {
          finish(terminalError(ERROR_CODES.stderr, 'Child process stderr exceeded its byte limit.'));
        } else if (terminalCode === ERROR_CODES.aborted) {
          finish(terminalError(ERROR_CODES.aborted, 'Child process execution was aborted.'));
        } else if (signal) {
          finish(terminalError(ERROR_CODES.signal, 'Child process terminated by signal.', { signal }));
        } else if (status !== 0) {
          finish(terminalError(ERROR_CODES.nonzero, 'Child process exited with a nonzero status.', { exitCode: status }));
        } else {
          finish(null, resultFromBuffers(stdout, stderr, options.encoding));
        }
      });
      options.signal?.addEventListener('abort', onAbort, { once: true });
      if (options.signal?.aborted) onAbort();
    });
  }

  function runControlledProcessSync(executableValue, argsValue, optionsValue) {
    const executable = validateExecutable(executableValue);
    const args = validateArguments(argsValue);
    const options = validateOptions(optionsValue, environmentSnapshot, platform);
    const redactionContext = buildRedactionContext(executable, args, options, platform);
    if (options.signal?.aborted) {
      throw new ChildProcessPolicyError(
        ERROR_CODES.aborted,
        'Child process execution was aborted before launch.',
        errorDetails(executable, options, redactionContext, Buffer.alloc(0), Buffer.alloc(0))
      );
    }

    let result;
    try {
      result = spawnSyncImpl(executable, args, {
        cwd: options.cwd,
        env: options.environment,
        shell: false,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: options.timeoutMs,
        killSignal: 'SIGTERM',
        maxBuffer: options.maxOutputBytes,
        encoding: null
      });
    } catch (error) {
      throw new ChildProcessPolicyError(
        ERROR_CODES.spawn,
        'Child process could not be started.',
        errorDetails(executable, options, redactionContext, Buffer.alloc(0), Buffer.alloc(0)),
        error
      );
    }

    const stdout = Buffer.isBuffer(result.stdout) ? result.stdout.subarray(0, options.maxOutputBytes) : Buffer.alloc(0);
    const stderr = Buffer.isBuffer(result.stderr) ? result.stderr.subarray(0, options.maxOutputBytes) : Buffer.alloc(0);
    const details = extra => errorDetails(executable, options, redactionContext, stdout, stderr, extra);
    const resultError = result.error;
    const resultErrorCode = safelyInspectCauseCode(resultError);
    if (resultErrorCode === 'ETIMEDOUT') {
      throw new ChildProcessPolicyError(ERROR_CODES.timeout, 'Child process timed out.', details(), resultError);
    }
    if (resultErrorCode === 'ENOBUFS') {
      const code = codeForSyncBufferOverflow(result, options.maxOutputBytes);
      throw new ChildProcessPolicyError(
        code,
        code === ERROR_CODES.stderr ? 'Child process stderr exceeded its byte limit.' : 'Child process stdout exceeded its byte limit.',
        details(),
        resultError
      );
    }
    if (resultError) {
      throw new ChildProcessPolicyError(ERROR_CODES.spawn, 'Child process could not be started.', details(), resultError);
    }
    if (result.signal) {
      throw new ChildProcessPolicyError(ERROR_CODES.signal, 'Child process terminated by signal.', details({ signal: result.signal }));
    }
    if (result.status !== 0) {
      throw new ChildProcessPolicyError(ERROR_CODES.nonzero, 'Child process exited with a nonzero status.', details({ exitCode: result.status }));
    }
    return resultFromBuffers(stdout, stderr, options.encoding);
  }

  return Object.freeze({
    runControlledProcess,
    runControlledProcessSync,
    inheritedEnvironmentNames: environmentSnapshot.allowedNames
  });
}

const defaultRunner = createControlledProcessRunner();

export const runControlledProcess = defaultRunner.runControlledProcess;
export const runControlledProcessSync = defaultRunner.runControlledProcessSync;
export const CONTROLLED_INHERITED_ENVIRONMENT_NAMES = defaultRunner.inheritedEnvironmentNames;
