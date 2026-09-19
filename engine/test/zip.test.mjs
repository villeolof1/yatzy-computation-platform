import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { deflateRawSync } from 'node:zlib';
import {
  ARCHIVE_LIMITS_SHA256,
  auditZip,
  createZip,
  createZipFromDirectory,
  extractZip,
  listZip,
  parseZipStructure,
  verifyZip
} from '../src/util/zip.mjs';
import { buildZipFixture, patchUInt16, patchUInt32 } from './zip-fixture-builder.mjs';

function temporary(t, prefix = 'yatzy-zip-') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function fixtureFile(t, fixture, name = 'fixture.zip') {
  const root = temporary(t), file = path.join(root, name);
  fs.writeFileSync(file, fixture.buffer ?? fixture);
  return { root, file };
}

function assertCode(fn, code) {
  assert.throws(fn, error => error?.code === code);
}

async function assertCodeAsync(fn, code) {
  await assert.rejects(fn, error => error?.code === code);
}

test('shared stored writer atomically creates, verifies, audits, and extracts exact payloads', async t => {
  const root = temporary(t), sourceA = path.join(root, 'a.txt'), sourceB = path.join(root, 'b.bin'), archive = path.join(root, 'out.zip');
  fs.writeFileSync(sourceA, 'hello'); fs.writeFileSync(sourceB, Buffer.alloc(1024, 7));
  const created = await createZip(archive, [{ source: sourceB, name: 'data/b.bin' }, { source: sourceA, name: 'README.txt' }]);
  assert.equal(created.entryCount, 2);
  assert.deepEqual(listZip(archive), ['README.txt', 'data/b.bin']);
  const verified = verifyZip(archive, ['README.txt', 'data/']);
  assert.equal(verified.passed, true); assert.equal(verified.limitsSha256, ARCHIVE_LIMITS_SHA256);
  const audited = await auditZip(archive, ['README.txt', 'data/b.bin']);
  assert.equal(audited.passed, true); assert.equal(audited.payloadVerification, 'pass');
  const destination = path.join(root, 'extracted');
  const extraction = await extractZip(archive, destination);
  assert.equal(extraction.passed, true);
  assert.equal(fs.readFileSync(path.join(destination, 'README.txt'), 'utf8'), 'hello');
  assert.deepEqual(fs.readFileSync(path.join(destination, 'data', 'b.bin')), Buffer.alloc(1024, 7));
});

test('shared recursive deflate writer preserves files and safe directory membership', async t => {
  const root = temporary(t), source = path.join(root, 'source'), archive = path.join(root, 'deflate.zip');
  fs.mkdirSync(path.join(source, 'source_snapshot', 'empty'), { recursive: true });
  fs.writeFileSync(path.join(source, 'source_snapshot', 'text.txt'), 'deflated payload\n');
  await createZipFromDirectory(source, archive, { compression: 'deflate' });
  const audit = await auditZip(archive, ['source_snapshot/', 'source_snapshot/text.txt']);
  assert.equal(audit.passed, true); assert.deepEqual(audit.compressionMethods, [0, 8]);
  const destination = path.join(root, 'selected');
  await extractZip(archive, destination, { prefix: 'source_snapshot/' });
  assert.equal(fs.readFileSync(path.join(destination, 'source_snapshot', 'text.txt'), 'utf8'), 'deflated payload\n');
});

test('accepted research ZIP32 stored signed-descriptor format remains compatible', async t => {
  const fixture = buildZipFixture([{ name: 'README.txt', data: 'accepted\n', flags: 0x0008, descriptor: true, creatorSystem: 0, externalAttributes: 0 }], { archiveComment: 'bounded comment' });
  const { file } = fixtureFile(t, fixture);
  assert.equal((await auditZip(file, ['README.txt'])).passed, true);
});

test('historical V3 tar dot-segment representation is intentionally rejected after creator migration', t => {
  const { file } = fixtureFile(t, buildZipFixture([{ name: './README.txt', data: 'old' }]));
  assertCode(() => parseZipStructure(file), 'YATZY_ARCHIVE_INVALID_PATH');
});

