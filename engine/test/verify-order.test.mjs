import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

test('verification loads tables before constructing PolicyEngine', () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const source = fs.readFileSync(path.join(here, '..', 'src', 'solver', 'verify.mjs'), 'utf8');
  const loadAt = source.indexOf('const tables=readTables(');
  const engineAt = source.indexOf('new PolicyEngine({...tables');
  assert.ok(loadAt >= 0, 'table load declaration is present');
  assert.ok(engineAt >= 0, 'policy engine construction is present');
  assert.ok(loadAt < engineAt, 'tables are initialized before PolicyEngine uses them');
});
