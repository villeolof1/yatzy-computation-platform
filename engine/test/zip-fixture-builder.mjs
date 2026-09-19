import { deflateRawSync } from 'node:zlib';
import { crc32 } from '../src/util/zip.mjs';

const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_DESCRIPTOR = 0x08074b50;
const SIG_EOCD = 0x06054b50;

function bytes(value) {
  return Buffer.isBuffer(value) ? Buffer.from(value) : Buffer.from(value ?? '');
}

export function buildZipFixture(entries, options = {}) {
  const localParts = [], centralParts = [], records = [];
  let offset = options.prepended?.length ?? 0;
  if (options.prepended) localParts.push(bytes(options.prepended));
  for (const [index, source] of entries.entries()) {
    const data = bytes(source.data), method = source.method ?? 0;
    const compressed = source.compressedData ? bytes(source.compressedData) : method === 8 ? deflateRawSync(data) : data;
    const centralName = source.centralRawName ? bytes(source.centralRawName) : Buffer.from(source.centralName ?? source.name, 'utf8');
    const localName = source.localRawName ? bytes(source.localRawName) : Buffer.from(source.localName ?? source.name, 'utf8');
    const descriptor = source.descriptor ?? false;
    const flags = source.flags ?? (descriptor ? 0x0008 : 0x0800);
    const crc = source.crc ?? crc32(data);
    const compressedSize = source.compressedSize ?? compressed.length;
    const uncompressedSize = source.uncompressedSize ?? data.length;
    const localExtra = bytes(source.localExtra), centralExtra = bytes(source.centralExtra), comment = bytes(source.comment);
    const localOffset = offset;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(source.localSignature ?? SIG_LOCAL, 0);
    local.writeUInt16LE(source.localVersionNeeded ?? source.versionNeeded ?? 20, 4);
    local.writeUInt16LE(source.localFlags ?? flags, 6);
    local.writeUInt16LE(source.localMethod ?? method, 8);
    local.writeUInt16LE(source.localModifiedTime ?? source.modifiedTime ?? 0, 10);
    local.writeUInt16LE(source.localModifiedDate ?? source.modifiedDate ?? 0, 12);
    local.writeUInt32LE(source.localCrc ?? (descriptor ? 0 : crc), 14);
    local.writeUInt32LE(source.localCompressedSize ?? (descriptor ? 0 : compressedSize), 18);
    local.writeUInt32LE(source.localUncompressedSize ?? (descriptor ? 0 : uncompressedSize), 22);
    local.writeUInt16LE(localName.length, 26);
    local.writeUInt16LE(localExtra.length, 28);
    localParts.push(local, localName, localExtra, compressed);
    offset += local.length + localName.length + localExtra.length + compressed.length;
    if (descriptor) {
      const value = Buffer.alloc(source.descriptorSignature === false ? 12 : 16), base = source.descriptorSignature === false ? 0 : 4;
      if (base) value.writeUInt32LE(SIG_DESCRIPTOR, 0);
      value.writeUInt32LE(source.descriptorCrc ?? crc, base);
      value.writeUInt32LE(source.descriptorCompressedSize ?? compressedSize, base + 4);
      value.writeUInt32LE(source.descriptorUncompressedSize ?? uncompressedSize, base + 8);
      localParts.push(value); offset += value.length;
    }
    records.push({ index, localOffset, localLength: offset - localOffset, centralName, localName, compressed, crc, compressedSize, uncompressedSize });
    const central = Buffer.alloc(46);
    central.writeUInt32LE(source.centralSignature ?? SIG_CENTRAL, 0);
    central.writeUInt16LE(((source.creatorSystem ?? 3) << 8) | 20, 4);
    central.writeUInt16LE(source.versionNeeded ?? 20, 6);
    central.writeUInt16LE(flags, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(source.modifiedTime ?? 0, 12);
    central.writeUInt16LE(source.modifiedDate ?? 0, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(compressedSize, 20);
    central.writeUInt32LE(uncompressedSize, 24);
    central.writeUInt16LE(centralName.length, 28);
    central.writeUInt16LE(centralExtra.length, 30);
    central.writeUInt16LE(comment.length, 32);
    central.writeUInt16LE(source.diskStart ?? 0, 34);
    const directory = (source.name ?? '').endsWith('/');
    const mode = source.unixMode ?? (directory ? 0o040755 : 0o100644);
    central.writeUInt32LE(source.externalAttributes ?? ((mode << 16) >>> 0), 38);
    central.writeUInt32LE(source.localOffset ?? localOffset, 42);
    centralParts.push(central, centralName, centralExtra, comment);
  }
  const centralOffset = offset, central = Buffer.concat(centralParts), archiveComment = bytes(options.archiveComment);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(options.eocdSignature ?? SIG_EOCD, 0);
  eocd.writeUInt16LE(options.disk ?? 0, 4);
  eocd.writeUInt16LE(options.centralDisk ?? 0, 6);
  eocd.writeUInt16LE(options.diskEntries ?? entries.length, 8);
  eocd.writeUInt16LE(options.entryCount ?? entries.length, 10);
  eocd.writeUInt32LE(options.centralSize ?? central.length, 12);
  eocd.writeUInt32LE(options.centralOffset ?? centralOffset, 16);
  eocd.writeUInt16LE(archiveComment.length, 20);
  const buffer = Buffer.concat([...localParts, central, eocd, archiveComment, bytes(options.trailing)]);
  return { buffer, records, centralOffset, centralSize: central.length, eocdOffset: centralOffset + central.length };
}

export function patchUInt16(fixture, offset, value) {
  const buffer = Buffer.from(fixture.buffer); buffer.writeUInt16LE(value, offset); return { ...fixture, buffer };
}

export function patchUInt32(fixture, offset, value) {
  const buffer = Buffer.from(fixture.buffer); buffer.writeUInt32LE(value >>> 0, offset); return { ...fixture, buffer };
}
