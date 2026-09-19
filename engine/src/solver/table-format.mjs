import fs from 'node:fs';
import { sha256File } from '../util/hash.mjs';

export const HEADER_SIZE = 128;
export const VALUE_MAGIC = 'YTZVAL02';
export const BOUNDS_MAGIC = 'YTZBND02';

function makeHeader(magic, stateCount, rulesHashHex, stride) {
  const b = Buffer.alloc(HEADER_SIZE);
  b.write(magic, 0, 'ascii');
  b.writeUInt16LE(2, 8);
  b.writeUInt16LE(HEADER_SIZE, 10);
  b.writeUInt32LE(stateCount, 12);
  b.writeUInt8(15, 16);
  b.writeUInt8(63, 17);
  b.writeUInt8(1, 18); // f64 little-endian
  b.writeUInt8(stride, 19);
  Buffer.from(rulesHashHex, 'hex').copy(b, 24, 0, 32);
  return b;
}

export function createValueFiles(valuesPath, boundsPath, stateCount, rulesHashHex) {
  const valueFd = fs.openSync(valuesPath, 'w+');
  const boundsFd = fs.openSync(boundsPath, 'w+');
  fs.writeSync(valueFd, makeHeader(VALUE_MAGIC, stateCount, rulesHashHex, 1), 0, HEADER_SIZE, 0);
  fs.writeSync(boundsFd, makeHeader(BOUNDS_MAGIC, stateCount, rulesHashHex, 2), 0, HEADER_SIZE, 0);
  fs.ftruncateSync(valueFd, HEADER_SIZE + stateCount * 8);
  fs.ftruncateSync(boundsFd, HEADER_SIZE + stateCount * 16);
  return { valueFd, boundsFd };
}

export function openValueFiles(valuesPath, boundsPath) {
  return { valueFd: fs.openSync(valuesPath, 'r+'), boundsFd: fs.openSync(boundsPath, 'r+') };
}

export function writeChunkFiles(valueFd, boundsFd, indices, values, lower, upper) {
  let runStart = 0;
  for (let p = 1; p <= indices.length; p += 1) {
    const endRun = p === indices.length || indices[p] !== indices[p - 1] + 1;
    if (!endRun) continue;
    const count = p - runStart;
    const firstIndex = indices[runStart];
    const vbuf = Buffer.allocUnsafe(count * 8);
    const bbuf = Buffer.allocUnsafe(count * 16);
    for (let j = 0; j < count; j += 1) {
      vbuf.writeDoubleLE(values[runStart + j], j * 8);
      bbuf.writeDoubleLE(lower[runStart + j], j * 16);
      bbuf.writeDoubleLE(upper[runStart + j], j * 16 + 8);
    }
    fs.writeSync(valueFd, vbuf, 0, vbuf.length, HEADER_SIZE + firstIndex * 8);
    fs.writeSync(boundsFd, bbuf, 0, bbuf.length, HEADER_SIZE + firstIndex * 16);
    runStart = p;
  }
}

export function readTables(valuesPath, boundsPath, stateCount) {
  const values = new Float64Array(stateCount);
  const lower = new Float64Array(stateCount);
  const upper = new Float64Array(stateCount);
  const vfd = fs.openSync(valuesPath, 'r');
  const bfd = fs.openSync(boundsPath, 'r');
  const vbuf = Buffer.allocUnsafe(stateCount * 8);
  const bbuf = Buffer.allocUnsafe(stateCount * 16);
  fs.readSync(vfd, vbuf, 0, vbuf.length, HEADER_SIZE);
  fs.readSync(bfd, bbuf, 0, bbuf.length, HEADER_SIZE);
  fs.closeSync(vfd); fs.closeSync(bfd);
  for (let i = 0; i < stateCount; i += 1) {
    values[i] = vbuf.readDoubleLE(i * 8);
    lower[i] = bbuf.readDoubleLE(i * 16);
    upper[i] = bbuf.readDoubleLE(i * 16 + 8);
  }
  return { values, lower, upper };
}

export async function artifactHashes(valuesPath, boundsPath) {
  return { valuesSha256: await sha256File(valuesPath), boundsSha256: await sha256File(boundsPath) };
}

export function verifyHeader(path, expectedMagic, stateCount, rulesHashHex, expectedStride) {
  const fd = fs.openSync(path, 'r');
  const b = Buffer.alloc(HEADER_SIZE);
  fs.readSync(fd, b, 0, HEADER_SIZE, 0);
  const stat = fs.fstatSync(fd);
  fs.closeSync(fd);
  const magic = b.toString('ascii', 0, 8);
  const count = b.readUInt32LE(12);
  const stride = b.readUInt8(19);
  const hash = b.subarray(24, 56).toString('hex');
  const expectedLength = HEADER_SIZE + stateCount * stride * 8;
  return {
    magic, count, stride, hash, length: stat.size, expectedLength,
    passed: magic === expectedMagic && count === stateCount && stride === expectedStride && hash === rulesHashHex && stat.size === expectedLength
  };
}
