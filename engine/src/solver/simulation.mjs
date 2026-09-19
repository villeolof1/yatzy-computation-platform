import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Worker } from 'node:worker_threads';
import { createHash } from 'node:crypto';
import { ensureDir, safeUnlink, writeJsonAtomic } from '../util/fs.mjs';
import { addEvent, checkpointDb } from '../database.mjs';
import { seed64 } from './rng.mjs';
import { readPolicyShared } from './policy-format.mjs';
import { createStateLookup } from './state-index.mjs';

export const SIM_HEADER_SIZE = 64;
export const SIM_RECORD_SIZE = 48;
const SIM_MAGIC = 'YTZSIM02';

function makeHeader(gameCount, policyId, seed) {
  const b = Buffer.alloc(SIM_HEADER_SIZE);
  b.write(SIM_MAGIC, 0, 'ascii');
  b.writeUInt16LE(2, 8); b.writeUInt16LE(SIM_HEADER_SIZE, 10); b.writeUInt32LE(gameCount, 12); b.writeUInt16LE(SIM_RECORD_SIZE, 16);
  const policy = Buffer.from(policyId, 'utf8'); policy.copy(b, 20, 0, Math.min(20, policy.length));
  b.writeBigUInt64LE(seed, 40);
  return b;
}

function mergeAggregate(a, b) {
  if (!a) return structuredClone(b);
  for (const key of ['n','sum','sumSq','bonusCount','yatzyGameCount','earlyScoreDecisions','rerollDecisions','tieDecisions','actionScoreCount','actionRerollCount']) a[key] += b[key];
  a.min = Math.min(a.min, b.min); a.max = Math.max(a.max, b.max);
  for (const key of ['histogram','upperHistogram','categorySum','categorySumSq','categoryZero','categoryFillTurnSum','turnCumulativeSum','turnUpperSum','turnBonusCount','keeperCounts','marginHistogram']) {
    for (let i = 0; i < a[key].length; i += 1) a[key][i] += b[key][i];
  }
  for (let c = 0; c < 15; c += 1) for (let t = 0; t < 16; t += 1) a.categoryFillTurnHist[c][t] += b.categoryFillTurnHist[c][t];
  return a;
}

class SimPool {
  constructor(count, workerData) {
    this.idle = []; this.waiters = []; this.workers = [];
    for (let i = 0; i < count; i += 1) { const w = new Worker(new URL('./simulation-worker.mjs', import.meta.url), { workerData }); this.workers.push(w); this.idle.push(w); }
  }
  async acquire() { return this.idle.length ? this.idle.pop() : new Promise(r => this.waiters.push(r)); }
  release(w) { const r = this.waiters.shift(); if (r) r(w); else this.idle.push(w); }
  async run(task) {
    const w = await this.acquire();
    return new Promise((resolve, reject) => {
      const onMsg = m => { if (m.taskId !== task.taskId) return; cleanup(); this.release(w); resolve(m); };
      const onErr = e => { cleanup(); this.release(w); reject(e); };
      const cleanup = () => { w.off('message', onMsg); w.off('error', onErr); };
      w.on('message', onMsg); w.on('error', onErr); w.postMessage(task);
    });
  }
  async close() { await Promise.all(this.workers.map(w => w.terminate())); }
}

export function createSimulationPlan({ optimalRuns = 10, gamesPerRun = 1_000_000, comparisonGames = 1_000_000 }) {
  const runs = [];
  for (let i = 1; i <= optimalRuns; i += 1) {
    const ns = `yatzy-publication-v1-optimal-${String(i).padStart(2, '0')}`;
    runs.push({ id: `optimal_${String(i).padStart(2, '0')}`, policyId: 'optimal', runNumber: i, gameCount: gamesPerRun, seedNamespace: ns, seed: seed64(ns).toString() });
  }
  const commonNs = 'yatzy-publication-v1-policy-comparison';
  for (const policyId of ['one_turn','greedy','bonus_priority','fixed_priority','random']) {
    runs.push({ id: `comparison_${policyId}`, policyId, runNumber: 1, gameCount: comparisonGames, seedNamespace: commonNs, seed: seed64(commonNs).toString() });
  }
  return runs;
}

