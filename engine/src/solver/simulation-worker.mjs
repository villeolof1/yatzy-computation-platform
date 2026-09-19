import { parentPort, workerData } from 'node:worker_threads';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createStateIndex } from './state-index.mjs';
import { buildScoreMatrix } from './scoring.mjs';
import { POLICY_STRIDE } from './policy-format.mjs';
import { gameSeed, XorShift128 } from './rng.mjs';
import { heuristicDecision } from './policies.mjs';
import { ensureDir } from '../util/fs.mjs';

export const RECORD_SIZE = 48;
const SCORE_HIST_SIZE = 375;
const MARGIN_EDGES = [0, 1e-12, 1e-8, 1e-6, 1e-4, 1e-3, 1e-2, 0.05, 0.1, 0.5, 1, 2, 5, 10, Infinity];

const stateIndex = createStateIndex();
const universe = (await import('./dice.mjs')).createDiceUniverse();
const scoreMatrix = buildScoreMatrix(universe.rolls, workerData.scoringOptions || {});
const optimalPolicy = new Uint8Array(workerData.policyBuffer);
const rollIdByCode=new Int16Array(6**6);rollIdByCode.fill(-1);for(let r=0;r<universe.rolls.length;r++){let code=0,pow=1;for(let f=0;f<6;f++){code+=universe.rolls[r][f]*pow;pow*=6;}rollIdByCode[code]=r;}

function transform(input, output){for(let r=0;r<252;r++)output[universe.rollKeeperIds[r]]=input[r];for(let size=4;size>=0;size--)for(let id=universe.sizeOffsets[size];id<universe.sizeOffsets[size+1];id++){const p=id*6;output[id]=(output[universe.children[p]]+output[universe.children[p+1]]+output[universe.children[p+2]]+output[universe.children[p+3]]+output[universe.children[p+4]]+output[universe.children[p+5]])/6;}}
class OneTurnCache{
 constructor(limit=50000){this.limit=limit;this.cache=new Map();this.score=new Float64Array(252);this.roll1=new Float64Array(252);this.h0=new Float64Array(462);this.h1=new Float64Array(462);this.cat=new Uint8Array(252);}
 get(mask,u){const key=mask*64+u;let out=this.cache.get(key);if(out){this.cache.delete(key);this.cache.set(key,out);return out;}out=this.build(mask,u);this.cache.set(key,out);if(this.cache.size>this.limit)this.cache.delete(this.cache.keys().next().value);return out;}
 build(mask,u){const out=new Uint8Array(POLICY_STRIDE);for(let r=0;r<252;r++){let best=-Infinity,cat=0,base=r*15;for(let c=0;c<15;c++){if(mask&(1<<c))continue;const immediate=scoreMatrix[base+c],nextU=c<6?Math.min(63,u+immediate):u,bonus=c<6&&u<63&&nextU===63?50:0,v=immediate+bonus;if(v>best){best=v;cat=c;}}this.score[r]=best;this.cat[r]=cat;out[r]=cat;}transform(this.score,this.h0);for(let r=0;r<252;r++){let best=this.score[r],code=this.cat[r],begin=universe.legalOffsets[r];for(let p=begin;p<universe.legalOffsets[r+1];p++){const v=this.h0[universe.legalKeepers[p]];if(v>best){best=v;code=16+p-begin;}}this.roll1[r]=best;out[252+r]=code;}transform(this.roll1,this.h1);for(let r=0;r<252;r++){let best=this.score[r],code=this.cat[r],begin=universe.legalOffsets[r];for(let p=begin;p<universe.legalOffsets[r+1];p++){const v=this.h1[universe.legalKeepers[p]];if(v>best){best=v;code=16+p-begin;}}out[504+r]=code;}return out;}
}
const oneTurnCache=new OneTurnCache(workerData.oneTurnCacheSize??50000);
function decodePolicy(buffer,mask,u,rollId,rerolls){const idx=stateIndex.indexOf(mask,u),code=buffer[idx*POLICY_STRIDE+rerolls*252+rollId];if(code<16)return{type:'score',category:code,margin:NaN};const local=code-16,begin=universe.legalOffsets[rollId],keeperId=universe.legalKeepers[begin+local];return{type:'reroll',keeperId,margin:NaN};}