test('EOCD and central-directory corruptions fail closed', async t => {
  const base = buildZipFixture([{ name: 'a.txt', data: 'a' }]);
  const cases = [
    ['missing-eocd', { buffer: base.buffer.subarray(0, base.eocdOffset) }, 'YATZY_ARCHIVE_INVALID_STRUCTURE'],
    ['truncated-eocd', { buffer: base.buffer.subarray(0, base.buffer.length - 1) }, 'YATZY_ARCHIVE_INVALID_STRUCTURE'],
    ['bad-signature', patchUInt32(base, base.eocdOffset, 0x06054b51), 'YATZY_ARCHIVE_INVALID_STRUCTURE'],
    ['multi-disk', patchUInt16(base, base.eocdOffset + 4, 1), 'YATZY_ARCHIVE_UNSUPPORTED_FEATURE'],
    ['count-mismatch', patchUInt16(base, base.eocdOffset + 10, 2), 'YATZY_ARCHIVE_UNSUPPORTED_FEATURE'],
    ['central-outside', patchUInt32(base, base.eocdOffset + 16, base.buffer.length), 'YATZY_ARCHIVE_INVALID_STRUCTURE'],
    ['zip64-sentinel', patchUInt32(base, base.eocdOffset + 12, 0xffffffff), 'YATZY_ARCHIVE_UNSUPPORTED_FEATURE'],
    ['trailing-byte', { buffer: Buffer.concat([base.buffer, Buffer.from([0])]) }, 'YATZY_ARCHIVE_INVALID_STRUCTURE']
  ];
  for (const [name, value, code] of cases) await t.test(name, () => { const { file } = fixtureFile(t, value, `${name}.zip`); assertCode(() => parseZipStructure(file), code); });
  await t.test('malformed-extra-bounds', () => {
    const extra = Buffer.from([0x55, 0x54, 0xff, 0xff, 1]);
    const { file } = fixtureFile(t, buildZipFixture([{ name: 'a.txt', data: 'a', centralExtra: extra }]));
    assertCode(() => parseZipStructure(file), 'YATZY_ARCHIVE_INVALID_STRUCTURE');
  });
  await t.test('zip64-extra', () => {
    const extra = Buffer.from([1, 0, 0, 0]);
    const { file } = fixtureFile(t, buildZipFixture([{ name: 'a.txt', data: 'a', centralExtra: extra }]));
    assertCode(() => parseZipStructure(file), 'YATZY_ARCHIVE_UNSUPPORTED_FEATURE');
  });
});

test('central and local header inconsistencies fail before payload use', async t => {
  const cases = [
    ['name', { name: 'a.txt', localName: 'b.txt', data: 'a' }],
    ['version-needed', { name: 'a.txt', data: 'a', localVersionNeeded: 10 }],
    ['flags', { name: 'a.txt', data: 'a', flags: 0x0800, localFlags: 0 }],
    ['method', { name: 'a.txt', data: 'a', method: 0, localMethod: 8 }],
    ['modified-time', { name: 'a.txt', data: 'a', modifiedTime: 1, localModifiedTime: 2 }],
    ['modified-date', { name: 'a.txt', data: 'a', modifiedDate: 1, localModifiedDate: 2 }],
    ['crc', { name: 'a.txt', data: 'a', localCrc: 0 }],
    ['compressed-size', { name: 'a.txt', data: 'a', localCompressedSize: 2 }],
    ['uncompressed-size', { name: 'a.txt', data: 'a', localUncompressedSize: 2 }],
    ['local-signature', { name: 'a.txt', data: 'a', localSignature: 0 }],
    ['descriptor', { name: 'a.txt', data: 'a', descriptor: true, descriptorCrc: 0 }]
  ];
  for (const [name, entry] of cases) await t.test(name, () => {
    const { file } = fixtureFile(t, buildZipFixture([entry]), `${name}.zip`);
    assertCode(() => parseZipStructure(file), 'YATZY_ARCHIVE_INVALID_STRUCTURE');
  });
  await t.test('overlap', () => {
    const value = buildZipFixture([{ name: 'a.txt', data: 'a' }, { name: 'b.txt', data: 'b', localOffset: 0 }]);
    const { file } = fixtureFile(t, value); assertCode(() => parseZipStructure(file), 'YATZY_ARCHIVE_INVALID_STRUCTURE');
  });
});

test('every mandated traversal and Windows-portability path is rejected', async t => {
  const paths = ['../evil', 'a/../../evil', '/absolute', 'C:/drive', 'C:\\drive', '\\\\server\\share', 'a\\b', './a', 'a/./b', 'a//b', 'a/../b', 'a?b', 'a*b', 'a|b', 'a<b', 'a>b', 'a"b', 'a:b', 'CON', 'con.txt', 'NUL.data', 'COM1.log', 'LPT9.bin', 'trailing.', 'trailing ', 'safe/CON/file'];
  for (const [index, name] of paths.entries()) await t.test(`unsafe-${index}`, () => {
    const { file } = fixtureFile(t, buildZipFixture([{ name, data: 'x' }]), `unsafe-${index}.zip`);
    assertCode(() => parseZipStructure(file), 'YATZY_ARCHIVE_INVALID_PATH');
  });
});

