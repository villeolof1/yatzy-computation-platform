import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openRunDatabase } from '../database.mjs';
import { runPrecomputation } from '../solver/precompute.mjs';
import { runSimulationPlan } from '../solver/simulation.mjs';
import { verifyRun } from '../solver/verify.mjs';
import { readTables } from '../solver/table-format.mjs';
import { createStateIndex } from '../solver/state-index.mjs';
import { runAnalysis } from '../analysis/analyze.mjs';
import { stableJson, sha256Text, sha256File } from '../util/hash.mjs';
import { runControlledProcess } from '../util/child-process.mjs';
import { ensureOwnedDir, writeJsonAtomicOwned, writeTextAtomicOwned, copyFileAtomicOwned, removeOwnedPath } from '../util/fs.mjs';
import { seed64 } from '../solver/rng.mjs';
import { CANONICAL, HISTORICAL, assertCanonicalIdentity } from './identity.mjs';
import { assertOwnedPath, claimOutputRoot, relativePosix, resolveOwnedPath } from './paths.mjs';
import { ActionValueEvaluator } from './action-values.mjs';
import { auditPolicy } from './policy-audit.mjs';
import { runVisitAnalysis } from './visit-analysis.mjs';
import { runStructuralAtlas } from './structural-atlas.mjs';
import { upperPointEstimands, optionCostsFromVisitSample } from './estimands.mjs';
import { runPairedComparisons } from './paired-comparison.mjs';
import { writeSchemas } from './schemas.mjs';
import { writeCorrectedFigures } from './corrected-figures.mjs';
import { artifactInventory, completeExperiment, writeExperimentManifest } from './experiment-manifest.mjs';
import { assertScientificValue, assertHistogram, auditInventory } from './quality-gates.mjs';
import { createZip, auditZip, buildPaperStaging, cleanRoomTest } from './archive.mjs';
import { createSourceSnapshotPlan, materializeResearchSources, materializeSourceSnapshot } from './source-snapshot.mjs';
import { writeFinalProvenance } from './provenance.mjs';
import { auditRunFormats } from './format-audit.mjs';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
export async function runGit(args, runner = runControlledProcess) {
  const result = await runner('git', args, {
    cwd: projectRoot,
    timeoutMs: 30_000,
    maxOutputBytes: 1024 * 1024,
    encoding: 'utf8'
  });
  return result.stdout.trim();
}
function runId(mode) { const t = new Date().toISOString().replace(/[-:.TZ]/g, ''); return `${mode === 'official' ? 'official' : 'reduced-noncanonical'}_${t}_${process.pid}`; }
function output(pathValue, base = 'run-directory') { return { path: pathValue, base }; }
function policyIdentity(manifest) { return { rulesHash: manifest.rulesHash, valuesHash: manifest.valuesSha256, boundsHash: manifest.boundsSha256, policyHash: manifest.policySha256 }; }
async function writeIdentity(ownership, file, manifest, audits) { const value = { ...manifest, audits }; assertScientificValue(value); writeJsonAtomicOwned(ownership, file, value, { replaceExisting: false }); return value; }
function simulationAgreement(summary, exact) { const n = summary.aggregate.n, mean = summary.mean, se = summary.sd / Math.sqrt(n), z = (mean - exact) / se; if (!(Math.abs(z) <= 3)) throw new Error(`Pilot disagrees with canonical value: z=${z}`); return { n, mean, se, z, passed: true }; }

export function claimToEvidenceRegister() {
  return {
    canonicalValue: ['canonical_identity.json'],
    policyReproducibility: ['canonical_identity.json', 'canonical/primary/policy.bin', 'canonical/rebuild/policy.bin'],
    decisionValues: ['decision/visit_aggregates.json', 'structural/structural_decision_atlas.json'],
    upperEstimands: ['estimands/upper_point_aggregates.json'],
    pairedComparisons: ['paired/paired_policy_comparisons.json'],
    historicalCompatibility: [
      'historical_identity.json',
      'research/sources/SOURCE_METADATA.json',
      'research/sources/optimalt-yatzy-source'
    ]
  };
}