function marginBin(x) {
  if (!Number.isFinite(x)) return -1;
  for (let i = 0; i < MARGIN_EDGES.length - 1; i += 1) if (x >= MARGIN_EDGES[i] && x < MARGIN_EDGES[i + 1]) return i;
  return MARGIN_EDGES.length - 2;
}
function encodeCounts(counts) { return Array.from(counts).join(''); }
function rollFresh(rng, n, base = null) {
  const counts = base ? Uint8Array.from(base) : new Uint8Array(6);
  for (let i = 0; i < n; i += 1) counts[rng.int(6)] += 1;
  return counts;
}
function maxCount(counts) { let m = 0; for (const n of counts) if (n > m) m = n; return m; }

function emptyAggregate() {
  return {
    n: 0, sum: 0, sumSq: 0, min: Infinity, max: -Infinity,
    histogram: Array(SCORE_HIST_SIZE).fill(0), bonusCount: 0, yatzyGameCount: 0,
    upperHistogram: Array(106).fill(0),
    categorySum: Array(15).fill(0), categorySumSq: Array(15).fill(0), categoryZero: Array(15).fill(0),
    categoryFillTurnSum: Array(15).fill(0), categoryFillTurnHist: Array.from({ length: 15 }, () => Array(16).fill(0)),
    turnCumulativeSum: Array(15).fill(0), turnUpperSum: Array(15).fill(0), turnBonusCount: Array(15).fill(0),
    earlyScoreDecisions: 0, rerollDecisions: 0, keeperCounts: Array(5).fill(0), tieDecisions: 0,
    marginHistogram: Array(MARGIN_EDGES.length - 1).fill(0),
    actionScoreCount: 0, actionRerollCount: 0
  };
}

function countsToDice(counts){const out=[];for(let f=0;f<6;f++)for(let i=0;i<counts[f];i++)out.push(f+1);return out;}
function traceDecision(turn, mask, upper, counts, rerolls, decision, rollId) {
  return {
    turn, mask, upper, dice: countsToDice(counts), rerollsRemaining: rerolls,
    rollId, action: decision.type === 'reroll'
      ? { type: 'reroll', keeper: Array.from(universe.keepers[decision.keeperId]) }
      : { type: 'score', category: decision.category, immediate: decision.immediate, bonus: decision.bonus ?? 0 },
    margin: Number.isFinite(decision.margin) ? decision.margin : null
  };
}