test('duplicate, case-fold, prefix, and file-directory aliases are rejected', async t => {
  const cases = [
    [{ name: 'a.txt', data: '1' }, { name: 'a.txt', data: '2' }],
    [{ name: 'A.txt', data: '1' }, { name: 'a.txt', data: '2' }],
    [{ name: 'Dir/a.txt', data: '1' }, { name: 'dir/b.txt', data: '2' }],
    [{ name: 'Ä/a.txt', data: '1' }, { name: 'ä/b.txt', data: '2' }],
    [{ name: 'a', data: '1' }, { name: 'a/b.txt', data: '2' }],
    [{ name: 'a/', data: '' }, { name: 'a', data: '' }]
  ];
  for (const [index, entries] of cases.entries()) await t.test(`alias-${index}`, () => {
    const { file } = fixtureFile(t, buildZipFixture(entries), `alias-${index}.zip`);
    assertCode(() => parseZipStructure(file), 'YATZY_ARCHIVE_DUPLICATE_PATH');
  });
});

test('Unix links and special objects plus suspicious creators are rejected', async t => {
  const modes = [0o120777, 0o010644, 0o020644, 0o060644, 0o140777];
  for (const mode of modes) await t.test(`mode-${mode.toString(8)}`, () => {
    const { file } = fixtureFile(t, buildZipFixture([{ name: 'a', data: 'x', unixMode: mode }]));
    assertCode(() => parseZipStructure(file), 'YATZY_ARCHIVE_SPECIAL_ENTRY');
  });
  await t.test('creator-system', () => {
    const { file } = fixtureFile(t, buildZipFixture([{ name: 'a', data: 'x', creatorSystem: 7 }]));
    assertCode(() => parseZipStructure(file), 'YATZY_ARCHIVE_SPECIAL_ENTRY');
  });
  for (const [name, externalAttributes] of [['dos-unix-mode', (0o120777 << 16) >>> 0], ['dos-hidden', 0x02], ['dos-unknown', 0x40]]) await t.test(name, () => {
    const { file } = fixtureFile(t, buildZipFixture([{ name: 'a', data: 'x', creatorSystem: 0, externalAttributes }]));
    assertCode(() => parseZipStructure(file), 'YATZY_ARCHIVE_SPECIAL_ENTRY');
  });
});

test('encoding, encryption, flags, methods, and descriptors fail closed', async t => {
  const invalidUtf8 = Buffer.from([0xc3, 0x28]);
  const valid = fixtureFile(t, buildZipFixture([{ name: 'mätning.txt', data: 'ok', flags: 0x0800 }]));
  assert.equal((await auditZip(valid.file)).passed, true);
  const cases = [
    ['invalid-utf8', { name: 'x', centralRawName: invalidUtf8, localRawName: invalidUtf8, flags: 0x0800 }, 'YATZY_ARCHIVE_INVALID_PATH'],
    ['legacy-nonascii', { name: 'x', centralRawName: Buffer.from([0xe5]), localRawName: Buffer.from([0xe5]), flags: 0 }, 'YATZY_ARCHIVE_INVALID_PATH'],
    ['non-nfc', { name: 'e\u0301.txt', data: 'x', flags: 0x0800 }, 'YATZY_ARCHIVE_INVALID_PATH'],
    ['encrypted', { name: 'a', data: 'x', flags: 0x0801, localFlags: 0x0801 }, 'YATZY_ARCHIVE_UNSUPPORTED_FEATURE'],
    ['patched', { name: 'a', data: 'x', flags: 0x0820, localFlags: 0x0820 }, 'YATZY_ARCHIVE_UNSUPPORTED_FEATURE'],
    ['strong', { name: 'a', data: 'x', flags: 0x0840, localFlags: 0x0840 }, 'YATZY_ARCHIVE_UNSUPPORTED_FEATURE'],
    ['method', { name: 'a', data: 'x', method: 12, localMethod: 12 }, 'YATZY_ARCHIVE_UNSUPPORTED_FEATURE'],
    ['unsigned-descriptor', { name: 'a', data: 'x', descriptor: true, descriptorSignature: false }, 'YATZY_ARCHIVE_INVALID_STRUCTURE']
  ];
  for (const [name, entry, code] of cases) await t.test(name, () => {
    const { file } = fixtureFile(t, buildZipFixture([entry]), `${name}.zip`);
    assertCode(() => parseZipStructure(file), code);
  });
});

test('CRC, declared length, deflate truncation, corruption, and trailing compressed bytes are rejected', async t => {
  const data = Buffer.from('payload payload payload payload');
  const compressed = deflateRawSync(data);
  const cases = [
    ['crc', { name: 'a', data, crc: 0 }],
    ['declared-length', { name: 'a', data, uncompressedSize: data.length + 1, localUncompressedSize: data.length + 1 }],
    ['truncated-deflate', { name: 'a', data, method: 8, compressedData: compressed.subarray(0, compressed.length - 1) }],
    ['corrupt-deflate', { name: 'a', data, method: 8, compressedData: Buffer.from(compressed.map((value, index) => index === 2 ? value ^ 0xff : value)) }],
    ['trailing-deflate', { name: 'a', data, method: 8, compressedData: Buffer.concat([compressed, Buffer.from([0, 0])]) }]
  ];
  for (const [name, entry] of cases) await t.test(name, async () => {
    const { file } = fixtureFile(t, buildZipFixture([entry]), `${name}.zip`);
    await assertCodeAsync(() => auditZip(file), 'YATZY_ARCHIVE_PAYLOAD_INVALID');
  });
});

