import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { Readable, Transform, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createDeflateRaw, createInflateRaw } from 'node:zlib';
import { stableJson, sha256Text } from './hash.mjs';
import { createOwnedTempDir, ensureOwnedDir, promoteOwnedPath, removeOwnedPath } from './fs.mjs';
import { assertOwnedPath, claimOutputRoot } from '../v3/paths.mjs';

const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_DESCRIPTOR = 0x08074b50;
const SIG_EOCD = 0x06054b50;
const SIG_ZIP64_EOCD = 0x06064b50;
const SIG_ZIP64_LOCATOR = 0x07064b50;
const UTF8_FLAG = 0x0800;
const DESCRIPTOR_FLAG = 0x0008;
const ALLOWED_FLAGS = UTF8_FLAG | DESCRIPTOR_FLAG;
const UNIX_TYPE_MASK = 0xf000;
const UNIX_REGULAR = 0x8000;
const UNIX_DIRECTORY = 0x4000;
const CHUNK_BYTES = 1024 * 1024;

export const ARCHIVE_LIMITS = Object.freeze({
  archiveFileBytes: 1024 * 1024 * 1024,
  entryCount: 4096,
  filenameBytes: 512,
  extraFieldBytesPerHeader: 4096,
  commentBytesPerEntry: 4096,
  archiveCommentBytes: 4096,
  compressedBytesPerEntry: 256 * 1024 * 1024,
  uncompressedBytesPerEntry: 2 * 1024 * 1024 * 1024,
  aggregateUncompressedBytes: 8 * 1024 * 1024 * 1024,
  compressionRatio: 100,
  pathDepth: 32
});
export const ARCHIVE_LIMITS_SHA256 = sha256Text(stableJson(ARCHIVE_LIMITS));

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let value = n;
    for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    table[n] = value >>> 0;
  }
  return table;
})();

export class ArchivePolicyError extends Error {
  constructor(code, message, options = {}) {
    super(`Archive ${message}`, options);
    this.name = 'ArchivePolicyError';
    this.code = code;
  }
}

function fail(code, message, options) {
  throw new ArchivePolicyError(code, message, options);
}

function wrapNative(error, code, message) {
  if (error instanceof ArchivePolicyError) throw error;
  fail(code, message);
}

function mergeLimits(overrides = {}) {
  if (overrides === null || typeof overrides !== 'object' || Array.isArray(overrides)) fail('YATZY_ARCHIVE_LIMIT_INVALID', 'limits must be a plain object');
  const result = { ...ARCHIVE_LIMITS };
  for (const [key, value] of Object.entries(overrides)) {
    if (!Object.hasOwn(result, key) || !Number.isSafeInteger(value) || value < 1) fail('YATZY_ARCHIVE_LIMIT_INVALID', 'limits contain an invalid value');
    result[key] = value;
  }
  return Object.freeze(result);
}

function safeAdd(a, b, code = 'YATZY_ARCHIVE_INVALID_STRUCTURE') {
  const value = a + b;
  if (!Number.isSafeInteger(value) || value < a || value < b) fail(code, 'integer bounds are invalid');
  return value;
}

function readExact(fd, position, length) {
  if (!Number.isSafeInteger(position) || position < 0 || !Number.isSafeInteger(length) || length < 0) fail('YATZY_ARCHIVE_INVALID_STRUCTURE', 'read bounds are invalid');
  const buffer = Buffer.alloc(length);
  let offset = 0;
  while (offset < length) {
    const count = fs.readSync(fd, buffer, offset, length - offset, position + offset);
    if (count === 0) fail('YATZY_ARCHIVE_INVALID_STRUCTURE', 'archive is truncated');
    offset += count;
  }
  return buffer;
}

function writeAll(fd, buffer) {
  let offset = 0;
  while (offset < buffer.length) {
    const count = fs.writeSync(fd, buffer, offset, buffer.length - offset);
    if (count < 1) fail('YATZY_ARCHIVE_CREATION_FAILED', 'archive write made no progress');
    offset += count;
  }
}

function crcUpdate(crc, buffer) {
  let value = crc;
  for (const byte of buffer) value = CRC_TABLE[(value ^ byte) & 255] ^ (value >>> 8);
  return value >>> 0;
}

export function crc32(buffer) {
  return (crcUpdate(0xffffffff, buffer) ^ 0xffffffff) >>> 0;
}

function dosTimeDate(date = new Date()) {
  const year = Math.max(1980, Math.min(2107, date.getFullYear()));
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1),
    day: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate()
  };
}

function sameFilesystemPath(a, b) {
  const left = path.resolve(a), right = path.resolve(b);
  return process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;
}

function fileIdentity(stat) {
  return Object.freeze({
    dev: stat.dev,
    ino: stat.ino,
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    birthtimeMs: stat.birthtimeMs
  });
}

function sameFileIdentity(left, right) {
  const deviceMatches = left.dev === 0 || right.dev === 0 || left.dev === right.dev;
  const inodeMatches = left.ino === 0 || right.ino === 0 || left.ino === right.ino;
  return deviceMatches && inodeMatches && left.size === right.size && left.mtimeMs === right.mtimeMs && left.birthtimeMs === right.birthtimeMs;
}

function inspectSourceChain(source, expectedType) {
  const absolute = path.resolve(source);
  const parsed = path.parse(absolute);
  const parts = path.relative(parsed.root, absolute).split(path.sep).filter(Boolean);
  let current = parsed.root;
  for (const part of parts) {
    current = path.join(current, part);
    let stat;
    try { stat = fs.lstatSync(current); } catch (error) { wrapNative(error, 'YATZY_ARCHIVE_SOURCE_INVALID', 'source state could not be proven'); }
    if (stat.isSymbolicLink()) fail('YATZY_ARCHIVE_SPECIAL_ENTRY', 'source contains link or reparse redirection');
    let canonical;
    try { canonical = fs.realpathSync.native(current); } catch (error) { wrapNative(error, 'YATZY_ARCHIVE_SOURCE_INVALID', 'source identity could not be proven'); }
    if (!sameFilesystemPath(current, canonical)) fail('YATZY_ARCHIVE_SPECIAL_ENTRY', 'source contains canonical redirection');
  }
  const stat = fs.lstatSync(absolute);
  if (expectedType === 'file' && !stat.isFile()) fail('YATZY_ARCHIVE_SPECIAL_ENTRY', 'source entry is not a regular file');
  if (expectedType === 'directory' && !stat.isDirectory()) fail('YATZY_ARCHIVE_SPECIAL_ENTRY', 'source entry is not a directory');
  return { absolute, stat };
}

