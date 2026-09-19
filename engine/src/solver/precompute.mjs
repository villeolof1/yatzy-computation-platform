import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Worker } from 'node:worker_threads';
import { createHash } from 'node:crypto';
import { createStateIndex } from './state-index.mjs';
import { createValueFiles, openValueFiles, writeChunkFiles, readTables, artifactHashes, HEADER_SIZE } from './table-format.mjs';
import { createPolicyFile, openPolicyFile, writePolicyChunk, policyHash } from './policy-format.mjs';
import { ensureDir, writeJsonAtomic, safeUnlink } from '../util/fs.mjs';
import { addEvent, checkpointDb, setMeta } from '../database.mjs';

function chunkHash(indices, values, lower, upper) {
  const h = createHash('sha256');
  h.update(Buffer.from(indices.buffer, indices.byteOffset, indices.byteLength));
  h.update(Buffer.from(values.buffer, values.byteOffset, values.byteLength));
  h.update(Buffer.from(lower.buffer, lower.byteOffset, lower.byteLength));
  h.update(Buffer.from(upper.buffer, upper.byteOffset, upper.byteLength));
  return h.digest('hex');
}

function mergeAgg(target, source) {
  if (!source) return target;
  if (!target) return structuredClone(source);
  for (let s = 0; s < 3; s += 1) {
    target.decisions[s] += source.decisions[s];
    target.exactTies[s] += source.exactTies[s];
    target.intervalOverlaps[s] += source.intervalOverlaps[s];
    target.earlyScores[s] += source.earlyScores[s];
    for (let i = 0; i < 2; i += 1) target.actionTypes[s][i] += source.actionTypes[s][i];
    for (let i = 0; i < 5; i += 1) target.keeperSizes[s][i] += source.keeperSizes[s][i];
    for (let i = 0; i < 15; i += 1) target.categories[s][i] += source.categories[s][i];
    for (let i = 0; i < target.marginBins[s].length; i += 1) target.marginBins[s][i] += source.marginBins[s][i];
  }
  for (let i = 0; i < 2; i += 1) {
    target.rerollValueSum[i] += source.rerollValueSum[i];
    target.rerollValueCount[i] += source.rerollValueCount[i];
  }
  target.surprises.push(...source.surprises);
  target.surprises.sort((a, b) => b.regret - a.regret || a.stateIndex - b.stateIndex);
  if (target.surprises.length > 500) target.surprises.length = 500;
  return target;
}

class WorkerPool {
  constructor(count, workerData) {
    this.idle = [];
    this.waiters = [];
    this.workers = [];
    for (let i = 0; i < count; i += 1) {
      const worker = new Worker(new URL('./precompute-worker.mjs', import.meta.url), { workerData });
      this.workers.push(worker);
      this.idle.push(worker);
    }
  }
  async acquire() {
    if (this.idle.length) return this.idle.pop();
    return new Promise(resolve => this.waiters.push(resolve));
  }
  release(worker) {
    const waiter = this.waiters.shift();
    if (waiter) waiter(worker); else this.idle.push(worker);
  }
  async run(task) {
    const worker = await this.acquire();
    return new Promise((resolve, reject) => {
      const onMessage = result => {
        if (result.taskId !== task.taskId) return;
        cleanup(); this.release(worker); resolve(result);
      };
      const onError = error => { cleanup(); this.release(worker); reject(error); };
      const cleanup = () => { worker.off('message', onMessage); worker.off('error', onError); };
      worker.on('message', onMessage); worker.on('error', onError);
      worker.postMessage(task, [task.indicesBuffer]);
    });
  }
  async close() { await Promise.all(this.workers.map(w => w.terminate())); }
}