test('tiny injected resource ceilings reject without bomb-sized allocation', async t => {
  const two = buildZipFixture([{ name: 'a', data: '1' }, { name: 'b', data: '2' }]);
  const cases = [
    ['entries', two, { entryCount: 1 }],
    ['filename', buildZipFixture([{ name: 'long-name', data: 'x' }]), { filenameBytes: 4 }],
    ['archive', buildZipFixture([{ name: 'a', data: 'x' }]), { archiveFileBytes: 30 }],
    ['compressed', buildZipFixture([{ name: 'a', data: '1234' }]), { compressedBytesPerEntry: 3 }],
    ['uncompressed', buildZipFixture([{ name: 'a', data: '1234' }]), { uncompressedBytesPerEntry: 3 }],
    ['aggregate', two, { aggregateUncompressedBytes: 1 }],
    ['ratio', buildZipFixture([{ name: 'a', data: Buffer.alloc(64), method: 8 }]), { compressionRatio: 2 }],
    ['depth', buildZipFixture([{ name: 'a/b/c', data: 'x' }]), { pathDepth: 2 }]
  ];
  for (const [name, fixture, limits] of cases) await t.test(name, () => {
    const { file } = fixtureFile(t, fixture, `${name}.zip`);
    assertCode(() => parseZipStructure(file, { limits }), 'YATZY_ARCHIVE_LIMIT_EXCEEDED');
  });
});

test('required entries distinguish exact files from real directory prefixes in both audit interfaces', async t => {
  async function assertRequiredMissing(file, required) {
    await assertCodeAsync(() => auditZip(file, [required]), 'YATZY_ARCHIVE_REQUIRED_ENTRY_MISSING');
    assert.deepEqual(verifyZip(file, [required]), {
      passed: false,
      code: 'YATZY_ARCHIVE_REQUIRED_ENTRY_MISSING',
      reason: 'Archive required entry is missing'
    });
  }

  await t.test('regular file at the exact directory key is rejected', async () => {
    const { file } = fixtureFile(t, buildZipFixture([{ name: 'source_snapshot', data: 'file' }]), 'regular-impostor.zip');
    await assertRequiredMissing(file, 'source_snapshot/');
  });

  await t.test('explicit empty directory satisfies the directory prefix', async () => {
    const { file } = fixtureFile(t, buildZipFixture([{ name: 'source_snapshot/', data: '' }]), 'explicit-directory.zip');
    assert.equal((await auditZip(file, ['source_snapshot/'])).passed, true);
    assert.equal(verifyZip(file, ['source_snapshot/']).passed, true);
  });

  await t.test('implicit directory with a genuine descendant satisfies the directory prefix', async () => {
    const { file } = fixtureFile(t, buildZipFixture([{ name: 'source_snapshot/file.txt', data: 'x' }]), 'implicit-directory.zip');
    assert.equal((await auditZip(file, ['source_snapshot/'])).passed, true);
    assert.equal(verifyZip(file, ['source_snapshot/']).passed, true);
  });

  await t.test('component-boundary directory impostor is rejected', async () => {
    const { file } = fixtureFile(t, buildZipFixture([{ name: 'source_snapshot-evil/', data: '' }]), 'boundary-directory.zip');
    await assertRequiredMissing(file, 'source_snapshot/');
  });

  await t.test('regular filename prefix impostor is rejected', async () => {
    const { file } = fixtureFile(t, buildZipFixture([{ name: 'source_snapshot.txt', data: 'x' }]), 'filename-impostor.zip');
    await assertRequiredMissing(file, 'source_snapshot/');
  });

  await t.test('exact-file requirement accepts the exact regular file', async () => {
    const { file } = fixtureFile(t, buildZipFixture([{ name: 'source_snapshot', data: 'file' }]), 'exact-file.zip');
    assert.equal((await auditZip(file, ['source_snapshot'])).passed, true);
    assert.equal(verifyZip(file, ['source_snapshot']).passed, true);
  });

  await t.test('exact-file requirement rejects an explicit directory', async () => {
    const { file } = fixtureFile(t, buildZipFixture([{ name: 'source_snapshot/', data: '' }]), 'directory-not-file.zip');
    await assertRequiredMissing(file, 'source_snapshot');
  });
});
