import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import { openRunDatabase, setMeta, getMeta, checkpointDb } from '../src/database.mjs';
test('SQLite run metadata uses WAL and FULL synchronous durability',()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'yatzy-db-'));const db=openRunDatabase(dir);
  assert.equal(String(db.prepare('PRAGMA journal_mode').get().journal_mode).toLowerCase(),'wal');
  assert.equal(Number(db.prepare('PRAGMA synchronous').get().synchronous),2);
  setMeta(db,'test',{ok:true});assert.deepEqual(getMeta(db,'test'),{ok:true});checkpointDb(db);db.close();
});