function prepareChunks(db, buildId, stateIndex, chunkSize) {
  const insertChunk = db.prepare(`INSERT OR IGNORE INTO chunks(build_id,layer,ordinal,start_pos,state_count,status) VALUES (?,?,?,?,?,'PENDING')`);
  const insertLayer = db.prepare(`INSERT OR IGNORE INTO layers(layer,state_count,chunk_count,status) VALUES (?,?,?,'PENDING')`);
  db.exec('BEGIN IMMEDIATE');
  try {
    for (let layer = 15; layer >= 0; layer -= 1) {
      const states = stateIndex.layers[layer];
      const chunkCount = Math.ceil(states.length / chunkSize);
      if (buildId === 'primary') insertLayer.run(layer, states.length, chunkCount);
      for (let ordinal = 0; ordinal < chunkCount; ordinal += 1) {
        const start = ordinal * chunkSize;
        insertChunk.run(buildId, layer, ordinal, start, Math.min(chunkSize, states.length - start));
      }
    }
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
}

function copyIntoShared(target, source) { target.set(source); }

export async function runPrecomputation({
  runDir, db, rulesHash, buildId = 'primary', workers = Math.max(1, os.availableParallelism() - 1),
  chunkSize = 4096, control, onProgress = () => {}, verificationBuild = false, writePolicy = true,
  rulesetId = 'swedish-alga-free-order-v1', scoringOptions = {}
}) {
  const stateIndex = createStateIndex();
  const buildDir = verificationBuild ? ensureDir(path.join(runDir, 'determinism-build')) : runDir;
  const partialValues = path.join(buildDir, 'values.bin.partial');
  const partialBounds = path.join(buildDir, 'bounds.bin.partial');
  const finalValues = path.join(buildDir, 'values.bin');
  const finalBounds = path.join(buildDir, 'bounds.bin');
  const manifestPath = path.join(buildDir, 'manifest.json');
  const partialPolicy = path.join(buildDir, 'policy.bin.partial');
  const finalPolicy = path.join(buildDir, 'policy.bin');
  prepareChunks(db, buildId, stateIndex, chunkSize);

  const stateMaskBuffer = new SharedArrayBuffer(stateIndex.stateMask.byteLength);
  const stateUpperBuffer = new SharedArrayBuffer(stateIndex.stateUpper.byteLength);
  copyIntoShared(new Uint16Array(stateMaskBuffer), stateIndex.stateMask);
  copyIntoShared(new Uint8Array(stateUpperBuffer), stateIndex.stateUpper);
  const valuesBuffer = new SharedArrayBuffer(stateIndex.totalStates * 8);
  const lowerBuffer = new SharedArrayBuffer(stateIndex.totalStates * 8);
  const upperBuffer = new SharedArrayBuffer(stateIndex.totalStates * 8);
  const values = new Float64Array(valuesBuffer);
  const lower = new Float64Array(lowerBuffer);
  const upper = new Float64Array(upperBuffer);

  let files;
  if (fs.existsSync(partialValues) && fs.existsSync(partialBounds)) {
    files = openValueFiles(partialValues, partialBounds);
    const loaded = readTables(partialValues, partialBounds, stateIndex.totalStates);
    values.set(loaded.values); lower.set(loaded.lower); upper.set(loaded.upper);
  } else if (fs.existsSync(finalValues) && fs.existsSync(finalBounds) && (!writePolicy || fs.existsSync(finalPolicy))) {
    const hashes = await artifactHashes(finalValues, finalBounds);
    const manifest = fs.existsSync(manifestPath) ? JSON.parse(fs.readFileSync(manifestPath,'utf8')) : null;
    return { valuesPath: finalValues, boundsPath: finalBounds, policyPath: writePolicy?finalPolicy:null, manifestPath, hashes, manifest, stateIndex, resumedComplete: true };
  } else {
    files = createValueFiles(partialValues, partialBounds, stateIndex.totalStates, rulesHash);
  }

  let policyFd = null;
  if (writePolicy) {
    if (fs.existsSync(partialPolicy)) policyFd = openPolicyFile(partialPolicy);
    else if (!fs.existsSync(finalPolicy)) policyFd = createPolicyFile(partialPolicy, stateIndex.totalStates, rulesHash);
  }
  const pool = new WorkerPool(workers, { stateMaskBuffer, stateUpperBuffer, valuesBuffer, lowerBuffer, upperBuffer, writePolicy, scoringOptions });
  const totalStates = stateIndex.totalStates;
  let completedStates = Number(db.prepare(`SELECT COALESCE(SUM(state_count),0) n FROM chunks WHERE build_id=? AND status='COMPLETE'`).get(buildId).n);
  const started = Date.now();
  const recent = [];
  addEvent(db, 'info', 'PRECOMPUTE_STARTED', `${buildId} precomputation started`, { workers, chunkSize, totalStates });

  try {
    for (let layer = 15; layer >= 0; layer -= 1) {
      const states = stateIndex.layers[layer];
      const rows = db.prepare(`SELECT ordinal,start_pos,state_count,status FROM chunks WHERE build_id=? AND layer=? ORDER BY ordinal`).all(buildId, layer);
      const pending = rows.filter(r => r.status !== 'COMPLETE');
      if (!pending.length) continue;
      if (buildId === 'primary') db.prepare(`UPDATE layers SET status='RUNNING' WHERE layer=?`).run(layer);
      const active = new Set();
      let cursor = 0;

      const launch = row => {
        const slice = Uint32Array.from(states.subarray(row.start_pos, row.start_pos + row.state_count));
        const taskId = `${buildId}:${layer}:${row.ordinal}`;
        db.prepare(`UPDATE chunks SET status='RUNNING' WHERE build_id=? AND layer=? AND ordinal=?`).run(buildId, layer, row.ordinal);
        const promise = pool.run({ type: 'compute', taskId, indicesBuffer: slice.buffer }).then(result => ({ row, result, promise })).catch(error => { throw Object.assign(error, { row }); });
        active.add(promise);
      };

      while (cursor < pending.length || active.size) {
        if (control?.stopRequested) throw new Error('Pipeline stopped by user');
        while (!control?.pauseRequested && cursor < pending.length && active.size < workers) launch(pending[cursor++]);
        if (!active.size && control?.pauseRequested) {
          fs.fsyncSync(files.valueFd); fs.fsyncSync(files.boundsFd); checkpointDb(db);
          await control.waitUntilResumed();
          continue;
        }
        if (!active.size) continue;
        const settled = await Promise.race(active);
        active.delete(settled.promise);
        const { row, result } = settled;
        const indices = new Uint32Array(result.indicesBuffer);
        const chunkValues = new Float64Array(result.valuesBuffer);
        const chunkLower = new Float64Array(result.lowerBuffer);
        const chunkUpper = new Float64Array(result.upperBuffer);
        const chunkPolicy = result.policyBuffer ? new Uint8Array(result.policyBuffer) : null;
        for (let i = 0; i < indices.length; i += 1) {
          values[indices[i]] = chunkValues[i]; lower[indices[i]] = chunkLower[i]; upper[indices[i]] = chunkUpper[i];
        }
        writeChunkFiles(files.valueFd, files.boundsFd, indices, chunkValues, chunkLower, chunkUpper);
        if (policyFd !== null && chunkPolicy) writePolicyChunk(policyFd, indices, chunkPolicy);
        fs.fsyncSync(files.valueFd); fs.fsyncSync(files.boundsFd); if (policyFd !== null) fs.fsyncSync(policyFd);
        const checksum = chunkHash(indices, chunkValues, chunkLower, chunkUpper);
        const now = new Date().toISOString();
        db.exec('BEGIN IMMEDIATE');
        try {
          db.prepare(`UPDATE chunks SET status='COMPLETE',checksum=?,duration_ms=?,aggregate_json=?,completed_at=? WHERE build_id=? AND layer=? AND ordinal=?`)
            .run(checksum, Math.round(result.durationMs), JSON.stringify(result.aggregate), now, buildId, layer, row.ordinal);
          if (buildId === 'primary') db.prepare(`UPDATE layers SET completed_states=completed_states+?,completed_chunks=completed_chunks+1 WHERE layer=?`).run(row.state_count, layer);
          db.exec('COMMIT');
        } catch (error) { db.exec('ROLLBACK'); throw error; }
        completedStates += row.state_count;
        recent.push({ states: row.state_count, ms: result.durationMs });
        if (recent.length > 30) recent.shift();
        const rate = recent.reduce((s, x) => s + x.states, 0) / Math.max(0.001, recent.reduce((s, x) => s + x.ms, 0) / 1000);
        onProgress({ buildId, layer, completedStates, totalStates, progress: completedStates / totalStates, rate, etaSeconds: rate ? (totalStates - completedStates) / rate : null, activeWorkers: active.size });
      }
      if (buildId === 'primary') db.prepare(`UPDATE layers SET status='COMPLETE' WHERE layer=?`).run(layer);
      checkpointDb(db);
    }
  } finally {
    await pool.close();
    fs.fsyncSync(files.valueFd); fs.fsyncSync(files.boundsFd);
    fs.closeSync(files.valueFd); fs.closeSync(files.boundsFd); if (policyFd !== null) fs.closeSync(policyFd);
  }

  safeUnlink(finalValues); safeUnlink(finalBounds);
  fs.renameSync(partialValues, finalValues);
  fs.renameSync(partialBounds, finalBounds);
  if (writePolicy && fs.existsSync(partialPolicy)) { safeUnlink(finalPolicy); fs.renameSync(partialPolicy, finalPolicy); }
  const hashes = await artifactHashes(finalValues, finalBounds);
  const policySha256 = writePolicy && fs.existsSync(finalPolicy) ? await policyHash(finalPolicy) : null;
  let aggregate = null;
  const aggregateRows = db.prepare(`SELECT aggregate_json FROM chunks WHERE build_id=? AND status='COMPLETE' AND aggregate_json IS NOT NULL ORDER BY layer DESC,ordinal`).all(buildId);
  for (const row of aggregateRows) aggregate = mergeAgg(aggregate, JSON.parse(row.aggregate_json));
  if (aggregate) writeJsonAtomic(path.join(buildDir, 'precomputation_metrics.json'), aggregate);
  const startIndex = stateIndex.indexOf(0, 0);
  const manifest = {
    formatVersion: 2,
    buildId,
    verificationBuild,
    rulesetId, rulesHash,
    stateCount: stateIndex.totalStates, upperMaskTotalPairs: stateIndex.upperPairCount,
    startingExpectedValue: values[startIndex], startingLowerBound: lower[startIndex], startingUpperBound: upper[startIndex],
    valuesSha256: hashes.valuesSha256, boundsSha256: hashes.boundsSha256, policySha256,
    workers, chunkSize, durationMs: Date.now() - started,
    runtime: { node: process.version, platform: process.platform, arch: process.arch, cpu: os.cpus()[0]?.model, logicalCores: os.cpus().length },
    completedAt: new Date().toISOString()
  };
  writeJsonAtomic(manifestPath, manifest);
  setMeta(db, `${buildId}.manifest`, manifest);
  addEvent(db, 'info', 'PRECOMPUTE_COMPLETE', `${buildId} precomputation completed`, manifest);
  checkpointDb(db);
  return { valuesPath: finalValues, boundsPath: finalBounds, policyPath: writePolicy?finalPolicy:null, manifestPath, hashes, manifest, stateIndex, aggregate };
}