export function prepareV3SourceStage({ ownership, runDir, sourcePlan } = {}) {
  const snapshot = assertOwnedPath(ownership, path.join(runDir, 'source_snapshot'), { mustExist: false });
  const paths = {
    snapshot,
    snapshotManifest: path.join(runDir, 'source_snapshot_manifest.json'),
    researchRoot: path.join(runDir, 'research'),
    research: path.join(runDir, 'research', 'sources'),
    researchManifest: path.join(runDir, 'research', 'source_snapshot_manifest.json'),
    packageLock: path.join(runDir, 'package-lock.json'),
    package: path.join(runDir, 'package.json'),
    reuseLedger: path.join(runDir, 'reuse_ledger.json')
  };
  try {
    const snapshotResult = materializeSourceSnapshot({ plan: sourcePlan, ownership, destination: paths.snapshot, manifestPath: paths.snapshotManifest, purpose: 'official-v3-source-snapshot' });
    const researchResult = materializeResearchSources({ plan: sourcePlan, ownership, destination: paths.research, manifestPath: paths.researchManifest, purpose: 'research-source-staging' });
    copyFileAtomicOwned(ownership, path.join(snapshot, 'package-lock.json'), paths.packageLock, { replaceExisting: false });
    copyFileAtomicOwned(ownership, path.join(snapshot, 'package.json'), paths.package, { replaceExisting: false });
    writeJsonAtomicOwned(ownership, paths.reuseLedger, {
      canonicalReuse: 'none: official and reduced model artifacts are freshly recomputed',
      auditedPriorIdentities: CANONICAL,
      hashVerificationRequired: true
    }, { replaceExisting: false });
    return { snapshot: snapshotResult, research: researchResult };
  } catch (error) {
    for (const file of [paths.reuseLedger, paths.package, paths.packageLock, paths.researchManifest, paths.snapshotManifest]) {
      if (fs.existsSync(file)) removeOwnedPath(ownership, file, { allowMissing: true, type: 'file' });
    }
    for (const directory of [paths.research, paths.researchRoot, paths.snapshot]) {
      if (fs.existsSync(directory)) removeOwnedPath(ownership, directory, { recursive: true, allowMissing: true, type: 'directory' });
    }
    throw error;
  }
}

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const nested of Object.values(value)) deepFreeze(nested);
    Object.freeze(value);
  }
  return value;
}

function configurationError(message) {
  const error = new Error(message);
  error.code = 'YATZY_CONFIG_INVALID';
  return error;
}

export const REGISTERED_FULL_PROFILE = deepFreeze({
  schemaVersion: 1,
  profileId: 'registered-full-v3',
  kind: 'registered-full-research',
  mode: 'official',
  identity: {
    canonicalRulesetId: 'swedish-alga-free-order-v1',
    canonicalRulesSha256: 'd122c68b140b42a4509c8fc3f2252661b8bf51a791d630996706458b05825018',
    historicalCompatibleRulesetId: 'kth-2012-implementation-compatible-v1',
    historicalTwoPairSinglePairFallback: true
  },
  runtimeTunables: {
    precomputationWorkers: {
      environmentVariable: 'YATZY_WORKERS',
      default: 8,
      minimum: 1,
      maximum: 12
    },
    simulationWorkers: {
      environmentVariable: 'YATZY_SIM_WORKERS',
      default: 5,
      minimum: 1,
      maximum: 8
    },
    deterministicRebuildWorkers: 'max(1, precomputationWorkers - 1)'
  },
  fixedConfiguration: {
    precomputation: {
      canonicalPrimary: true,
      canonicalDeterministicRebuild: true,
      historicalCompatiblePrimary: true,
      historicalCompatibleDeterministicRebuild: true,
      primaryChunkSize: 4096,
      deterministicRebuildChunkSize: 3072,
      writePolicy: true
    },
    simulations: {
      pilotGames: 50_000,
      independentOptimalRuns: 10,
      gamesPerOptimalRun: 1_000_000,
      totalIndependentOptimalGames: 10_000_000,
      historicalCompatibleGames: 100_000,
      pairedComparisonGames: 500,
      visitWeightedGames: 200,
      structuralAtlasStatesPerLayer: 32
    },
    stages: {
      finalModelAndSimulationVerification: true,
      analysisAndCorrectedFigures: true,
      schemasAndEvidenceRegisters: true,
      formatAndSchemaAudit: true,
      stagingArchives: true,
      cleanRoomReproduction: true,
      finalArchives: true,
      finalProvenance: true
    }
  },
  safety: {
    explicitSafeOutputRootRequired: true,
    fullResourceAcknowledgementRequired: true,
    acknowledgementImplementationStatus: 'deferred-to-phase-9c3',
    defaultRouteStatus: 'not-authorized-as-default',
    intendedFutureDefault: 'public-smoke-v1',
    routingChangedInPhase9c1c: false
  }
});

export const REGISTERED_FULL_PROFILE_SHA256 = sha256Text(stableJson(REGISTERED_FULL_PROFILE));