function simulateGame(policyId, baseSeed, gameIndex, captureTrace = false) {
  const [a, b] = gameSeed(baseSeed, gameIndex);
  const rng = new XorShift128(a, b);
  let mask = 0, upper = 0, upperRaw = 0, total = 0, bonus = false, yatzyRolls = 0;
  const categoryScores = new Uint8Array(15);
  const fillTurns = new Uint8Array(15);
  const keeperCounts = new Uint8Array(5);
  let earlyScoreDecisions = 0, rerollDecisions = 0, tieDecisions = 0, minMargin = Infinity;
  const trace = captureTrace ? [] : null;
  const turnCumulative = new Uint16Array(15), turnUpper = new Uint8Array(15), turnBonus = new Uint8Array(15);
  const marginHist = new Uint32Array(MARGIN_EDGES.length - 1);
  let scoreActions = 0, rerollActions = 0;

  for (let turn = 1; turn <= 15; turn += 1) {
    let counts = rollFresh(rng, 5);
    let rerolls = 2;
    while (true) {
      let codeCounts=0,pow=1;for(let f=0;f<6;f++){codeCounts+=counts[f]*pow;pow*=6;}const rollId=rollIdByCode[codeCounts];
      if (maxCount(counts) === 5) yatzyRolls += 1;
      const row = new Uint8Array(15);
      for (let c = 0; c < 15; c += 1) row[c] = scoreMatrix[rollId * 15 + c];
      let decision;
      if (policyId === 'optimal') decision = decodePolicy(optimalPolicy,mask,upper,rollId,rerolls);
      else if (policyId === 'one_turn') {const localPolicy=oneTurnCache.get(mask,upper),code=localPolicy[rerolls*252+rollId];if(code<16)decision={type:'score',category:code,margin:NaN};else{const begin=universe.legalOffsets[rollId];decision={type:'reroll',keeperId:universe.legalKeepers[begin+code-16],margin:NaN};}}
      else decision = heuristicDecision(policyId, { mask, upper, counts, rerolls, rng, universe, rollId, categoryScores: row });
      if (decision.type === 'reroll_counts') {
        const keeperId = universe.keeperIdByKey.get(encodeCounts(decision.keep));
        decision = { type: 'reroll', keeperId, margin: decision.margin };
      }
      if (Number.isFinite(decision.margin)) {
        minMargin = Math.min(minMargin, decision.margin);
        if (decision.margin <= 1e-12) tieDecisions += 1;
        const mb = marginBin(decision.margin); if (mb >= 0) marginHist[mb] += 1;
      }
      if (captureTrace) trace.push(traceDecision(turn, mask, upper, counts, rerolls, decision, rollId));
      if (decision.type === 'reroll' && rerolls > 0) {
        rerollActions += 1; rerollDecisions += 1;
        const keep = universe.keepers[decision.keeperId];
        const size = universe.keeperSizes[decision.keeperId];
        keeperCounts[size] += 1;
        counts = rollFresh(rng, 5 - size, keep);
        rerolls -= 1;
        continue;
      }
      scoreActions += 1;
      const c = decision.category;
      const immediate = row[c];
      categoryScores[c] = immediate;
      fillTurns[c] = turn;
      total += immediate;
      if (c < 6) {
        upperRaw += immediate;
        const previous = upper;
        upper = Math.min(63, upper + immediate);
        if (!bonus && previous < 63 && upper === 63) { bonus = true; total += 50; }
      }
      if (rerolls > 0) earlyScoreDecisions += 1;
      mask |= 1 << c;
      break;
    }
    turnCumulative[turn - 1] = total;
    turnUpper[turn - 1] = Math.min(105, upperRaw);
    turnBonus[turn - 1] = bonus ? 1 : 0;
  }

  return {
    finalScore: total, upperTotal: upperRaw, bonus, yatzyRolls,
    yatzyCategoryScore: categoryScores[14], earlyScoreDecisions, rerollDecisions,
    keeperCounts, tieDecisions, minMargin: Number.isFinite(minMargin) ? minMargin : NaN,
    categoryScores, fillTurns, trace, turnCumulative, turnUpper, turnBonus,
    marginHist, scoreActions, rerollActions
  };
}

function writeRecord(buffer, offset, game) {
  buffer.writeUInt16LE(game.finalScore, offset);
  buffer.writeUInt8(Math.min(255, game.upperTotal), offset + 2);
  buffer.writeUInt8(game.bonus ? 1 : 0, offset + 3);
  buffer.writeUInt8(Math.min(255, game.yatzyRolls), offset + 4);
  buffer.writeUInt8(game.yatzyCategoryScore, offset + 5);
  buffer.writeUInt8(Math.min(255, game.earlyScoreDecisions), offset + 6);
  buffer.writeUInt8(Math.min(255, game.rerollDecisions), offset + 7);
  for (let i = 0; i < 5; i += 1) buffer.writeUInt8(Math.min(255, game.keeperCounts[i]), offset + 8 + i);
  buffer.writeUInt8(Math.min(255, game.tieDecisions), offset + 13);
  // Fast archived-policy simulations do not reconstruct action values. Zero is
  // an explicit unavailable sentinel documented by the v3 binary schema; the
  // scientific margin population is generated separately by visit-analysis.
  buffer.writeFloatLE(Number.isFinite(game.minMargin) ? game.minMargin : 0, offset + 14);
  for (let i = 0; i < 15; i += 1) buffer.writeUInt8(game.categoryScores[i], offset + 18 + i);
  for (let i = 0; i < 15; i += 1) buffer.writeUInt8(game.fillTurns[i], offset + 33 + i);
}