function decodeName(raw, flags) {
  if (flags & UTF8_FLAG) {
    let value;
    try { value = new TextDecoder('utf-8', { fatal: true }).decode(raw); } catch { fail('YATZY_ARCHIVE_INVALID_PATH', 'filename is not valid UTF-8'); }
    if (!Buffer.from(value, 'utf8').equals(raw)) fail('YATZY_ARCHIVE_INVALID_PATH', 'filename has an ambiguous UTF-8 encoding');
    return value;
  }
  if ([...raw].some(byte => byte > 0x7f)) fail('YATZY_ARCHIVE_INVALID_PATH', 'legacy filename is not unambiguous ASCII');
  return raw.toString('ascii');
}

function validatePathName(name, rawLength, limits) {
  if (!name || rawLength < 1 || rawLength > limits.filenameBytes) fail('YATZY_ARCHIVE_LIMIT_EXCEEDED', 'filename length exceeds policy');
  if (name !== name.normalize('NFC')) fail('YATZY_ARCHIVE_INVALID_PATH', 'filename is not normalized Unicode');
  if (name.includes('\\') || name.startsWith('/') || path.posix.isAbsolute(name) || path.win32.isAbsolute(name) || /^[A-Za-z]:/u.test(name) || name.startsWith('//')) fail('YATZY_ARCHIVE_INVALID_PATH', 'filename is absolute or uses a prohibited separator');
  if (/[\x00-\x1f\x7f]/u.test(name) || /[<>"|?*:]/u.test(name)) fail('YATZY_ARCHIVE_INVALID_PATH', 'filename contains a prohibited character');
  const directory = name.endsWith('/');
  const body = directory ? name.slice(0, -1) : name;
  if (!body) fail('YATZY_ARCHIVE_INVALID_PATH', 'filename is empty or root-only');
  const segments = body.split('/');
  if (segments.length > limits.pathDepth) fail('YATZY_ARCHIVE_LIMIT_EXCEEDED', 'path depth exceeds policy');
  for (const segment of segments) {
    if (!segment || segment === '.' || segment === '..') fail('YATZY_ARCHIVE_INVALID_PATH', 'filename contains an ambiguous component');
    if (/[. ]$/u.test(segment)) fail('YATZY_ARCHIVE_INVALID_PATH', 'filename has a trailing dot or space');
    const base = segment.split('.')[0].toUpperCase();
    if (/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/u.test(base)) fail('YATZY_ARCHIVE_INVALID_PATH', 'filename uses a reserved device name');
  }
  return { name, key: body, directory, segments };
}

function collisionKey(value) {
  return value.toLocaleLowerCase('en-US');
}

function validateExtraFields(buffer) {
  let offset = 0;
  const seen = new Set();
  while (offset < buffer.length) {
    if (offset + 4 > buffer.length) fail('YATZY_ARCHIVE_INVALID_STRUCTURE', 'extra-field header is truncated');
    const id = buffer.readUInt16LE(offset), length = buffer.readUInt16LE(offset + 2);
    const end = safeAdd(offset + 4, length);
    if (end > buffer.length) fail('YATZY_ARCHIVE_INVALID_STRUCTURE', 'extra-field body is truncated');
    if (seen.has(id)) fail('YATZY_ARCHIVE_INVALID_STRUCTURE', 'extra-field identifier is duplicated');
    seen.add(id);
    const value = buffer.subarray(offset + 4, end);
    if (id === 0x0001) fail('YATZY_ARCHIVE_UNSUPPORTED_FEATURE', 'ZIP64 is unsupported');
    if (id === 0x5455) {
      if (value.length < 1 || value[0] & ~0x07) fail('YATZY_ARCHIVE_INVALID_STRUCTURE', 'extended timestamp extra field is malformed');
      const expected = 1 + 4 * ((value[0] & 1 ? 1 : 0) + (value[0] & 2 ? 1 : 0) + (value[0] & 4 ? 1 : 0));
      if (value.length !== expected && value.length !== 5) fail('YATZY_ARCHIVE_INVALID_STRUCTURE', 'extended timestamp extra field has invalid length');
    } else if (id === 0x7875) {
      if (value.length < 5 || value[0] !== 1) fail('YATZY_ARCHIVE_INVALID_STRUCTURE', 'Unix identity extra field is malformed');
      const uidLength = value[1];
      if (uidLength < 1 || uidLength > 8 || 2 + uidLength >= value.length) fail('YATZY_ARCHIVE_INVALID_STRUCTURE', 'Unix identity extra field is malformed');
      const gidLength = value[2 + uidLength];
      if (gidLength < 1 || gidLength > 8 || 3 + uidLength + gidLength !== value.length) fail('YATZY_ARCHIVE_INVALID_STRUCTURE', 'Unix identity extra field is malformed');
    } else {
      fail('YATZY_ARCHIVE_UNSUPPORTED_FEATURE', 'extra-field identifier is unsupported');
    }
    offset = end;
  }
}

function validateEntryType(entry) {
  if (![0, 3].includes(entry.creatorSystem)) fail('YATZY_ARCHIVE_SPECIAL_ENTRY', 'creator system is unsupported');
  if (entry.creatorSystem === 3) {
    const kind = entry.unixMode & UNIX_TYPE_MASK;
    const expected = entry.directory ? UNIX_DIRECTORY : UNIX_REGULAR;
    if (kind !== expected) fail('YATZY_ARCHIVE_SPECIAL_ENTRY', 'Unix attributes describe a link or special object');
  } else {
    const dosDirectory = Boolean(entry.externalAttributes & 0x10);
    if (dosDirectory !== entry.directory || entry.externalAttributes & ~0x31) fail('YATZY_ARCHIVE_SPECIAL_ENTRY', 'DOS attributes are inconsistent or special');
  }
  if (entry.directory && (entry.method !== 0 || entry.crc32 !== 0 || entry.compressedSize !== 0 || entry.uncompressedSize !== 0 || entry.dataDescriptor)) fail('YATZY_ARCHIVE_INVALID_STRUCTURE', 'directory entry has a payload');
}

function validatePathPlan(entries) {
  const exact = new Map(), foldedPrefixes = new Map(), files = new Set();
  for (const entry of entries) {
    if (exact.has(entry.key)) fail('YATZY_ARCHIVE_DUPLICATE_PATH', 'duplicate or file-directory alias exists');
    exact.set(entry.key, entry);
    let prefix = '';
    for (const segment of entry.segments) {
      prefix = prefix ? `${prefix}/${segment}` : segment;
      const folded = collisionKey(prefix);
      const prior = foldedPrefixes.get(folded);
      if (prior !== undefined && prior !== prefix) fail('YATZY_ARCHIVE_DUPLICATE_PATH', 'case-folded path-prefix collision exists');
      foldedPrefixes.set(folded, prefix);
    }
    if (!entry.directory) files.add(entry.key);
  }
  for (const entry of entries) {
    let prefix = '';
    for (let index = 0; index < entry.segments.length - 1; index += 1) {
      prefix = prefix ? `${prefix}/${entry.segments[index]}` : entry.segments[index];
      if (files.has(prefix)) fail('YATZY_ARCHIVE_DUPLICATE_PATH', 'a file is an ancestor of another entry');
    }
  }
}

function parseRequired(required, limits) {
  if (!Array.isArray(required)) fail('YATZY_ARCHIVE_REQUIRED_ENTRY_INVALID', 'required-entry schema must be an array');
  const seen = new Set();
  return required.map(value => {
    if (typeof value !== 'string' || !value) fail('YATZY_ARCHIVE_REQUIRED_ENTRY_INVALID', 'required entry is malformed');
    const parsed = validatePathName(value, Buffer.byteLength(value), limits);
    const kind = value.endsWith('/') ? 'directory_prefix' : 'exact_file';
    const identity = `${kind}:${parsed.key}`;
    if (seen.has(identity)) fail('YATZY_ARCHIVE_REQUIRED_ENTRY_INVALID', 'required entry is duplicated');
    seen.add(identity);
    return { requested: value, kind, key: parsed.key };
  });
}

function matchesDirectoryPrefix(entry, key) {
  return (entry.directory && entry.key === key) || entry.key.startsWith(`${key}/`);
}

function verifyRequired(entries, required, limits) {
  const schema = parseRequired(required, limits);
  const results = schema.map(item => {
    const passed = item.kind === 'exact_file'
      ? entries.some(entry => !entry.directory && entry.key === item.key)
      : entries.some(entry => matchesDirectoryPrefix(entry, item.key));
    return { ...item, passed };
  });
  if (results.some(result => !result.passed)) fail('YATZY_ARCHIVE_REQUIRED_ENTRY_MISSING', 'required entry is missing');
  return results;
}

export function parseZipStructure(archivePath, { limits: limitOverrides = {} } = {}) {
  const limits = mergeLimits(limitOverrides);
  let stat, fd;
  try {
    stat = inspectSourceChain(archivePath, 'file').stat;
    if (stat.size < 22) fail('YATZY_ARCHIVE_INVALID_STRUCTURE', 'file is too small');
    if (stat.size > limits.archiveFileBytes) fail('YATZY_ARCHIVE_LIMIT_EXCEEDED', 'archive size exceeds policy');
    fd = fs.openSync(archivePath, 'r');
    if (!sameFileIdentity(fileIdentity(stat), fileIdentity(fs.fstatSync(fd)))) fail('YATZY_ARCHIVE_INVALID_STRUCTURE', 'archive identity changed during validation');
    const tailSize = Math.min(stat.size, 65_557), tail = readExact(fd, stat.size - tailSize, tailSize);
    const candidates = [];
    for (let index = tail.length - 22; index >= 0; index -= 1) {
      if (tail.readUInt32LE(index) === SIG_EOCD && index + 22 + tail.readUInt16LE(index + 20) === tail.length) candidates.push(index);
    }
    if (candidates.length !== 1) fail('YATZY_ARCHIVE_INVALID_STRUCTURE', 'EOCD placement is missing or ambiguous');
    const end = candidates[0], eocdOffset = stat.size - tailSize + end;
    const disk = tail.readUInt16LE(end + 4), centralDisk = tail.readUInt16LE(end + 6), diskEntries = tail.readUInt16LE(end + 8), entryCount = tail.readUInt16LE(end + 10), centralSize = tail.readUInt32LE(end + 12), centralOffset = tail.readUInt32LE(end + 16), archiveCommentLength = tail.readUInt16LE(end + 20);
    if (archiveCommentLength > limits.archiveCommentBytes) fail('YATZY_ARCHIVE_LIMIT_EXCEEDED', 'archive comment exceeds policy');
    if (disk !== 0 || centralDisk !== 0 || diskEntries !== entryCount) fail('YATZY_ARCHIVE_UNSUPPORTED_FEATURE', 'multi-disk archive is unsupported');
    if ([diskEntries, entryCount].includes(0xffff) || [centralSize, centralOffset].includes(0xffffffff)) fail('YATZY_ARCHIVE_UNSUPPORTED_FEATURE', 'ZIP64 is unsupported');
    if (entryCount < 1) fail('YATZY_ARCHIVE_INVALID_STRUCTURE', 'archive contains no entries');
    if (entryCount > limits.entryCount) fail('YATZY_ARCHIVE_LIMIT_EXCEEDED', 'entry count exceeds policy');
    if (eocdOffset >= 20 && readExact(fd, eocdOffset - 20, 4).readUInt32LE(0) === SIG_ZIP64_LOCATOR) fail('YATZY_ARCHIVE_UNSUPPORTED_FEATURE', 'ZIP64 is unsupported');
    if (centralOffset + centralSize !== eocdOffset || centralOffset < 1) fail('YATZY_ARCHIVE_INVALID_STRUCTURE', 'central-directory bounds are invalid');
    const maximumCentral = entryCount * (46 + limits.filenameBytes + limits.extraFieldBytesPerHeader + limits.commentBytesPerEntry);
    if (centralSize > maximumCentral) fail('YATZY_ARCHIVE_LIMIT_EXCEEDED', 'central directory exceeds derived policy');
    const central = readExact(fd, centralOffset, centralSize), entries = [];
    let cursor = 0, totalCompressed = 0, totalUncompressed = 0;
    for (let index = 0; index < entryCount; index += 1) {
      if (cursor + 46 > central.length || central.readUInt32LE(cursor) !== SIG_CENTRAL) fail('YATZY_ARCHIVE_INVALID_STRUCTURE', 'central-directory record is invalid');
      const versionMadeBy = central.readUInt16LE(cursor + 4), versionNeeded = central.readUInt16LE(cursor + 6), flags = central.readUInt16LE(cursor + 8), method = central.readUInt16LE(cursor + 10), modifiedTime = central.readUInt16LE(cursor + 12), modifiedDate = central.readUInt16LE(cursor + 14), crc = central.readUInt32LE(cursor + 16), compressedSize = central.readUInt32LE(cursor + 20), uncompressedSize = central.readUInt32LE(cursor + 24), nameLength = central.readUInt16LE(cursor + 28), extraLength = central.readUInt16LE(cursor + 30), commentLength = central.readUInt16LE(cursor + 32), diskStart = central.readUInt16LE(cursor + 34), externalAttributes = central.readUInt32LE(cursor + 38), localOffset = central.readUInt32LE(cursor + 42);
      if (versionNeeded > 20) fail('YATZY_ARCHIVE_UNSUPPORTED_FEATURE', 'required ZIP version is unsupported');
      if (flags & ~ALLOWED_FLAGS || flags & 1 || flags & 0x0060) fail('YATZY_ARCHIVE_UNSUPPORTED_FEATURE', 'entry flags are unsupported');
      if (![0, 8].includes(method)) fail('YATZY_ARCHIVE_UNSUPPORTED_FEATURE', 'compression method is unsupported');
      if (diskStart !== 0) fail('YATZY_ARCHIVE_UNSUPPORTED_FEATURE', 'multi-disk entry is unsupported');
      if ([compressedSize, uncompressedSize, localOffset].includes(0xffffffff)) fail('YATZY_ARCHIVE_UNSUPPORTED_FEATURE', 'ZIP64 is unsupported');
      if (nameLength < 1 || nameLength > limits.filenameBytes || extraLength > limits.extraFieldBytesPerHeader || commentLength > limits.commentBytesPerEntry) fail('YATZY_ARCHIVE_LIMIT_EXCEEDED', 'entry metadata exceeds policy');
      const recordEnd = safeAdd(cursor + 46, safeAdd(nameLength, safeAdd(extraLength, commentLength)));
      if (recordEnd > central.length) fail('YATZY_ARCHIVE_INVALID_STRUCTURE', 'central-directory record is truncated');
      const rawName = central.subarray(cursor + 46, cursor + 46 + nameLength), extra = central.subarray(cursor + 46 + nameLength, cursor + 46 + nameLength + extraLength);
      validateExtraFields(extra);
      const pathPlan = validatePathName(decodeName(rawName, flags), rawName.length, limits);
      if (compressedSize > limits.compressedBytesPerEntry || uncompressedSize > limits.uncompressedBytesPerEntry) fail('YATZY_ARCHIVE_LIMIT_EXCEEDED', 'entry size exceeds policy');
      if (uncompressedSize > 0 && uncompressedSize / Math.max(1, compressedSize) > limits.compressionRatio) fail('YATZY_ARCHIVE_LIMIT_EXCEEDED', 'declared compression ratio exceeds policy');
      totalCompressed = safeAdd(totalCompressed, compressedSize, 'YATZY_ARCHIVE_LIMIT_EXCEEDED');
      totalUncompressed = safeAdd(totalUncompressed, uncompressedSize, 'YATZY_ARCHIVE_LIMIT_EXCEEDED');
      if (totalUncompressed > limits.aggregateUncompressedBytes) fail('YATZY_ARCHIVE_LIMIT_EXCEEDED', 'aggregate uncompressed size exceeds policy');
      const entry = { index, ...pathPlan, rawName: Buffer.from(rawName), versionMadeBy, creatorSystem: versionMadeBy >>> 8, versionNeeded, flags, method, modifiedTime, modifiedDate, crc32: crc, compressedSize, uncompressedSize, externalAttributes, unixMode: externalAttributes >>> 16, localOffset, dataDescriptor: Boolean(flags & DESCRIPTOR_FLAG) };
      validateEntryType(entry);
      entries.push(entry);
      cursor = recordEnd;
    }
    if (cursor !== central.length) fail('YATZY_ARCHIVE_INVALID_STRUCTURE', 'central directory has undeclared bytes');
    validatePathPlan(entries);
    const regions = [];
    for (const entry of entries) {
      if (entry.localOffset + 30 > centralOffset) fail('YATZY_ARCHIVE_INVALID_STRUCTURE', 'local header is outside payload region');
      const local = readExact(fd, entry.localOffset, 30);
      if (local.readUInt32LE(0) !== SIG_LOCAL) fail('YATZY_ARCHIVE_INVALID_STRUCTURE', 'local-header signature is invalid');
      const localVersionNeeded = local.readUInt16LE(4), localFlags = local.readUInt16LE(6), localMethod = local.readUInt16LE(8), localModifiedTime = local.readUInt16LE(10), localModifiedDate = local.readUInt16LE(12), localCrc = local.readUInt32LE(14), localCompressed = local.readUInt32LE(18), localUncompressed = local.readUInt32LE(22), localNameLength = local.readUInt16LE(26), localExtraLength = local.readUInt16LE(28);
      if (localNameLength > limits.filenameBytes || localExtraLength > limits.extraFieldBytesPerHeader) fail('YATZY_ARCHIVE_LIMIT_EXCEEDED', 'local metadata exceeds policy');
      const dataOffset = safeAdd(entry.localOffset + 30, safeAdd(localNameLength, localExtraLength));
      if (dataOffset > centralOffset) fail('YATZY_ARCHIVE_INVALID_STRUCTURE', 'local header is truncated');
      const localName = readExact(fd, entry.localOffset + 30, localNameLength), localExtra = readExact(fd, entry.localOffset + 30 + localNameLength, localExtraLength);
      validateExtraFields(localExtra);
      if (!localName.equals(entry.rawName) || localVersionNeeded !== entry.versionNeeded || localFlags !== entry.flags || localMethod !== entry.method || localModifiedTime !== entry.modifiedTime || localModifiedDate !== entry.modifiedDate) fail('YATZY_ARCHIVE_INVALID_STRUCTURE', 'central and local headers disagree');
      if (entry.dataDescriptor) {
        const zero = localCrc === 0 && localCompressed === 0 && localUncompressed === 0;
        const exact = localCrc === entry.crc32 && localCompressed === entry.compressedSize && localUncompressed === entry.uncompressedSize;
        if (!zero && !exact) fail('YATZY_ARCHIVE_INVALID_STRUCTURE', 'descriptor-backed local sizes are inconsistent');
      } else if (localCrc !== entry.crc32 || localCompressed !== entry.compressedSize || localUncompressed !== entry.uncompressedSize) {
        fail('YATZY_ARCHIVE_INVALID_STRUCTURE', 'central and local payload metadata disagree');
      }
      let regionEnd = safeAdd(dataOffset, entry.compressedSize);
      if (regionEnd > centralOffset) fail('YATZY_ARCHIVE_INVALID_STRUCTURE', 'payload intrudes into central directory');
      if (entry.dataDescriptor) {
        if (regionEnd + 16 > centralOffset) fail('YATZY_ARCHIVE_INVALID_STRUCTURE', 'data descriptor is truncated');
        const descriptor = readExact(fd, regionEnd, 16);
        if (descriptor.readUInt32LE(0) !== SIG_DESCRIPTOR || descriptor.readUInt32LE(4) !== entry.crc32 || descriptor.readUInt32LE(8) !== entry.compressedSize || descriptor.readUInt32LE(12) !== entry.uncompressedSize) fail('YATZY_ARCHIVE_INVALID_STRUCTURE', 'data descriptor is inconsistent');
        regionEnd += 16;
      }
      entry.dataOffset = dataOffset;
      entry.regionEnd = regionEnd;
      regions.push({ start: entry.localOffset, end: regionEnd });
    }
    regions.sort((a, b) => a.start - b.start);
    if (regions[0].start !== 0) fail('YATZY_ARCHIVE_INVALID_STRUCTURE', 'prepended bytes are unsupported');
    for (let index = 1; index < regions.length; index += 1) if (regions[index - 1].end !== regions[index].start) fail('YATZY_ARCHIVE_INVALID_STRUCTURE', 'entry regions overlap or contain gaps');
    if (regions.at(-1).end !== centralOffset) fail('YATZY_ARCHIVE_INVALID_STRUCTURE', 'payload region does not meet central directory exactly');
    if (!sameFileIdentity(fileIdentity(stat), fileIdentity(fs.fstatSync(fd)))) fail('YATZY_ARCHIVE_INVALID_STRUCTURE', 'archive identity changed during validation');
    return { archivePath: path.resolve(archivePath), archiveIdentity: fileIdentity(stat), archiveBytes: stat.size, archiveCommentLength, centralOffset, centralSize, entryCount, totalCompressed, totalUncompressed, entries, limits, limitsSha256: sha256Text(stableJson(limits)) };
  } catch (error) {
    wrapNative(error, 'YATZY_ARCHIVE_INVALID_STRUCTURE', 'structure could not be validated');
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

function openValidatedArchive(plan) {
  let fd;
  try {
    fd = fs.openSync(plan.archivePath, 'r');
    if (!sameFileIdentity(plan.archiveIdentity, fileIdentity(fs.fstatSync(fd)))) fail('YATZY_ARCHIVE_INVALID_STRUCTURE', 'archive identity changed after structure validation');
    return fd;
  } catch (error) {
    if (fd !== undefined) fs.closeSync(fd);
    wrapNative(error, 'YATZY_ARCHIVE_INVALID_STRUCTURE', 'archive identity could not be reopened');
  }
}

function assertOpenArchiveIdentity(plan, fd) {
  let stat;
  try { stat = fs.fstatSync(fd); } catch (error) { wrapNative(error, 'YATZY_ARCHIVE_INVALID_STRUCTURE', 'archive identity could not be verified'); }
  if (!sameFileIdentity(plan.archiveIdentity, fileIdentity(stat))) fail('YATZY_ARCHIVE_INVALID_STRUCTURE', 'archive identity changed during payload validation');
}

async function sha256ArchiveStreaming(plan) {
  const hash = createHash('sha256');
  const fd = openValidatedArchive(plan);
  try {
    for await (const chunk of fs.createReadStream(plan.archivePath, { fd, autoClose: false, highWaterMark: CHUNK_BYTES })) hash.update(chunk);
    assertOpenArchiveIdentity(plan, fd);
    return hash.digest('hex');
  } finally { fs.closeSync(fd); }
}

function discardSink() {
  return new Writable({ write(_chunk, _encoding, callback) { callback(); } });
}

function payloadMeter(entry, state, limits) {
  let crc = 0xffffffff, bytes = 0;
  const hash = createHash('sha256');
  const meter = new Transform({
    transform(chunk, _encoding, callback) {
      bytes = safeAdd(bytes, chunk.length, 'YATZY_ARCHIVE_LIMIT_EXCEEDED');
      state.actualAggregate = safeAdd(state.actualAggregate, chunk.length, 'YATZY_ARCHIVE_LIMIT_EXCEEDED');
      if (bytes > entry.uncompressedSize || bytes > limits.uncompressedBytesPerEntry || state.actualAggregate > limits.aggregateUncompressedBytes) return callback(new ArchivePolicyError('YATZY_ARCHIVE_LIMIT_EXCEEDED', 'decompressed payload exceeds policy'));
      if (bytes > entry.compressedSize * limits.compressionRatio && bytes > 0) return callback(new ArchivePolicyError('YATZY_ARCHIVE_LIMIT_EXCEEDED', 'actual compression ratio exceeds policy'));
      crc = crcUpdate(crc, chunk); hash.update(chunk); callback(null, chunk);
    }
  });
  meter.result = () => ({ bytes, crc32: (crc ^ 0xffffffff) >>> 0, sha256: hash.digest('hex') });
  return meter;
}

async function processPayload(plan, entry, state, destination = null, archiveFd) {
  if (entry.directory) return null;
  const source = entry.compressedSize === 0 ? Readable.from([]) : fs.createReadStream(plan.archivePath, { fd: archiveFd, autoClose: false, start: entry.dataOffset, end: entry.dataOffset + entry.compressedSize - 1, highWaterMark: CHUNK_BYTES });
  const meter = payloadMeter(entry, state, plan.limits);
  const sink = destination ? fs.createWriteStream(destination, { flags: 'wx', mode: 0o600 }) : discardSink();
  let inflate = null;
  try {
    if (entry.method === 8) {
      inflate = createInflateRaw();
      await pipeline(source, inflate, meter, sink);
      if (inflate.bytesWritten !== entry.compressedSize) fail('YATZY_ARCHIVE_PAYLOAD_INVALID', 'deflate stream has trailing compressed bytes');
    } else {
      await pipeline(source, meter, sink);
    }
    const result = meter.result();
    if (result.bytes !== entry.uncompressedSize || result.crc32 !== entry.crc32) fail('YATZY_ARCHIVE_PAYLOAD_INVALID', 'payload size or CRC does not match');
    return result;
  } catch (error) {
    wrapNative(error, 'YATZY_ARCHIVE_PAYLOAD_INVALID', 'payload decompression or verification failed');
  }
}

function auditRecord(plan, archiveSha256, requiredEntries, payloads) {
  return {
    archive: path.basename(plan.archivePath),
    sha256: archiveSha256,
    sizeBytes: plan.archiveBytes,
    entryCount: plan.entryCount,
    totalCompressedBytes: plan.totalCompressed,
    totalUncompressedBytes: plan.totalUncompressed,
    compressionMethods: [...new Set(plan.entries.map(entry => entry.method))].sort((a, b) => a - b),
    requiredEntries,
    payloadVerification: payloads.length === plan.entries.filter(entry => !entry.directory).length ? 'pass' : 'fail',
    limitsSha256: plan.limitsSha256,
    passed: true
  };
}

export async function auditZip(archivePath, required = [], options = {}) {
  const plan = parseZipStructure(archivePath, options), requiredEntries = verifyRequired(plan.entries, required, plan.limits), state = { actualAggregate: 0 }, payloads = [];
  const fd = openValidatedArchive(plan);
  try {
    for (const entry of plan.entries) {
      const result = await processPayload(plan, entry, state, null, fd);
      if (result) payloads.push({ name: entry.name, ...result });
    }
    assertOpenArchiveIdentity(plan, fd);
  } finally { fs.closeSync(fd); }
  if (state.actualAggregate !== plan.totalUncompressed) fail('YATZY_ARCHIVE_PAYLOAD_INVALID', 'aggregate payload length does not match');
  return auditRecord(plan, await sha256ArchiveStreaming(plan), requiredEntries, payloads);
}

function sha256ArchiveSync(plan) {
  const fd = openValidatedArchive(plan), hash = createHash('sha256'), buffer = Buffer.alloc(CHUNK_BYTES);
  try {
    let position = 0, count;
    while ((count = fs.readSync(fd, buffer, 0, buffer.length, position)) > 0) { hash.update(buffer.subarray(0, count)); position += count; }
    assertOpenArchiveIdentity(plan, fd);
    return hash.digest('hex');
  } finally { fs.closeSync(fd); }
}

export function verifyZip(archivePath, required = [], options = {}) {
  try {
    const plan = parseZipStructure(archivePath, options), requiredEntries = verifyRequired(plan.entries, required, plan.limits), fd = openValidatedArchive(plan), buffer = Buffer.alloc(CHUNK_BYTES), payloads = [];
    let aggregate = 0;
    try {
      for (const entry of plan.entries) {
        if (entry.directory) continue;
        if (entry.method !== 0) fail('YATZY_ARCHIVE_ASYNC_REQUIRED', 'deflate verification requires the asynchronous audit boundary');
        let remaining = entry.compressedSize, position = entry.dataOffset, crc = 0xffffffff, bytes = 0; const hash = createHash('sha256');
        while (remaining > 0) {
          const wanted = Math.min(buffer.length, remaining), count = fs.readSync(fd, buffer, 0, wanted, position);
          if (count !== wanted) fail('YATZY_ARCHIVE_PAYLOAD_INVALID', 'stored payload is truncated');
          const chunk = buffer.subarray(0, count); crc = crcUpdate(crc, chunk); hash.update(chunk); bytes += count; aggregate += count; position += count; remaining -= count;
          if (bytes > plan.limits.uncompressedBytesPerEntry || aggregate > plan.limits.aggregateUncompressedBytes) fail('YATZY_ARCHIVE_LIMIT_EXCEEDED', 'stored payload exceeds policy');
        }
        crc = (crc ^ 0xffffffff) >>> 0;
        if (bytes !== entry.uncompressedSize || crc !== entry.crc32) fail('YATZY_ARCHIVE_PAYLOAD_INVALID', 'stored payload size or CRC does not match');
        payloads.push({ name: entry.name, bytes, crc32: crc, sha256: hash.digest('hex') });
      }
      assertOpenArchiveIdentity(plan, fd);
    } finally { fs.closeSync(fd); }
    return auditRecord(plan, sha256ArchiveSync(plan), requiredEntries, payloads);
  } catch (error) {
    if (error instanceof ArchivePolicyError) return { passed: false, code: error.code, reason: error.message };
    return { passed: false, code: 'YATZY_ARCHIVE_INVALID_STRUCTURE', reason: 'Archive verification failed' };
  }
}

export function listZip(archivePath, options = {}) {
  return parseZipStructure(archivePath, options).entries.map(entry => entry.name);
}

function selectionPredicate(prefix, limits) {
  if (prefix === null || prefix === undefined) return () => true;
  if (typeof prefix !== 'string' || !prefix.endsWith('/')) fail('YATZY_ARCHIVE_SELECTION_INVALID', 'selection prefix must end at a component boundary');
  const parsed = validatePathName(prefix, Buffer.byteLength(prefix), limits);
  return entry => matchesDirectoryPrefix(entry, parsed.key);
}

export async function extractZip(archivePath, destination, { prefix = null, limits: limitOverrides = {} } = {}) {
  const plan = parseZipStructure(archivePath, { limits: limitOverrides }), selected = selectionPredicate(prefix, plan.limits);
  if (prefix !== null && prefix !== undefined && !plan.entries.some(selected)) fail('YATZY_ARCHIVE_REQUIRED_ENTRY_MISSING', 'selected archive prefix is missing');
  const parent = path.dirname(path.resolve(destination)), ownership = claimOutputRoot(parent);
  assertOwnedPath(ownership, destination, { mustExist: false });
  const staging = createOwnedTempDir(ownership, parent, 'archive-extract');
  const expected = [], state = { actualAggregate: 0 }, archiveFd = openValidatedArchive(plan);
  try {
    for (const entry of plan.entries) {
      const take = selected(entry);
      if (entry.directory) {
        if (take) ensureOwnedDir(ownership, path.join(staging, ...entry.segments));
        continue;
      }
      let target = null;
      if (take) {
        const directory = ensureOwnedDir(ownership, path.join(staging, ...entry.segments.slice(0, -1)));
        assertOwnedPath(ownership, directory, { mustExist: true, type: 'directory' });
        target = assertOwnedPath(ownership, path.join(staging, ...entry.segments), { mustExist: false });
      }
      const result = await processPayload(plan, entry, state, target, archiveFd);
      if (take) {
        assertOwnedPath(ownership, target, { mustExist: true, type: 'file' });
        expected.push({ relative: entry.key, bytes: result.bytes, sha256: result.sha256 });
      }
    }
    assertOpenArchiveIdentity(plan, archiveFd);
    if (state.actualAggregate !== plan.totalUncompressed) fail('YATZY_ARCHIVE_PAYLOAD_INVALID', 'aggregate payload length does not match');
    const actual = [];
    function walk(directory) {
      for (const dirent of fs.readdirSync(directory, { withFileTypes: true })) {
        const full = path.join(directory, dirent.name);
        assertOwnedPath(ownership, full, { mustExist: true, type: dirent.isDirectory() ? 'directory' : 'file' });
        if (dirent.isDirectory()) walk(full);
        else if (dirent.isFile()) {
          const stat = fs.statSync(full), fd = fs.openSync(full, 'r'), hash = createHash('sha256'), buffer = Buffer.alloc(CHUNK_BYTES);
          try { let position = 0, count; while ((count = fs.readSync(fd, buffer, 0, buffer.length, position)) > 0) { hash.update(buffer.subarray(0, count)); position += count; } }
          finally { fs.closeSync(fd); }
          actual.push({ relative: path.relative(staging, full).split(path.sep).join('/'), bytes: stat.size, sha256: hash.digest('hex') });
        }
        else fail('YATZY_ARCHIVE_SPECIAL_ENTRY', 'staging contains a special object');
      }
    }
    walk(staging); expected.sort((a, b) => a.relative.localeCompare(b.relative)); actual.sort((a, b) => a.relative.localeCompare(b.relative));
    if (stableJson(actual) !== stableJson(expected)) fail('YATZY_ARCHIVE_PAYLOAD_INVALID', 'extracted inventory does not match the archive plan');
    const archiveSha256 = await sha256ArchiveStreaming(plan);
    const promoted = promoteOwnedPath(ownership, staging, destination, { replaceExisting: false, cleanupOnFailure: true });
    return { destination: promoted, selectedFiles: expected.length, archiveEntries: plan.entryCount, archiveSha256, limitsSha256: plan.limitsSha256, passed: true };
  } catch (error) {
    if (fs.existsSync(staging)) {
      try { removeOwnedPath(ownership, staging, { recursive: true, allowMissing: true, type: 'directory' }); } catch {}
    }
    throw error;
  } finally { fs.closeSync(archiveFd); }
}

function creationEntry(name, source, directory, limits) {
  const rawName = Buffer.from(name, 'utf8'), parsed = validatePathName(name, rawName.length, limits);
  if (parsed.directory !== directory) fail('YATZY_ARCHIVE_INVALID_PATH', 'entry type and trailing slash disagree');
  if (directory) return { ...parsed, rawName, source: null, sourceBytes: 0, mtime: new Date(0) };
  const inspected = inspectSourceChain(source, 'file');
  if (inspected.stat.size > limits.uncompressedBytesPerEntry) fail('YATZY_ARCHIVE_LIMIT_EXCEEDED', 'source entry exceeds policy');
  return { ...parsed, rawName, source: inspected.absolute, sourceBytes: inspected.stat.size, sourceIdentity: fileIdentity(inspected.stat), mtime: inspected.stat.mtime };
}

function openStableSource(entry) {
  let fd;
  try {
    fd = fs.openSync(entry.source, 'r');
    inspectSourceChain(entry.source, 'file');
    if (!sameFileIdentity(entry.sourceIdentity, fileIdentity(fs.fstatSync(fd)))) fail('YATZY_ARCHIVE_SOURCE_INVALID', 'source identity changed after creation planning');
    return fd;
  } catch (error) {
    if (fd !== undefined) fs.closeSync(fd);
    wrapNative(error, 'YATZY_ARCHIVE_SOURCE_INVALID', 'source identity could not be opened');
  }
}

function prepareCreationEntries(entries, limits) {
  if (!Array.isArray(entries) || entries.length < 1 || entries.length > limits.entryCount) fail('YATZY_ARCHIVE_LIMIT_EXCEEDED', 'creation entry count violates policy');
  const prepared = entries.map(entry => {
    if (!entry || typeof entry !== 'object' || typeof entry.name !== 'string') fail('YATZY_ARCHIVE_SOURCE_INVALID', 'creation entry is malformed');
    const directory = entry.type === 'directory' || entry.name.endsWith('/');
    return creationEntry(entry.name, entry.source, directory, limits);
  }).sort((a, b) => Buffer.compare(a.rawName, b.rawName));
  validatePathPlan(prepared);
  const aggregate = prepared.reduce((sum, entry) => safeAdd(sum, entry.sourceBytes, 'YATZY_ARCHIVE_LIMIT_EXCEEDED'), 0);
  if (aggregate > limits.aggregateUncompressedBytes) fail('YATZY_ARCHIVE_LIMIT_EXCEEDED', 'creation aggregate exceeds policy');
  return prepared;
}

export function directoryEntries(sourceDirectory) {
  const root = inspectSourceChain(sourceDirectory, 'directory').absolute, entries = [];
  function walk(directory, relative) {
    const dirents = fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => Buffer.compare(Buffer.from(a.name), Buffer.from(b.name)));
    for (const dirent of dirents) {
      const full = path.join(directory, dirent.name), rel = relative ? `${relative}/${dirent.name}` : dirent.name;
      const inspected = inspectSourceChain(full, dirent.isDirectory() ? 'directory' : 'file');
      if (dirent.isDirectory()) { entries.push({ name: `${rel}/`, type: 'directory' }); walk(inspected.absolute, rel); }
      else if (dirent.isFile()) entries.push({ source: inspected.absolute, name: rel });
      else fail('YATZY_ARCHIVE_SPECIAL_ENTRY', 'source tree contains a link or special object');
    }
  }
  walk(root, '');
  return entries;
}

function invokeFault(options, stage) {
  if (typeof options.faultInjector === 'function') options.faultInjector(stage);
}

export async function createZip(outputPath, entries, onProgress = () => {}, options = {}) {
  if (typeof onProgress === 'object' && onProgress !== null) { options = onProgress; onProgress = () => {}; }
  const limits = mergeLimits(options.limits ?? {}), compression = options.compression ?? 'store';
  if (!['store', 'deflate'].includes(compression)) fail('YATZY_ARCHIVE_UNSUPPORTED_FEATURE', 'creation compression mode is unsupported');
  const prepared = prepareCreationEntries(entries, limits), destination = path.resolve(outputPath), parent = path.dirname(destination), ownership = claimOutputRoot(parent);
  assertOwnedPath(ownership, destination, { mustExist: false });
  const temporary = assertOwnedPath(ownership, path.join(parent, `.${path.basename(destination)}.archive-${randomUUID()}`), { mustExist: false });
  let fd, offset = 0;
  try {
    fd = fs.openSync(temporary, 'wx');
    const writeArchiveBytes = buffer => {
      const next = safeAdd(offset, buffer.length, 'YATZY_ARCHIVE_LIMIT_EXCEEDED');
      if (next > limits.archiveFileBytes || next > 0xffffffff) fail('YATZY_ARCHIVE_LIMIT_EXCEEDED', 'created archive exceeds ZIP32 policy');
      writeAll(fd, buffer); offset = next;
    };
    invokeFault(options, 'write');
    const central = [], total = prepared.reduce((sum, entry) => sum + entry.sourceBytes, 0); let done = 0;
    for (const entry of prepared) {
      const directory = entry.directory, method = directory || compression === 'store' ? 0 : 8, flags = UTF8_FLAG | (directory ? 0 : DESCRIPTOR_FLAG), dt = dosTimeDate(entry.mtime), localOffset = offset;
      const local = Buffer.alloc(30); local.writeUInt32LE(SIG_LOCAL, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(flags, 6); local.writeUInt16LE(method, 8); local.writeUInt16LE(dt.time, 10); local.writeUInt16LE(dt.day, 12); local.writeUInt16LE(entry.rawName.length, 26);
      writeArchiveBytes(local); writeArchiveBytes(entry.rawName);
      let crc = 0, uncompressedSize = 0, compressedSize = 0;
      if (!directory) {
        let runningCrc = 0xffffffff, streamFailure = null;
        const meter = new Transform({ transform(chunk, _encoding, callback) { try { uncompressedSize = safeAdd(uncompressedSize, chunk.length, 'YATZY_ARCHIVE_LIMIT_EXCEEDED'); done = safeAdd(done, chunk.length, 'YATZY_ARCHIVE_LIMIT_EXCEEDED'); if (uncompressedSize > entry.sourceBytes || uncompressedSize > limits.uncompressedBytesPerEntry || done > limits.aggregateUncompressedBytes) fail('YATZY_ARCHIVE_LIMIT_EXCEEDED', 'source payload grew beyond the creation plan'); runningCrc = crcUpdate(runningCrc, chunk); onProgress({ done, total, progress: total ? done / total : 1, file: entry.name }); callback(null, chunk); } catch (error) { streamFailure ??= error; callback(error); } } });
        const writer = new Writable({ write(chunk, _encoding, callback) { try { const nextCompressed = safeAdd(compressedSize, chunk.length, 'YATZY_ARCHIVE_LIMIT_EXCEEDED'); if (nextCompressed > limits.compressedBytesPerEntry) fail('YATZY_ARCHIVE_LIMIT_EXCEEDED', 'created compressed payload exceeds policy'); writeArchiveBytes(chunk); compressedSize = nextCompressed; callback(); } catch (error) { streamFailure ??= error; callback(error); } } });
        const sourceFd = openStableSource(entry);
        try {
          const sourceStream = fs.createReadStream(entry.source, { fd: sourceFd, autoClose: false, highWaterMark: CHUNK_BYTES });
          try {
            if (method === 8) await pipeline(sourceStream, meter, createDeflateRaw({ level: 6 }), writer);
            else await pipeline(sourceStream, meter, writer);
          } catch (error) { throw streamFailure ?? error; }
          if (!sameFileIdentity(entry.sourceIdentity, fileIdentity(fs.fstatSync(sourceFd)))) fail('YATZY_ARCHIVE_SOURCE_INVALID', 'source identity changed during archive creation');
        } finally {
          try { fs.closeSync(sourceFd); }
          catch (error) { if (!streamFailure) wrapNative(error, 'YATZY_ARCHIVE_SOURCE_INVALID', 'source identity could not be closed'); }
        }
        crc = (runningCrc ^ 0xffffffff) >>> 0;
        if (uncompressedSize !== entry.sourceBytes || compressedSize > limits.compressedBytesPerEntry || uncompressedSize > limits.uncompressedBytesPerEntry || uncompressedSize / Math.max(1, compressedSize) > limits.compressionRatio) fail('YATZY_ARCHIVE_LIMIT_EXCEEDED', 'created payload violates policy');
        const descriptor = Buffer.alloc(16); descriptor.writeUInt32LE(SIG_DESCRIPTOR, 0); descriptor.writeUInt32LE(crc, 4); descriptor.writeUInt32LE(compressedSize, 8); descriptor.writeUInt32LE(uncompressedSize, 12); writeArchiveBytes(descriptor);
      }
      central.push({ entry, method, flags, dt, localOffset, crc, compressedSize, uncompressedSize });
    }
    invokeFault(options, 'finalize');
    const centralOffset = offset;
    for (const item of central) {
      const record = Buffer.alloc(46); record.writeUInt32LE(SIG_CENTRAL, 0); record.writeUInt16LE((3 << 8) | 20, 4); record.writeUInt16LE(20, 6); record.writeUInt16LE(item.flags, 8); record.writeUInt16LE(item.method, 10); record.writeUInt16LE(item.dt.time, 12); record.writeUInt16LE(item.dt.day, 14); record.writeUInt32LE(item.crc, 16); record.writeUInt32LE(item.compressedSize, 20); record.writeUInt32LE(item.uncompressedSize, 24); record.writeUInt16LE(item.entry.rawName.length, 28); record.writeUInt32LE(((item.entry.directory ? 0o040755 : 0o100644) << 16) >>> 0, 38); record.writeUInt32LE(item.localOffset, 42);
      writeArchiveBytes(record); writeArchiveBytes(item.entry.rawName);
    }
    const centralSize = offset - centralOffset, end = Buffer.alloc(22); end.writeUInt32LE(SIG_EOCD, 0); end.writeUInt16LE(central.length, 8); end.writeUInt16LE(central.length, 10); end.writeUInt32LE(centralSize, 12); end.writeUInt32LE(centralOffset, 16); writeArchiveBytes(end);
    fs.fsyncSync(fd); fs.closeSync(fd); fd = undefined;
    invokeFault(options, 'verify');
    const required = prepared.map(entry => entry.directory ? `${entry.key}/` : entry.key), audit = await auditZip(temporary, required, { limits });
    if (audit.entryCount !== prepared.length) fail('YATZY_ARCHIVE_CREATION_FAILED', 'post-write inventory does not match');
    invokeFault(options, 'promote');
    assertOwnedPath(ownership, destination, { mustExist: false }); assertOwnedPath(ownership, temporary, { mustExist: true, type: 'file' }); fs.renameSync(temporary, destination); assertOwnedPath(ownership, destination, { mustExist: true, type: 'file' });
    return { path: destination, size: offset, entryCount: prepared.length, audit };
  } catch (error) {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch {} }
    if (fs.existsSync(temporary)) { try { fs.unlinkSync(temporary); } catch {} }
    if (error instanceof ArchivePolicyError) throw error;
    fail('YATZY_ARCHIVE_CREATION_FAILED', 'creation failed');
  }
}

export async function createZipFromDirectory(sourceDirectory, outputPath, options = {}) {
  return createZip(outputPath, directoryEntries(sourceDirectory), () => {}, { ...options, compression: options.compression ?? 'deflate' });
}