export const REDUCED_DEVELOPMENT_PROFILE = deepFreeze({
  schemaVersion: 1,
  profileId: 'reduced-development-v3',
  kind: 'reduced-development',
  mode: 'reduced',
  runtimeTunables: {
    precomputationWorkers: {
      environmentVariable: 'YATZY_WORKERS',
      default: 4,
      minimum: 1,
      maximum: 6
    }
  },
  fixedConfiguration: {
    simulationWorkers: 2,
    pilotGames: 2_000,
    independentOptimalRuns: 2,
    gamesPerOptimalRun: 3_000,
    historicalCompatibleGames: 2_000,
    pairedComparisonGames: 20,
    visitWeightedGames: 10,
    structuralAtlasStatesPerLayer: 2
  }
});

export const REDUCED_DEVELOPMENT_PROFILE_SHA256 = sha256Text(stableJson(REDUCED_DEVELOPMENT_PROFILE));

function parseBoundedEnvironmentInteger(environment, definition) {
  const name = definition.environmentVariable;
  const descriptor = Object.getOwnPropertyDescriptor(environment, name);
  if (descriptor === undefined) return definition.default;
  const raw = Object.hasOwn(descriptor, 'value') ? descriptor.value : undefined;
  if (typeof raw !== 'string' || !/^[1-9][0-9]*$/.test(raw)) throw configurationError(`Invalid ${name}: expected a canonical base-10 positive-integer string.`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < definition.minimum || value > definition.maximum) throw configurationError(`Invalid ${name}: expected an integer from ${definition.minimum} through ${definition.maximum}.`);
  return value;
}

export function deterministicRebuildWorkers(precomputationWorkers) {
  if (!Number.isSafeInteger(precomputationWorkers) || precomputationWorkers < 1 || precomputationWorkers > 12) throw configurationError('Invalid precomputationWorkers: expected an integer from 1 through 12.');
  return Math.max(1, precomputationWorkers - 1);
}

export function resolveV3Configuration(options = {}) {
  if (options === null || typeof options !== 'object' || Array.isArray(options) || Object.getPrototypeOf(options) !== Object.prototype) throw configurationError('Invalid V3 configuration resolver options: expected a plain object.');
  const descriptors = Object.getOwnPropertyDescriptors(options);
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key !== 'string' || !['mode', 'environment'].includes(key) || !descriptors[key].enumerable || !Object.hasOwn(descriptors[key], 'value')) throw configurationError(`Invalid configuration option "${typeof key === 'string' ? key : 'symbol'}": only mode and environment are accepted.`);
  }
  const mode = descriptors.mode?.value ?? 'reduced';
  const environment = descriptors.environment?.value ?? process.env;
  if (!['reduced', 'official'].includes(mode)) throw configurationError('Invalid mode: expected reduced or official.');
  if (environment === null || typeof environment !== 'object' || Array.isArray(environment)) throw configurationError('Invalid environment: expected an object.');
  if (mode === 'official') {
    const simulations = REGISTERED_FULL_PROFILE.fixedConfiguration.simulations;
    return {
      workers: parseBoundedEnvironmentInteger(environment, REGISTERED_FULL_PROFILE.runtimeTunables.precomputationWorkers),
      simWorkers: parseBoundedEnvironmentInteger(environment, REGISTERED_FULL_PROFILE.runtimeTunables.simulationWorkers),
      pilot: simulations.pilotGames,
      runs: simulations.independentOptimalRuns,
      games: simulations.gamesPerOptimalRun,
      historicalGames: simulations.historicalCompatibleGames,
      paired: simulations.pairedComparisonGames,
      visits: simulations.visitWeightedGames,
      atlas: simulations.structuralAtlasStatesPerLayer
    };
  }
  const fixed = REDUCED_DEVELOPMENT_PROFILE.fixedConfiguration;
  return {
    workers: parseBoundedEnvironmentInteger(environment, REDUCED_DEVELOPMENT_PROFILE.runtimeTunables.precomputationWorkers),
    simWorkers: fixed.simulationWorkers,
    pilot: fixed.pilotGames,
    runs: fixed.independentOptimalRuns,
    games: fixed.gamesPerOptimalRun,
    historicalGames: fixed.historicalCompatibleGames,
    paired: fixed.pairedComparisonGames,
    visits: fixed.visitWeightedGames,
    atlas: fixed.structuralAtlasStatesPerLayer
  };
}