let cachedPolicy=null;
function sharedPolicy(policyPath){if(!cachedPolicy||cachedPolicy.path!==policyPath){const states=createStateLookup().totalStates;cachedPolicy={path:policyPath,buffer:readPolicyShared(policyPath,states)};}return cachedPolicy.buffer;}

export async function runSimulationPlan({ runDir, db, valuesPath, boundsPath, policyPath = path.join(runDir,'policy.bin'), plan, workers = Math.min(5, Math.max(1, os.availableParallelism() - 1)), batchSize = 50_000, control, onProgress = () => {}, scoringOptions = {} }) {
  const simDir = ensureDir(path.join(runDir, 'simulations'));
  const traceTmpDir = ensureDir(path.join(simDir, '.trace-batches'));
  const pool = new SimPool(workers, { policyBuffer: sharedPolicy(policyPath), oneTurnCacheSize: 50000, scoringOptions });
  let totalGames = plan.reduce((s, r) => s + r.gameCount, 0);
  let completedTotal = 0;
  for (const r of plan) {
    const existing = db.prepare(`SELECT completed_games FROM simulation_runs WHERE id=?`).get(r.id);
    if (existing) completedTotal += existing.completed_games;
  }
  const summaries = [];
  try {
    for (const run of plan) {
      const outputPath = path.join(simDir, `${run.id}.bin`);
      const tracePath = path.join(simDir, `${run.id}.traces.jsonl`);
      db.prepare(`INSERT OR IGNORE INTO simulation_runs(id,policy_id,run_number,game_count,seed,status,output_path) VALUES (?,?,?,?,?,'PENDING',?)`)
        .run(run.id, run.policyId, run.runNumber, run.gameCount, run.seed, outputPath);
      if (!fs.existsSync(outputPath)) {
        const fd = fs.openSync(outputPath, 'w+');
        fs.writeSync(fd, makeHeader(run.gameCount, run.policyId, BigInt(run.seed)), 0, SIM_HEADER_SIZE, 0);
        fs.ftruncateSync(fd, SIM_HEADER_SIZE + run.gameCount * SIM_RECORD_SIZE); fs.closeSync(fd);
      }
      const batchCount = Math.ceil(run.gameCount / batchSize);
      const insertBatch = db.prepare(`INSERT OR IGNORE INTO simulation_batches(simulation_id,ordinal,start_game,game_count,status) VALUES (?,?,?,?,'PENDING')`);
      db.exec('BEGIN IMMEDIATE');
      try {
        for (let ordinal = 0; ordinal < batchCount; ordinal += 1) insertBatch.run(run.id, ordinal, ordinal * batchSize, Math.min(batchSize, run.gameCount - ordinal * batchSize));
        db.exec('COMMIT');
      } catch (e) { db.exec('ROLLBACK'); throw e; }
      const rows = db.prepare(`SELECT ordinal,start_game,game_count,status FROM simulation_batches WHERE simulation_id=? ORDER BY ordinal`).all(run.id);
      const pending = rows.filter(x => x.status !== 'COMPLETE');
      if (!pending.length) {
        const summary = JSON.parse(db.prepare(`SELECT summary_json FROM simulation_runs WHERE id=?`).get(run.id).summary_json);
        summaries.push(summary); continue;
      }
      db.prepare(`UPDATE simulation_runs SET status='RUNNING',started_at=COALESCE(started_at,?) WHERE id=?`).run(new Date().toISOString(), run.id);
      addEvent(db, 'info', 'SIMULATION_STARTED', `${run.id} started`, run);
      const active = new Set(); let cursor = 0;
      const launch = row => {
        const taskId = `${run.id}:${row.ordinal}`;
        const tempTrace = path.join(traceTmpDir, `${run.id}_${String(row.ordinal).padStart(5,'0')}.jsonl`);
        db.prepare(`UPDATE simulation_batches SET status='RUNNING' WHERE simulation_id=? AND ordinal=?`).run(run.id, row.ordinal);
        const p = pool.run({
          type: 'simulate', taskId, simulationId: run.id, policyId: run.policyId, baseSeed: run.seed,
          startGame: row.start_game, gameCount: row.game_count, outputPath, headerSize: SIM_HEADER_SIZE,
          traceEvery: run.policyId === 'optimal' ? 1000 : 0, tracePath: tempTrace
        }).then(result => ({ row, result, promise: p }));
        active.add(p);
      };
      while (cursor < pending.length || active.size) {
        if (control?.stopRequested) throw new Error('Pipeline stopped by user');
        while (!control?.pauseRequested && cursor < pending.length && active.size < workers) launch(pending[cursor++]);
        if (!active.size && control?.pauseRequested) { checkpointDb(db); await control.waitUntilResumed(); continue; }
        if (!active.size) continue;
        const settled = await Promise.race(active); active.delete(settled.promise);
        const { row, result } = settled;
        db.exec('BEGIN IMMEDIATE');
        try {
          db.prepare(`UPDATE simulation_batches SET status='COMPLETE',checksum=?,duration_ms=?,aggregate_json=?,trace_path=? WHERE simulation_id=? AND ordinal=?`)
            .run(result.checksum, Math.round(result.durationMs), JSON.stringify(result.aggregate), result.tracePath, run.id, row.ordinal);
          db.prepare(`UPDATE simulation_runs SET completed_games=completed_games+? WHERE id=?`).run(row.game_count, run.id);
          db.exec('COMMIT');
        } catch (e) { db.exec('ROLLBACK'); throw e; }
        completedTotal += row.game_count;
        onProgress({ simulationId: run.id, policyId: run.policyId, runProgress: (row.start_game + row.game_count) / run.gameCount, completedGames: completedTotal, totalGames, progress: completedTotal / totalGames });
      }
      let agg = null;
      const aggRows = db.prepare(`SELECT aggregate_json,trace_path FROM simulation_batches WHERE simulation_id=? AND status='COMPLETE' ORDER BY ordinal`).all(run.id);
      safeUnlink(tracePath);
      const outTrace = fs.openSync(tracePath, 'a');
      for (const row of aggRows) {
        agg = mergeAggregate(agg, JSON.parse(row.aggregate_json));
        if (row.trace_path && fs.existsSync(row.trace_path)) { fs.writeSync(outTrace, fs.readFileSync(row.trace_path)); safeUnlink(row.trace_path); }
      }
      fs.fsyncSync(outTrace); fs.closeSync(outTrace);
      const mean = agg.sum / agg.n;
      const variance = agg.n > 1 ? (agg.sumSq - agg.sum * agg.sum / agg.n) / (agg.n - 1) : 0;
      const summary = { ...run, outputPath, tracePath, aggregate: agg, mean, sd: Math.sqrt(Math.max(0, variance)), completedAt: new Date().toISOString() };
      writeJsonAtomic(path.join(simDir, `${run.id}.summary.json`), summary);
      db.prepare(`UPDATE simulation_runs SET status='COMPLETE',completed_games=?,summary_json=?,completed_at=? WHERE id=?`)
        .run(run.gameCount, JSON.stringify(summary), summary.completedAt, run.id);
      summaries.push(summary);
      addEvent(db, 'info', 'SIMULATION_COMPLETE', `${run.id} completed`, { mean, sd: summary.sd, games: run.gameCount });
      checkpointDb(db);
    }
  } finally { await pool.close(); }
  writeJsonAtomic(path.join(simDir, 'seed_manifest.json'), plan);
  writeJsonAtomic(path.join(simDir, 'simulation_summaries.json'), summaries);
  return summaries;
}