function addToAggregate(agg, game) {
  const s = game.finalScore;
  agg.n += 1; agg.sum += s; agg.sumSq += s * s; agg.min = Math.min(agg.min, s); agg.max = Math.max(agg.max, s);
  if (s >= 0 && s < agg.histogram.length) agg.histogram[s] += 1;
  if (game.bonus) agg.bonusCount += 1;
  if (game.yatzyRolls > 0) agg.yatzyGameCount += 1;
  if (game.upperTotal < agg.upperHistogram.length) agg.upperHistogram[game.upperTotal] += 1;
  for (let c = 0; c < 15; c += 1) {
    const x = game.categoryScores[c];
    agg.categorySum[c] += x; agg.categorySumSq[c] += x * x; if (x === 0) agg.categoryZero[c] += 1;
    agg.categoryFillTurnSum[c] += game.fillTurns[c]; agg.categoryFillTurnHist[c][game.fillTurns[c]] += 1;
  }
  for (let t = 0; t < 15; t += 1) {
    agg.turnCumulativeSum[t] += game.turnCumulative[t]; agg.turnUpperSum[t] += game.turnUpper[t]; agg.turnBonusCount[t] += game.turnBonus[t];
  }
  agg.earlyScoreDecisions += game.earlyScoreDecisions; agg.rerollDecisions += game.rerollDecisions; agg.tieDecisions += game.tieDecisions;
  for (let i = 0; i < 5; i += 1) agg.keeperCounts[i] += game.keeperCounts[i];
  for (let i = 0; i < agg.marginHistogram.length; i += 1) agg.marginHistogram[i] += game.marginHist[i];
  agg.actionScoreCount += game.scoreActions; agg.actionRerollCount += game.rerollActions;
}

parentPort.on('message', message => {
  if (message.type !== 'simulate') return;
  const started = performance.now();
  const baseSeed = BigInt(message.baseSeed);
  const records = Buffer.allocUnsafe(message.gameCount * RECORD_SIZE);
  const agg = emptyAggregate();
  const traceLines = [];
  for (let i = 0; i < message.gameCount; i += 1) {
    const gameIndex = message.startGame + i;
    const capture = message.traceEvery > 0 && gameIndex % message.traceEvery === 0;
    const game = simulateGame(message.policyId, baseSeed, gameIndex, capture);
    writeRecord(records, i * RECORD_SIZE, game);
    addToAggregate(agg, game);
    if (capture) traceLines.push(JSON.stringify({ simulationId: message.simulationId, policyId: message.policyId, gameIndex, finalScore: game.finalScore, trace: game.trace }));
  }
  ensureDir(path.dirname(message.outputPath));
  const fd = fs.openSync(message.outputPath, 'r+');
  fs.writeSync(fd, records, 0, records.length, message.headerSize + message.startGame * RECORD_SIZE);
  fs.fsyncSync(fd); fs.closeSync(fd);
  let tracePath = null;
  if (traceLines.length) {
    tracePath = message.tracePath;
    fs.writeFileSync(tracePath, `${traceLines.join('\n')}\n`);
    const tfd = fs.openSync(tracePath, 'r+'); fs.fsyncSync(tfd); fs.closeSync(tfd);
  }
  const checksum = createHash('sha256').update(records).digest('hex');
  parentPort.postMessage({ type: 'simulation-result', taskId: message.taskId, aggregate: agg, checksum, tracePath, durationMs: performance.now() - started });
});