export async function runV3Pipeline({ mode = 'reduced', outputRoot, protectedRoots = [], acknowledgeFullResearch = false } = {}) {
  if (!['reduced', 'official'].includes(mode)) throw new Error('Mode must be reduced or official');
  if (mode === 'official' && acknowledgeFullResearch !== true) {
    const error = new Error('Registered full research requires explicit acknowledgement before configuration, filesystem, or computation work.');
    error.code = 'YATZY_FULL_RESEARCH_ACK_REQUIRED';
    throw error;
  }
  const config = resolveV3Configuration({ mode, environment: process.env });
  const profile = mode === 'official' ? REGISTERED_FULL_PROFILE : REDUCED_DEVELOPMENT_PROFILE;
  const profileDefinitionSha256 = mode === 'official' ? REGISTERED_FULL_PROFILE_SHA256 : REDUCED_DEVELOPMENT_PROFILE_SHA256;
  const deterministicWorkers = deterministicRebuildWorkers(config.workers);
  const ownership = claimOutputRoot(outputRoot, { protectedRoots: [path.dirname(projectRoot), ...protectedRoots], forbiddenTrees: [projectRoot] });
  const sourceCommit = await runGit(['rev-parse', 'HEAD']); if (mode === 'official' && await runGit(['status', '--porcelain'])) throw new Error('Official run requires a clean frozen Git tree');
  const sourcePlan = createSourceSnapshotPlan({ repositoryRoot: projectRoot, sourceCommit });
  const id = runId(mode), root = ownership.root, runDir = resolveOwnedPath(ownership, id, { mustExist: false }), ownedDir = (dir, options) => ensureOwnedDir(ownership, dir, options); ownedDir(runDir, { mustBeNew: true });
  if (mode !== 'official') writeTextAtomicOwned(ownership, path.join(runDir, 'NONCANONICAL_REDUCED_RUN.txt'), 'Development validation only. This run is not canonical evidence.\n', { replaceExisting: false });
  const stages = [], experiments = [], checks = []; const stage = async (stageId, fn) => { const started = Date.now(); try { const value = await fn(); stages.push({ id: stageId, status: 'COMPLETE', durationMs: Date.now() - started }); writeJsonAtomicOwned(ownership, path.join(runDir, 'stage_ledger.json'), stages); return value; } catch (error) { stages.push({ id: stageId, status: 'FAILED', durationMs: Date.now() - started, error: error.message }); writeJsonAtomicOwned(ownership, path.join(runDir, 'stage_ledger.json'), stages); throw error; } };
  const rules = JSON.parse(fs.readFileSync(path.join(projectRoot, 'rules', 'swedish-alga-free-order-v1.json'), 'utf8')), rulesHash = sha256Text(stableJson(rules)); if (rulesHash !== CANONICAL.rulesHash) throw new Error('Frozen canonical rules hash mismatch');
  const historicalRules = JSON.parse(fs.readFileSync(path.join(projectRoot, 'rules', 'kth-2012-implementation-compatible-v1.json'), 'utf8')), historicalRulesHash = sha256Text(stableJson(historicalRules));
  writeJsonAtomicOwned(ownership, path.join(runDir, 'run_configuration.json'), {
    profileId: profile.profileId,
    profileDefinitionSha256,
    mode,
    runId: id,
    sourceCommit,
    resolvedWorkers: {
      precomputationWorkers: config.workers,
      simulationWorkers: config.simWorkers,
      deterministicRebuildWorkers: deterministicWorkers
    },
    fixedRuntimeConfiguration: {
      pilot: config.pilot,
      runs: config.runs,
      games: config.games,
      historicalGames: config.historicalGames,
      paired: config.paired,
      visits: config.visits,
      atlas: config.atlas
    },
    config,
    outputRoot: root
  }, { replaceExisting: false });

  await stage('preflight_and_source_identity', async () => { prepareV3SourceStage({ ownership, runDir, sourcePlan }); checks.push({ id: 'source-frozen', passed: mode !== 'official' || !(await runGit(['status', '--porcelain'])) }); });

  const canonicalPrimary = await stage('canonical_primary_precompute', async () => { const dir = ownedDir(path.join(runDir, 'canonical', 'primary')), db = openRunDatabase(dir); try { return await runPrecomputation({ runDir: dir, db, rulesHash, rulesetId: CANONICAL.rulesetId, workers: config.workers, chunkSize: 4096, writePolicy: true }); } finally { db.close(); } });
  const canonicalRebuild = await stage('canonical_deterministic_rebuild', async () => { const dir = ownedDir(path.join(runDir, 'canonical', 'rebuild')), db = openRunDatabase(dir); try { return await runPrecomputation({ runDir: dir, db, rulesHash, rulesetId: CANONICAL.rulesetId, workers: deterministicWorkers, chunkSize: 3072, writePolicy: true }); } finally { db.close(); } });
  const canonical = await stage('canonical_identity_and_policy_audit', async () => {
    assertCanonicalIdentity(canonicalPrimary.manifest);
    if (canonicalRebuild.manifest.valuesSha256 !== CANONICAL.valuesHash || canonicalRebuild.manifest.boundsSha256 !== CANONICAL.boundsHash || canonicalRebuild.manifest.policySha256 !== canonicalPrimary.manifest.policySha256 || canonicalPrimary.manifest.policySha256 !== CANONICAL.priorPolicyHash) throw new Error('Canonical deterministic model/policy identity mismatch');
    const a = auditPolicy(canonicalPrimary.policyPath, rulesHash), b = auditPolicy(canonicalRebuild.policyPath, rulesHash); checks.push({ id: 'canonical-identity', passed: true }, { id: 'canonical-policy-legality', passed: a.passed && b.passed });
    return writeIdentity(ownership, path.join(runDir, 'canonical_identity.json'), canonicalPrimary.manifest, { primaryPolicy: a, rebuildPolicy: b, byteIdentical: a.sha256 === b.sha256 });
  });
  const canonicalId = policyIdentity(canonicalPrimary.manifest); experiments.push(completeExperiment({ id: 'canonical-primary', kind: 'exact-model', identity: canonicalId, sourceCommit, workers: config.workers, outputs: [output('canonical/primary/values.bin'), output('canonical/primary/bounds.bin'), output('canonical/primary/policy.bin')] }), completeExperiment({ id: 'canonical-rebuild', kind: 'determinism', identity: canonicalId, sourceCommit, workers: deterministicWorkers, outputs: [output('canonical/rebuild/values.bin'), output('canonical/rebuild/bounds.bin'), output('canonical/rebuild/policy.bin')] }));

  const historicalPrimary = await stage('historical_primary_precompute', async () => { const dir = ownedDir(path.join(runDir, 'historical', 'primary')), db = openRunDatabase(dir); try { return await runPrecomputation({ runDir: dir, db, rulesHash: historicalRulesHash, rulesetId: HISTORICAL.rulesetId, scoringOptions: { twoPairSinglePairFallback: true }, workers: config.workers, chunkSize: 4096, writePolicy: true }); } finally { db.close(); } });
  const historicalRebuild = await stage('historical_deterministic_rebuild', async () => { const dir = ownedDir(path.join(runDir, 'historical', 'rebuild')), db = openRunDatabase(dir); try { return await runPrecomputation({ runDir: dir, db, rulesHash: historicalRulesHash, rulesetId: HISTORICAL.rulesetId, scoringOptions: { twoPairSinglePairFallback: true }, workers: deterministicWorkers, chunkSize: 3072, writePolicy: true }); } finally { db.close(); } });
  const historical = await stage('historical_identity_and_policy_audit', async () => {
    const p = historicalPrimary.manifest, r = historicalRebuild.manifest; if (p.valuesSha256 !== r.valuesSha256 || p.boundsSha256 !== r.boundsSha256 || p.policySha256 !== r.policySha256) throw new Error('Historical deterministic rebuild mismatch'); if (Number(p.startingExpectedValue.toFixed(2)) !== HISTORICAL.reportedRoundedValue) throw new Error(`Fresh compatibility value ${p.startingExpectedValue} does not round to 248.63`);
    const a = auditPolicy(historicalPrimary.policyPath, historicalRulesHash), b = auditPolicy(historicalRebuild.policyPath, historicalRulesHash); checks.push({ id: 'historical-rebuild', passed: a.sha256 === b.sha256 }, { id: 'historical-rounded-value', passed: true });
    return writeIdentity(ownership, path.join(runDir, 'historical_identity.json'), p, { sourceCommit: HISTORICAL.sourceCommit, paperSha256: HISTORICAL.paperSha256, primaryPolicy: a, rebuildPolicy: b, singleSemanticDifference: historicalRules.singleSemanticDifference });
  });
  const historicalId = policyIdentity(historicalPrimary.manifest); experiments.push(completeExperiment({ id: 'historical-primary', kind: 'compatibility-model', identity: historicalId, sourceCommit, workers: config.workers, outputs: [output('historical/primary/values.bin'), output('historical/primary/bounds.bin'), output('historical/primary/policy.bin')] }), completeExperiment({ id: 'historical-rebuild', kind: 'compatibility-determinism', identity: historicalId, sourceCommit, workers: deterministicWorkers, outputs: [output('historical/rebuild/values.bin'), output('historical/rebuild/bounds.bin'), output('historical/rebuild/policy.bin')] }));

  const pilotSummary = await stage('pilot_simulation', async () => { const dir = ownedDir(path.join(runDir, 'pilot')), db = openRunDatabase(dir); try { const result = await runSimulationPlan({ runDir: dir, db, valuesPath: canonicalPrimary.valuesPath, boundsPath: canonicalPrimary.boundsPath, policyPath: canonicalPrimary.policyPath, plan: [{ id: 'pilot', policyId: 'optimal', runNumber: 0, gameCount: config.pilot, seed: seed64(id + ':pilot').toString() }], workers: config.simWorkers, batchSize: Math.min(50000, config.pilot) }); const agreement = simulationAgreement(result[0], CANONICAL.midpoint); writeJsonAtomicOwned(ownership, path.join(dir, 'pilot_agreement.json'), agreement, { replaceExisting: false }); checks.push({ id: 'pilot-agreement', passed: true }); return result[0]; } finally { db.close(); } });
  experiments.push(completeExperiment({ id: 'pilot', kind: 'optimal-pilot', identity: canonicalId, sourceCommit, seed: pilotSummary.seed, gameCount: config.pilot, workers: config.simWorkers, outputs: [output('pilot/simulations/pilot.bin'), output('pilot/pilot_agreement.json')] }));

  const optimalSummaries = await stage('independent_optimal_simulations', async () => { const dir = ownedDir(path.join(runDir, 'optimal')), db = openRunDatabase(dir), plan = Array.from({ length: config.runs }, (_, i) => ({ id: `optimal_${String(i + 1).padStart(2, '0')}`, policyId: 'optimal', runNumber: i + 1, gameCount: config.games, seed: seed64(`${id}:optimal:${i + 1}`).toString() })); try { return await runSimulationPlan({ runDir: dir, db, valuesPath: canonicalPrimary.valuesPath, boundsPath: canonicalPrimary.boundsPath, policyPath: canonicalPrimary.policyPath, plan, workers: config.simWorkers, batchSize: Math.min(50000, config.games) }); } finally { db.close(); } });
  for (const s of optimalSummaries) { assertHistogram(s.aggregate.histogram, s.aggregate.n, s.id + '.histogram'); assertScientificValue(s); }
  experiments.push(completeExperiment({ id: 'optimal-independent-runs', kind: 'optimal-simulation', identity: canonicalId, sourceCommit, seed: 'see optimal/simulations/seed_manifest.json', gameCount: config.runs * config.games, workers: config.simWorkers, batches: optimalSummaries.length, outputs: [output('optimal/simulations/simulation_summaries.json'), ...optimalSummaries.map(s => output(`optimal/simulations/${s.id}.bin`))] }));

  const histSimulation = await stage('historical_simulation', async () => { const dir = ownedDir(path.join(runDir, 'historical', 'simulation')), db = openRunDatabase(dir); try { return (await runSimulationPlan({ runDir: dir, db, valuesPath: historicalPrimary.valuesPath, boundsPath: historicalPrimary.boundsPath, policyPath: historicalPrimary.policyPath, scoringOptions: { twoPairSinglePairFallback: true }, plan: [{ id: 'historical_optimal', policyId: 'optimal', runNumber: 1, gameCount: config.historicalGames, seed: seed64(id + ':historical').toString() }], workers: config.simWorkers, batchSize: Math.min(50000, config.historicalGames) }))[0]; } finally { db.close(); } });
  experiments.push(completeExperiment({ id: 'historical-simulation', kind: 'compatibility-simulation', identity: historicalId, sourceCommit, seed: histSimulation.seed, gameCount: config.historicalGames, workers: config.simWorkers, outputs: [output('historical/simulation/simulations/historical_optimal.bin')] }));

  const stateIndex = createStateIndex(), tables = readTables(canonicalPrimary.valuesPath, canonicalPrimary.boundsPath, stateIndex.totalStates), evaluator = new ActionValueEvaluator({ ...tables, stateIndex }), zeroContinuation = new Float64Array(stateIndex.totalStates), oneTurnEvaluator = new ActionValueEvaluator({ values: zeroContinuation, lower: zeroContinuation, upper: zeroContinuation, stateIndex });
  const visit = await stage('visit_weighted_decision_experiment', () => runVisitAnalysis({ outDir: ownedDir(path.join(runDir, 'decision')), seed: seed64(id + ':visits'), gameCount: config.visits, evaluator, hashes: canonicalId }));
  const structural = await stage('structural_decision_atlas', () => runStructuralAtlas({ outDir: ownedDir(path.join(runDir, 'structural')), evaluator, stateIndex, hashes: canonicalId, statesPerLayer: config.atlas }));
  const upper = await stage('upper_and_option_estimands', async () => { const report = upperPointEstimands({ outDir: ownedDir(path.join(runDir, 'estimands')), values: tables.values, stateIndex, hashes: canonicalId }); const option = optionCostsFromVisitSample({ outDir: path.join(runDir, 'estimands'), sampleFile: path.join(runDir, 'decision', 'visit_decisions.jsonl'), evaluator, hashes: canonicalId }); return { ...report, option }; });
  const paired = await stage('paired_policy_comparisons', () => runPairedComparisons({ outDir: ownedDir(path.join(runDir, 'paired')), seed: seed64(id + ':paired'), gameCount: config.paired, evaluator, oneTurnEvaluator }));
  experiments.push(completeExperiment({ id: 'visit-decisions', kind: 'visit-weighted-decisions', identity: canonicalId, sourceCommit, seed: visit.seed, gameCount: config.visits, outputs: [output('decision/visit_decisions.jsonl'), output('decision/visit_aggregates.json')] }), completeExperiment({ id: 'structural-atlas', kind: 'structural-decisions', identity: canonicalId, sourceCommit, outputs: [output('structural/structural_decision_atlas.json')] }), completeExperiment({ id: 'paired-policies', kind: 'paired-policy-comparison', identity: canonicalId, sourceCommit, seed: paired.seed, gameCount: config.paired, outputs: [output('paired/paired_policy_comparisons.json')] }), completeExperiment({ id: 'scientific-estimands', kind: 'estimands', identity: canonicalId, sourceCommit, outputs: [output('estimands/upper_point_raw.jsonl'), output('estimands/upper_point_aggregates.json'), output('estimands/category_option_costs.jsonl'), output('estimands/surprising_positions.json')] }));

  const verification = await stage('final_model_and_simulation_verification', async () => { const db = openRunDatabase(runDir); try { const report = await verifyRun({ runDir, db, rulesHash, valuesPath: canonicalPrimary.valuesPath, boundsPath: canonicalPrimary.boundsPath, policyPath: canonicalPrimary.policyPath, manifest: canonicalPrimary.manifest, determinismManifest: canonicalRebuild.manifest, simulationSummaries: optimalSummaries, requiredOptimalGames: config.runs * config.games, expectedOptimalRuns: config.runs }); if (!report.publicationReady) throw new Error('Final verification is not publication ready'); checks.push({ id: 'final-verification', passed: true }); return report; } finally { db.close(); } });
  await stage('analysis_tables_and_figures', async () => { await runAnalysis({ runDir, manifest: canonicalPrimary.manifest, valuesPath: canonicalPrimary.valuesPath, boundsPath: canonicalPrimary.boundsPath, simulationSummaries: optimalSummaries, verification }); await writeCorrectedFigures({ runDir, simulationSummaries: optimalSummaries, upperReport: upper, visitReport: visit, hashes: canonicalId }); });
  await stage('schemas_and_evidence_registers', async () => { writeSchemas(runDir); writeJsonAtomicOwned(ownership, path.join(runDir, 'limitations_and_scope.json'), { historicalInterpretation: 'The compatibility result shows sufficiency and strong support, not developer intent or uniqueness.', numericalLanguage: 'Exhaustive exact-model binary64 computation with a conservative enclosure; not symbolic exact arithmetic.', conditionalResults: 'Descriptive associations only.', authenticity: 'Hashes establish integrity, not authorship or authenticity.' }, { replaceExisting: false }); writeJsonAtomicOwned(ownership, path.join(runDir, 'claim_to_evidence_register.json'), claimToEvidenceRegister(), { replaceExisting: false }); });
  experiments.push(completeExperiment({ id: 'analysis-and-figures', kind: 'analysis', identity: canonicalId, sourceCommit, outputs: [output('master_results.json'), output('figures/metadata/04_final_score_distribution.json'), output('figures/metadata/05_score_cdf.json'), output('figures/metadata/12_upper_point_estimands.json'), output('figures/metadata/15_decision_margins.json')] }), completeExperiment({ id: 'schemas', kind: 'schemas', identity: canonicalId, sourceCommit, outputs: [output('schemas/experiments.schema.json'), output('data-dictionary/DATA_DICTIONARY.csv')] }));

  await stage('format_and_schema_audit', async () => { const report = auditRunFormats(runDir); checks.push({ id: 'format-and-schema-audit', passed: report.passed }); });

  await stage('staging_archive_integrity_and_clean_room', async () => { const stagingRoot = ownedDir(path.join(root, `.staging-${id}`), { mustBeNew: true }), paperStage = assertOwnedPath(ownership, path.join(stagingRoot, 'paper'), { mustExist: false }); buildPaperStaging(runDir, paperStage, { sourcePlan }); assertOwnedPath(ownership, paperStage, { mustExist: true, type: 'directory' }); const tempFullPath = assertOwnedPath(ownership, path.join(stagingRoot, 'full-staging.zip'), { mustExist: false }), tempPaperPath = assertOwnedPath(ownership, path.join(stagingRoot, 'paper-staging.zip'), { mustExist: false }), tempFull = createZip(runDir, tempFullPath), tempPaper = createZip(paperStage, tempPaperPath); const a = await auditZip(tempFull, ['source_snapshot/', 'canonical/primary/policy.bin']), b = await auditZip(tempPaper, ['canonical_identity.json', 'figures/']); const cleanDir = assertOwnedPath(ownership, path.join(stagingRoot, 'clean-room'), { mustExist: false }), clean = cleanRoomTest(tempFull, cleanDir); checks.push({ id: 'staging-full-archive', passed: a.passed }, { id: 'staging-paper-archive', passed: b.passed }, { id: 'staging-clean-room', passed: clean.passed }); });
  experiments.push(completeExperiment({ id: 'archive-build-and-audit', kind: 'archive', identity: canonicalId, sourceCommit, outputs: [output(`Yatzy_Full_Scientific_Archive_v3_${id}.zip`, 'output-root'), output(`Yatzy_Paper_Evidence_Bundle_v3_${id}.zip`, 'output-root')] }));
  await writeExperimentManifest({ runDir, runId: id, sourceCommit, identities: { canonical: canonicalId, historical: historicalId }, experiments });
  const preInventory = await artifactInventory(runDir, { exclude: ['source_snapshot/'] }); await auditInventory(runDir, preInventory);
  await stage('final_provenance', async () => writeFinalProvenance({ runDir, runId: id, sourceCommit, stages: [...stages, { id: 'final_provenance', status: 'COMPLETE', durationMs: 0 }], experiments, inventory: preInventory, checks }));

  const archives = await stage('final_archives_and_reopen_audit', async () => {
    const full = assertOwnedPath(ownership, path.join(root, `Yatzy_Full_Scientific_Archive_v3_${id}.zip`), { mustExist: false }), paper = assertOwnedPath(ownership, path.join(root, `Yatzy_Paper_Evidence_Bundle_v3_${id}.zip`), { mustExist: false }), staging = assertOwnedPath(ownership, path.join(root, `.paper-${id}`), { mustExist: false }); buildPaperStaging(runDir, staging, { sourcePlan }); assertOwnedPath(ownership, staging, { mustExist: true, type: 'directory' }); createZip(runDir, full); createZip(staging, paper);
    const fullAudit = await auditZip(full, ['source_snapshot/', 'package-lock.json', 'canonical/primary/values.bin', 'canonical/primary/bounds.bin', 'canonical/primary/policy.bin', 'optimal/simulations/', 'experiments.json', 'final_provenance.json', 'schemas/', 'figures/']);
    const paperAudit = await auditZip(paper, ['canonical_identity.json', 'historical_identity.json', 'master_results.json', 'claim_to_evidence_register.json', 'analysis/', 'tables/', 'figures/', 'schemas/', 'decision/', 'structural/', 'estimands/', 'paired/', 'research/']);
    return { full, paper, fullAudit, paperAudit };
  });
  const cleanRoom = await stage('clean_room_reproduction', async () => cleanRoomTest(archives.full, assertOwnedPath(ownership, path.join(root, `.clean-room-${id}`), { mustExist: false })));
  const archiveAudit = { status: 'COMPLETE', runId: id, full: archives.fullAudit, paper: archives.paperAudit, cleanRoom: { passed: cleanRoom.passed, exitCode: cleanRoom.exitCode }, p0Blockers: [], canonicalIdentityIntact: true };
  writeJsonAtomicOwned(ownership, path.join(root, `Yatzy_v3_${id}_FINAL_AUDIT.json`), archiveAudit, { replaceExisting: false });
  return { mode, runId: id, runDir, sourceCommit, canonical, historical, stages, experiments, checks, archives: { full: archives.full, paper: archives.paper }, archiveAudit };
}
