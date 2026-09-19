import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  LEGACY_COMPLETE_PIPELINE_PROFILE_ID,
  PipelineManager,
  PUBLIC_SMOKE_PROFILE_ID,
  legacyDefaultConfig,
  resolveLegacyPipelineConfig
} from '../src/pipeline/manager.mjs';
import {
  REDUCED_DEVELOPMENT_PROFILE,
  REGISTERED_FULL_PROFILE,
  REGISTERED_FULL_PROFILE_SHA256,
  deterministicRebuildWorkers,
  runV3Pipeline,
  resolveV3Configuration
} from '../src/v3/official-pipeline.mjs';
import { sha256Text, stableJson } from '../src/util/hash.mjs';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const fixtureRoot = path.join(projectRoot, 'engine', 'test', 'fixtures');
const canonicalRulesPath = path.join(projectRoot, 'rules', 'swedish-alga-free-order-v1.json');
const canonicalRulesSha256 = 'd122c68b140b42a4509c8fc3f2252661b8bf51a791d630996706458b05825018';

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function sha256File(file) {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function assertConfigInvalid(fn) {
  assert.throws(fn, error => {
    assert.equal(error.code, 'YATZY_CONFIG_INVALID');
    return true;
  });
}

function assertDeepFrozen(value) {
  if (value && typeof value === 'object') {
    assert.equal(Object.isFrozen(value), true);
    for (const nested of Object.values(value)) assertDeepFrozen(nested);
  }
}

function recursiveEntries(root) {
  if (!fs.existsSync(root)) return [];
  const entries = [];
  for (const name of fs.readdirSync(root)) {
    const full = path.join(root, name);
    const stat = fs.lstatSync(full);
    entries.push({ path: path.relative(root, full).replaceAll('\\', '/'), type: stat.isDirectory() ? 'directory' : 'file', bytes: stat.isFile() ? stat.size : null });
    if (stat.isDirectory()) {
      for (const child of recursiveEntries(full)) entries.push({ ...child, path: `${name}/${child.path}` });
    }
  }
  return entries.sort((a, b) => a.path.localeCompare(b.path));
}

function runPowerShellLauncherHarness({ outputRoot, phrase = 'RUN REGISTERED FULL RESEARCH', childExitCode = 0, nodeResolverFails = false }) {
  const container = fs.mkdtempSync(path.join(os.tmpdir(), 'yatzy-phase-9c3b-launcher-harness-'));
  const wrapper = path.join(container, 'launcher-harness.ps1');
  const scenario = path.join(container, 'scenario.json');
  fs.writeFileSync(scenario, JSON.stringify({ phrase, childExitCode, nodeResolverFails }), 'utf8');
  fs.writeFileSync(wrapper, String.raw`param(
  [string]$LauncherPath,
  [string]$OutputRoot,
  [string]$ScenarioPath
)
$ErrorActionPreference = 'Stop'
$scenario = Get-Content -Raw -LiteralPath $ScenarioPath | ConvertFrom-Json
. $LauncherPath -OutputRoot $OutputRoot
$state = [ordered]@{
  Events = New-Object System.Collections.Generic.List[string]
  Arguments = @()
  Executable = $null
  WorkingDirectory = $null
  ChildCalled = $false
  NodeResolverCalled = $false
}
$writer = { param($Message) $state.Events.Add('warning:' + [string]$Message) }.GetNewClosure()
$reader = { param($Prompt) $state.Events.Add('ack:' + [string]$Prompt); return [string]$scenario.phrase }.GetNewClosure()
$resolver = {
  $state.NodeResolverCalled = $true
  if ($scenario.nodeResolverFails) { throw 'mock missing node' }
  return 'C:\mock-tools\node.exe'
}.GetNewClosure()
$child = {
  param($Executable, $Arguments, $WorkingDirectory)
  $state.Events.Add('child')
  $state.ChildCalled = $true
  $state.Executable = [string]$Executable
  $state.Arguments = @($Arguments)
  $state.WorkingDirectory = [string]$WorkingDirectory
  return [int]$scenario.childExitCode
}.GetNewClosure()
$accepted = $false
$exitCode = $null
$errorMessage = $null
try {
  $exitCode = Invoke-YatzyFullResearchLauncher -RequestedOutputRoot $OutputRoot -ProjectRoot (Split-Path -Parent (Split-Path -Parent $LauncherPath)) -AcknowledgementReader $reader -NodeResolver $resolver -ChildInvoker $child -MessageWriter $writer -AllowRedirectedInputForTest
  $accepted = $true
} catch {
  $errorMessage = $_.Exception.Message
}
[pscustomobject]@{
  accepted = $accepted
  exitCode = $exitCode
  errorMessage = $errorMessage
  events = @($state.Events)
  childCalled = $state.ChildCalled
  nodeResolverCalled = $state.NodeResolverCalled
  executable = $state.Executable
  arguments = @($state.Arguments)
  workingDirectory = $state.WorkingDirectory
} | ConvertTo-Json -Compress -Depth 6
`, 'utf8');
  try {
    const result = spawnSync('powershell.exe', [
      '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-File', wrapper,
      '-LauncherPath', path.join(projectRoot, 'scripts', 'run-complete-research.ps1'),
      '-OutputRoot', outputRoot,
      '-ScenarioPath', scenario
    ], { cwd: projectRoot, encoding: 'utf8', windowsHide: true, timeout: 30_000 });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const lines = result.stdout.trim().split(/\r?\n/);
    return JSON.parse(lines.at(-1));
  } finally {
    fs.rmSync(container, { recursive: true, force: true });
  }
}

test('configuration fixtures parse and contain no private or machine-specific material', () => {
  const fixtureFiles = [
    path.join(fixtureRoot, 'bounded-public-profile.json'),
    path.join(fixtureRoot, 'registered-full-profile.json')
  ];
  for (const file of fixtureFiles) {
    const text = fs.readFileSync(file, 'utf8');
    assert.doesNotThrow(() => JSON.parse(text));
    assert.doesNotMatch(text, /[A-Za-z]:[\\/]/);
    assert.doesNotMatch(text, /\/(?:Users|home|private|tmp)\//i);
    assert.doesNotMatch(text, /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i);
    assert.doesNotMatch(text, /hostname|cpuModel|environmentDump|privateGitAuthor/i);
  }
});

test('registered full fixture exactly equals the deeply frozen production definition', () => {
  const fixture = readJson(path.join(fixtureRoot, 'registered-full-profile.json'));
  assert.deepEqual(REGISTERED_FULL_PROFILE, fixture);
  assertDeepFrozen(REGISTERED_FULL_PROFILE);
  assert.equal(REGISTERED_FULL_PROFILE.profileId, 'registered-full-v3');
  assert.equal(REGISTERED_FULL_PROFILE.kind, 'registered-full-research');
  assert.equal(REGISTERED_FULL_PROFILE.mode, 'official');
  assert.equal(REGISTERED_FULL_PROFILE.identity.canonicalRulesSha256, canonicalRulesSha256);
  assert.equal(REGISTERED_FULL_PROFILE.identity.historicalCompatibleRulesetId, 'kth-2012-implementation-compatible-v1');
  assert.equal(REGISTERED_FULL_PROFILE.identity.historicalTwoPairSinglePairFallback, true);
});

test('registered full stable-JSON profile SHA-256 is deterministic', () => {
  const first = sha256Text(stableJson(REGISTERED_FULL_PROFILE));
  const second = sha256Text(stableJson(REGISTERED_FULL_PROFILE));
  assert.equal(first, second);
  assert.equal(first, REGISTERED_FULL_PROFILE_SHA256);
  assert.match(first, /^[0-9a-f]{64}$/);
});

test('bounded public-smoke fixture locks exact bounds, assertion, and denied claims', () => {
  const fixture = readJson(path.join(fixtureRoot, 'bounded-public-profile.json'));
  assert.deepEqual(fixture, {
    schemaVersion: 1,
    profileId: 'public-smoke-v1',
    kind: 'bounded-public-smoke',
    canonicalRules: {
      rulesetId: 'swedish-alga-free-order-v1',
      sha256: canonicalRulesSha256
    },
    invocation: {
      npmScript: 'smoke',
      command: 'node engine/src/cli.mjs smoke'
    },
    bounds: {
      fullGameSimulations: 0,
      deterministicReferenceQueries: 1,
      nodeProcesses: 1,
      workerThreads: 0,
      precomputationWorkers: 0,
      simulationWorkers: 0,
      runtimeDirectory: 'data/smoke',
      generatedPayloadFiles: 0,
      persistentPayloadBytes: 0,
      precomputationEnabled: false,
      requiresExistingTablesOrPolicy: false,
      dossierEnabled: false,
      archiveGenerationEnabled: false,
      policyComparisonEnabled: false,
      finalVerifyRunEnabled: false,
      expectedCompletionClass: 'interactive-seconds',
      timeoutMilliseconds: null,
      peakRssBytes: null
    },
    assertion: {
      deterministicReferenceValue: 2.301432126285,
      printedDecimalPlaces: 12
    },
    scope: {
      fullResearchReproduction: false,
      fullGameExpectedValueValidated: false,
      valuesBoundsPolicyHashesValidated: false,
      monteCarloResultsValidated: false,
      figuresValidated: false,
      dossierValidated: false,
      archivesValidated: false,
      cleanRoomResearchReproductionValidated: false,
      publicationReadinessValidated: false,
      routingChangedInPhase9c1c: false
    }
  });
});

test('official V3 resolver returns exact defaults and fixed scientific values', () => {
  const resolved = resolveV3Configuration({ mode: 'official', environment: {} });
  assert.deepEqual(resolved, {
    workers: 8,
    simWorkers: 5,
    pilot: 50_000,
    runs: 10,
    games: 1_000_000,
    historicalGames: 100_000,
    paired: 500,
    visits: 200,
    atlas: 32
  });
  const simulations = REGISTERED_FULL_PROFILE.fixedConfiguration.simulations;
  assert.equal(resolved.pilot, simulations.pilotGames);
  assert.equal(resolved.runs, simulations.independentOptimalRuns);
  assert.equal(resolved.games, simulations.gamesPerOptimalRun);
  assert.equal(resolved.runs * resolved.games, simulations.totalIndependentOptimalGames);
});

test('official V3 resolver accepts only exact worker minima and maxima', () => {
  assert.deepEqual(
    { ...resolveV3Configuration({ mode: 'official', environment: { YATZY_WORKERS: '1', YATZY_SIM_WORKERS: '1' } }) },
    { workers: 1, simWorkers: 1, pilot: 50_000, runs: 10, games: 1_000_000, historicalGames: 100_000, paired: 500, visits: 200, atlas: 32 }
  );
  assert.deepEqual(
    { ...resolveV3Configuration({ mode: 'official', environment: { YATZY_WORKERS: '12', YATZY_SIM_WORKERS: '8' } }) },
    { workers: 12, simWorkers: 8, pilot: 50_000, runs: 10, games: 1_000_000, historicalGames: 100_000, paired: 500, visits: 200, atlas: 32 }
  );
});

test('official V3 resolver rejects noncanonical, non-string, and out-of-bounds worker values', () => {
  const invalidWorkers = ['0', '13', '1.0', '1e1', '+1', '-1', ' 1', '1 ', '0x8', '', '01', 'NaN', 'Infinity', '9007199254740992', 8, null, true, [], {}];
  const invalidSimWorkers = ['0', '9', '1.0', '1e1', '+1', '-1', ' 1', '1 ', '0x5', '', '01', 'NaN', 'Infinity', '9007199254740992', 5, null, false, [], {}];
  for (const value of invalidWorkers) assertConfigInvalid(() => resolveV3Configuration({ mode: 'official', environment: { YATZY_WORKERS: value } }));
  for (const value of invalidSimWorkers) assertConfigInvalid(() => resolveV3Configuration({ mode: 'official', environment: { YATZY_SIM_WORKERS: value } }));
});

test('V3 resolver forbids fixed-field overrides and locks deterministic rebuild workers', () => {
  for (const field of ['pilot', 'runs', 'games', 'historicalGames', 'paired', 'visits', 'atlas', 'workers', 'simWorkers']) {
    assertConfigInvalid(() => resolveV3Configuration({ mode: 'official', environment: {}, [field]: 1 }));
  }
  assert.equal(deterministicRebuildWorkers(8), 7);
  assert.equal(deterministicRebuildWorkers(1), 1);
  assert.equal(deterministicRebuildWorkers(12), 11);
  for (const invalid of [0, 13, 1.5, '8', NaN, Infinity]) assertConfigInvalid(() => deterministicRebuildWorkers(invalid));
});

test('reduced V3 resolver preserves exact values, strict worker bounds, and fixed simulation workers', () => {
  assert.deepEqual(resolveV3Configuration({ mode: 'reduced', environment: {} }), {
    workers: 4,
    simWorkers: 2,
    pilot: 2_000,
    runs: 2,
    games: 3_000,
    historicalGames: 2_000,
    paired: 20,
    visits: 10,
    atlas: 2
  });
  assert.equal(resolveV3Configuration({ mode: 'reduced', environment: { YATZY_WORKERS: '1' } }).workers, 1);
  assert.equal(resolveV3Configuration({ mode: 'reduced', environment: { YATZY_WORKERS: '6' } }).workers, 6);
  assert.equal(resolveV3Configuration({ mode: 'reduced', environment: { YATZY_SIM_WORKERS: '999' } }).simWorkers, 2);
  assert.equal(resolveV3Configuration({ mode: 'reduced', environment: { YATZY_SIM_WORKERS: [] } }).simWorkers, 2);
  assertDeepFrozen(REDUCED_DEVELOPMENT_PROFILE);
});

test('reduced V3 resolver rejects every noncanonical or out-of-bounds YATZY_WORKERS value', () => {
  for (const value of ['0', '7', '1.0', '1e1', '+1', '-1', ' 1', '1 ', '0x4', '', '01', 'NaN', 'Infinity', '9007199254740992', 4, null, true, [], {}]) {
    assertConfigInvalid(() => resolveV3Configuration({ mode: 'reduced', environment: { YATZY_WORKERS: value } }));
  }
});

test('legacy default helper locks fixed fields and caps workers for controlled core counts', () => {
  const fixed = {
    optimalRuns: 10,
    gamesPerRun: 1_000_000,
    comparisonGames: 1_000_000,
    chunkSize: 4096,
    simulationBatchSize: 50_000,
    pilotGames: 500_000,
    determinismBuild: true,
    includeValueTable: true,
    copyToDownloads: true
  };
  for (const [logicalCores, workers, simulationWorkers] of [[1, 1, 1], [2, 1, 1], [8, 7, 5], [64, 12, 5]]) {
    assert.deepEqual(legacyDefaultConfig(logicalCores), { ...fixed, workers, simulationWorkers });
  }
  for (const value of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, NaN, Infinity, '8', null, true]) assertConfigInvalid(() => legacyDefaultConfig(value));
  assert.equal(LEGACY_COMPLETE_PIPELINE_PROFILE_ID, 'legacy-complete-pipeline-v3');
});

test('legacy resolver accepts every permitted field at exact bounds without mutating callers', () => {
  const cases = [
    ['workers', 1], ['workers', 7], ['workers', 12],
    ['simulationWorkers', 1], ['simulationWorkers', 5], ['simulationWorkers', 8],
    ['gamesPerRun', 1_000], ['gamesPerRun', 1_000_000],
    ['determinismBuild', false], ['determinismBuild', true],
    ['copyToDownloads', false], ['copyToDownloads', true]
  ];
  const empty = resolveLegacyPipelineConfig({}, 8);
  assert.deepEqual(empty, legacyDefaultConfig(8));
  assert.notEqual(empty, legacyDefaultConfig(8));
  for (const [field, value] of cases) {
    const input = Object.freeze({ [field]: value });
    const before = JSON.stringify(input);
    const resolved = resolveLegacyPipelineConfig(input, 8);
    assert.equal(resolved[field], value);
    assert.equal(JSON.stringify(input), before);
    assert.notEqual(resolved, input);
  }
});

test('legacy resolver rejects unknown, internal, prototype, accessor, and non-plain inputs', () => {
  assertConfigInvalid(() => resolveLegacyPipelineConfig({ unknown: 1 }, 8));
  for (const key of ['optimalRuns', 'comparisonGames', 'chunkSize', 'simulationBatchSize', 'pilotGames', 'includeValueTable']) {
    assertConfigInvalid(() => resolveLegacyPipelineConfig({ [key]: 1 }, 8));
  }
  for (const text of ['{"__proto__":1}', '{"prototype":1}', '{"constructor":1}']) {
    assertConfigInvalid(() => resolveLegacyPipelineConfig(JSON.parse(text), 8));
  }
  for (const input of [null, [], 1, 'value', true, Symbol('value'), () => {}, new Date(), Object.create(null), Object.create({ custom: true })]) {
    assertConfigInvalid(() => resolveLegacyPipelineConfig(input, 8));
  }
  assertConfigInvalid(() => resolveLegacyPipelineConfig({ [Symbol('field')]: 1 }, 8));
  const accessor = {};
  Object.defineProperty(accessor, 'workers', { enumerable: true, get: () => 8 });
  assertConfigInvalid(() => resolveLegacyPipelineConfig(accessor, 8));
  const hidden = {};
  Object.defineProperty(hidden, 'workers', { enumerable: false, value: 8 });
  assertConfigInvalid(() => resolveLegacyPipelineConfig(hidden, 8));
});

test('legacy resolver rejects invalid numeric and boolean values without clamping or coercion', () => {
  const numericCases = [
    ['workers', [0, 13, -1, 1.5, '1', Number.MAX_SAFE_INTEGER + 1, NaN, Infinity, null, true, [], {}]],
    ['simulationWorkers', [0, 9, -1, 1.5, '1', Number.MAX_SAFE_INTEGER + 1, NaN, Infinity, null, false, [], {}]],
    ['gamesPerRun', [0, 999, 1_000_001, -1, 1.5, '1000', Number.MAX_SAFE_INTEGER + 1, NaN, Infinity, null, true, [], {}]]
  ];
  for (const [field, values] of numericCases) {
    for (const value of values) assertConfigInvalid(() => resolveLegacyPipelineConfig({ [field]: value }, 8));
  }
  for (const field of ['determinismBuild', 'copyToDownloads']) {
    for (const value of [0, 1, 'true', 'false', null, [], {}]) assertConfigInvalid(() => resolveLegacyPipelineConfig({ [field]: value }, 8));
  }
});

test('invalid manager configuration is rejected before every run side effect', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yatzy-phase-9c1c-manager-'));
  try {
    fs.mkdirSync(path.join(root, 'rules'), { recursive: true });
    fs.copyFileSync(canonicalRulesPath, path.join(root, 'rules', 'swedish-alga-free-order-v1.json'));
    const manager = new PipelineManager(root);
    const before = recursiveEntries(root);
    let generatedRunId = false;
    let computationStarted = false;
    let emittedEvents = 0;
    manager.makeRunId = () => { generatedRunId = true; return 'forbidden-run-id'; };
    manager.execute = async () => { computationStarted = true; };
    manager.on('update', () => { emittedEvents += 1; });
    await assert.rejects(manager.start({ workers: 0 }), error => error.code === 'YATZY_CONFIG_INVALID');
    assert.equal(generatedRunId, false);
    assert.equal(computationStarted, false);
    assert.equal(emittedEvents, 0);
    assert.equal(manager.runDir, null);
    assert.equal(manager.db, null);
    assert.equal(manager.runningPromise, null);
    assert.equal(manager.currentStage, null);
    assert.equal(fs.existsSync(path.join(root, 'data', 'runs')), false);
    assert.equal(fs.existsSync(path.join(root, 'data', 'active-pipeline.json')), false);
    assert.deepEqual(recursiveEntries(root), before);
    assert.equal(manager.status().defaultProfileId, PUBLIC_SMOKE_PROFILE_ID);
    assert.equal(recursiveEntries(root).some(entry => /run\.sqlite|active-pipeline|pipeline_events/i.test(entry.path)), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('V3 and manager source order configuration validation before run side effects and record profile identity', () => {
  const v3Source = fs.readFileSync(path.join(projectRoot, 'engine', 'src', 'v3', 'official-pipeline.mjs'), 'utf8');
  const managerSource = fs.readFileSync(path.join(projectRoot, 'engine', 'src', 'pipeline', 'manager.mjs'), 'utf8');
  const v3Start = v3Source.indexOf('export async function runV3Pipeline');
  const v3Body = v3Source.slice(v3Start);
  assert.ok(v3Body.indexOf('YATZY_FULL_RESEARCH_ACK_REQUIRED') < v3Body.indexOf('resolveV3Configuration'));
  assert.ok(v3Body.indexOf('resolveV3Configuration') < v3Body.indexOf('claimOutputRoot'));
  for (const field of ['profileId', 'profileDefinitionSha256', 'resolvedWorkers', 'fixedRuntimeConfiguration', 'outputRoot']) assert.match(v3Body, new RegExp(`\\b${field}\\b`));
  assert.doesNotMatch(v3Body, /Number\(process\.env\.YATZY_/);
  const managerStart = managerSource.indexOf('async start(config={})');
  const managerBody = managerSource.slice(managerStart, managerSource.indexOf('async markPaused', managerStart));
  assert.ok(managerBody.indexOf('resolveLegacyPipelineConfig') < managerBody.indexOf('makeRunId'));
  assert.ok(managerBody.indexOf('resolveLegacyPipelineConfig') < managerBody.indexOf('ensureDir'));
  assert.match(managerBody, /pipeline\.profileId/);
});

test('acknowledged official selection reaches configuration validation without output-root side effects', async () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'yatzy-phase-9c1c-v3-'));
  const outputRoot = path.join(parent, 'output-root-must-not-exist');
  const hadWorkers = Object.hasOwn(process.env, 'YATZY_WORKERS');
  const previousWorkers = process.env.YATZY_WORKERS;
  try {
    process.env.YATZY_WORKERS = '13';
    await assert.rejects(runV3Pipeline({ mode: 'official', outputRoot, acknowledgeFullResearch: true }), error => error.code === 'YATZY_CONFIG_INVALID');
    assert.equal(fs.existsSync(outputRoot), false);
    assert.deepEqual(fs.readdirSync(parent), []);
  } finally {
    if (hadWorkers) process.env.YATZY_WORKERS = previousWorkers;
    else delete process.env.YATZY_WORKERS;
    fs.rmSync(parent, { recursive: true, force: true });
  }
});

test('registered full programmatic selection refuses missing acknowledgement before every side effect', async () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'yatzy-phase-9c3a-no-ack-'));
  const outputRoot = path.join(parent, 'output-root-must-not-exist');
  try {
    await assert.rejects(runV3Pipeline({ mode: 'official', outputRoot }), error => error.code === 'YATZY_FULL_RESEARCH_ACK_REQUIRED');
    assert.equal(fs.existsSync(outputRoot), false);
    assert.deepEqual(fs.readdirSync(parent), []);
  } finally {
    fs.rmSync(parent, { recursive: true, force: true });
  }
});

test('ordinary CLI defaults select bounded public smoke and create no payload', () => {
  const invocations = [
    ['engine/src/cli.mjs'],
    ['engine/src/cli.mjs', 'smoke'],
    ['engine/src/v3/cli.mjs']
  ];
  for (const args of invocations) {
    const result = spawnSync(process.execPath, args, {
      cwd: projectRoot,
      encoding: 'utf8',
      windowsHide: true,
      timeout: 60_000
    });
    assert.equal(result.status, 0, `${args.join(' ')}\n${result.stderr}`);
    assert.match(result.stdout, /^Selected profile: public-smoke-v1$/m);
    const referenceLines = result.stdout.split(/\r?\n/).filter(line => line.startsWith('Reference one-category Yatzy turn value:'));
    assert.deepEqual(referenceLines, ['Reference one-category Yatzy turn value: 2.301432126285']);
  }
  const smokeRoot = path.join(projectRoot, 'data', 'smoke');
  assert.equal(fs.existsSync(smokeRoot), true);
  assert.deepEqual(recursiveEntries(smokeRoot), []);
  assert.equal(fs.existsSync(path.join(projectRoot, 'data', 'runs')), false);
  const dataFiles = recursiveEntries(path.join(projectRoot, 'data')).filter(entry => entry.type === 'file' && entry.path !== '.gitkeep');
  assert.deepEqual(dataFiles, []);
  const manager = fs.readFileSync(path.join(projectRoot, 'engine', 'src', 'pipeline', 'manager.mjs'), 'utf8');
  const smokeBranch = manager.slice(manager.indexOf('runPublicSmoke()'), manager.indexOf('async start(config={})'));
  assert.doesNotMatch(smokeBranch, /runPrecomputation|runSimulationPlan|verifyRun|buildDossier|renderDossierPdf|createZip|fetch\(|https?:|net\.connect|spawn/);
});

test('explicit full CLI without acknowledgement refuses before output creation', () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'yatzy-phase-9c3a-cli-no-ack-'));
  const outputRoot = path.join(parent, 'output-root-must-not-exist');
  try {
    const result = spawnSync(process.execPath, ['engine/src/v3/cli.mjs', 'official', '--output-root', outputRoot], {
      cwd: projectRoot,
      encoding: 'utf8',
      windowsHide: true,
      timeout: 30_000
    });
    assert.notEqual(result.status, 0);
    assert.match(`${result.stdout}\n${result.stderr}`, /YATZY_FULL_RESEARCH_ACK_REQUIRED|--acknowledge-full-research/);
    assert.equal(fs.existsSync(outputRoot), false);
    assert.deepEqual(fs.readdirSync(parent), []);
  } finally {
    fs.rmSync(parent, { recursive: true, force: true });
  }
});

test('CLI, npm, server, browser, and Windows launcher routes keep safe defaults and full explicit', () => {
  const packageJson = readJson(path.join(projectRoot, 'package.json'));
  assert.equal(packageJson.scripts.smoke, 'node engine/src/cli.mjs smoke');
  assert.equal(packageJson.scripts.pipeline, 'node engine/src/cli.mjs smoke');
  assert.equal(packageJson.scripts.start, 'node engine/src/server.mjs');
  assert.equal(packageJson.scripts['pipeline:official'], 'node engine/src/v3/cli.mjs official');
  const cli = fs.readFileSync(path.join(projectRoot, 'engine', 'src', 'cli.mjs'), 'utf8');
  assert.match(cli, /process\.argv\[2\]\|\|'smoke'/);
  assert.match(cli, /YATZY_UNSAFE_LEGACY_ROUTE_DISABLED/);
  const v3Cli = fs.readFileSync(path.join(projectRoot, 'engine', 'src', 'v3', 'cli.mjs'), 'utf8');
  assert.match(v3Cli, /'smoke'/);
  assert.match(v3Cli, /--output-root/);
  assert.match(v3Cli, /--acknowledge-full-research/);
  const server = fs.readFileSync(path.join(projectRoot, 'engine', 'src', 'server.mjs'), 'utf8');
  assert.match(server, /manager\.runPublicSmoke\(\)/);
  assert.doesNotMatch(server, /await manager\.initialize\(\)/);
  const app = fs.readFileSync(path.join(projectRoot, 'web', 'app.js'), 'utf8');
  assert.match(app, /Run bounded public smoke\/demo/);
  assert.match(app, /profileId:'public-smoke-v1'/);
  assert.match(app, /registered-full-v3/);
  assert.match(app, /--acknowledge-full-research/);
  assert.doesNotMatch(app, /id="magic-start"[^`]+Run complete research pipeline/);
  const windows = fs.readFileSync(path.join(projectRoot, 'scripts', 'start-windows.bat'), 'utf8');
  assert.match(windows, /npm start/);
  assert.doesNotMatch(windows, /pipeline:official|run-complete-research/);
  const launcher = fs.readFileSync(path.join(projectRoot, 'scripts', 'run-complete-research.ps1'), 'utf8');
  assert.match(launcher, /registered-full-v3/);
  assert.match(launcher, /engine\/src\/v3\/cli\.mjs/);
  assert.match(launcher, /'official'/);
  assert.match(launcher, /'--output-root'/);
  assert.match(launcher, /'--acknowledge-full-research'/);
  assert.match(launcher, /RUN REGISTERED FULL RESEARCH/);
  assert.doesNotMatch(launcher, /engine\/src\/cli\.mjs['", ]+pipeline/);
});

test('hardened full launcher builds exact child arguments after warnings and exact acknowledgement', { skip: process.platform !== 'win32' }, () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'yatzy-phase-9c3b-safe-path-'));
  const outputRoot = path.join(parent, 'owned output with spaces');
  try {
    const result = runPowerShellLauncherHarness({ outputRoot });
    assert.equal(result.accepted, true);
    assert.equal(result.exitCode, 0);
    assert.equal(result.childCalled, true);
    assert.equal(result.executable, 'C:\\mock-tools\\node.exe');
    assert.deepEqual(result.arguments, [
      'engine/src/v3/cli.mjs',
      'official',
      '--output-root',
      path.resolve(outputRoot),
      '--acknowledge-full-research'
    ]);
    assert.equal(result.workingDirectory, projectRoot);
    const acknowledgementIndex = result.events.findIndex(event => event.startsWith('ack:'));
    const childIndex = result.events.indexOf('child');
    assert.ok(acknowledgementIndex > 0);
    assert.ok(result.events.slice(0, acknowledgementIndex).every(event => event.startsWith('warning:')));
    assert.ok(result.events.slice(0, acknowledgementIndex).some(event => /Runtime:/.test(event)));
    assert.ok(result.events.slice(0, acknowledgementIndex).some(event => /CPU:/.test(event)));
    assert.ok(result.events.slice(0, acknowledgementIndex).some(event => /Memory:/.test(event)));
    assert.ok(result.events.slice(0, acknowledgementIndex).some(event => /Storage:/.test(event)));
    assert.ok(result.events.slice(0, acknowledgementIndex).some(event => /Large artifacts:/.test(event)));
    assert.ok(result.events.slice(0, acknowledgementIndex).some(event => event.includes(path.resolve(outputRoot))));
    assert.equal(childIndex, acknowledgementIndex + 1);
    assert.equal(fs.existsSync(outputRoot), false);
  } finally {
    fs.rmSync(parent, { recursive: true, force: true });
  }
});

test('full launcher rejects missing or inexact acknowledgement without child or output', { skip: process.platform !== 'win32' }, () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'yatzy-phase-9c3b-refusal-'));
  try {
    for (const phrase of ['', 'RUN REGISTERED FULL', 'run registered full research', ' RUN REGISTERED FULL RESEARCH']) {
      const outputRoot = path.join(parent, `output-${createHash('sha256').update(phrase).digest('hex').slice(0, 8)}`);
      const result = runPowerShellLauncherHarness({ outputRoot, phrase });
      assert.equal(result.accepted, false, phrase);
      assert.equal(result.childCalled, false, phrase);
      assert.match(result.errorMessage, /not acknowledged exactly/i);
      assert.equal(fs.existsSync(outputRoot), false, phrase);
    }
  } finally {
    fs.rmSync(parent, { recursive: true, force: true });
  }
});

test('full launcher rejects unsafe roots and junction redirection before acknowledgement or child', { skip: process.platform !== 'win32' }, () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'yatzy-phase-9c3b-path-refusal-'));
  const target = path.join(parent, 'target');
  const junction = path.join(parent, 'junction');
  fs.mkdirSync(target);
  fs.symlinkSync(target, junction, 'junction');
  try {
    const unsafeRoots = [
      path.parse(projectRoot).root,
      projectRoot,
      `${parent}\\safe\\..\\escape`,
      path.join(junction, 'output')
    ];
    for (const outputRoot of unsafeRoots) {
      const result = runPowerShellLauncherHarness({ outputRoot });
      assert.equal(result.accepted, false, outputRoot);
      assert.equal(result.nodeResolverCalled, false, outputRoot);
      assert.equal(result.childCalled, false, outputRoot);
      assert.equal(result.events.length, 0, outputRoot);
    }
  } finally {
    fs.rmSync(parent, { recursive: true, force: true });
  }
});

test('full launcher fails closed for missing Node and preserves child nonzero status', { skip: process.platform !== 'win32' }, () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'yatzy-phase-9c3b-exit-'));
  try {
    const missingNode = runPowerShellLauncherHarness({ outputRoot: path.join(parent, 'missing-node'), nodeResolverFails: true });
    assert.equal(missingNode.accepted, false);
    assert.equal(missingNode.childCalled, false);
    assert.equal(missingNode.events.length, 0);
    assert.match(missingNode.errorMessage, /Node\.js executable prerequisite is unavailable/);

    const childFailure = runPowerShellLauncherHarness({ outputRoot: path.join(parent, 'child-failure'), childExitCode: 23 });
    assert.equal(childFailure.accepted, true);
    assert.equal(childFailure.childCalled, true);
    assert.equal(childFailure.exitCode, 23);
    assert.equal(fs.existsSync(path.join(parent, 'child-failure')), false);
  } finally {
    fs.rmSync(parent, { recursive: true, force: true });
  }
});

test('bare and redirected launcher invocations refuse without starting or creating output', { skip: process.platform !== 'win32' }, () => {
  const launcher = path.join(projectRoot, 'scripts', 'run-complete-research.ps1');
  const bare = spawnSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', launcher], {
    cwd: projectRoot, encoding: 'utf8', windowsHide: true, timeout: 30_000
  });
  assert.notEqual(bare.status, 0);

  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'yatzy-phase-9c3b-redirected-'));
  const outputRoot = path.join(parent, 'must-not-exist');
  try {
    const redirected = spawnSync('powershell.exe', [
      '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-File', launcher, '-OutputRoot', outputRoot
    ], {
      cwd: projectRoot,
      encoding: 'utf8',
      windowsHide: true,
      timeout: 30_000,
      input: 'RUN REGISTERED FULL RESEARCH\n'
    });
    assert.notEqual(redirected.status, 0);
    assert.match(`${redirected.stdout}\n${redirected.stderr}`, /Redirected input cannot acknowledge/);
    assert.equal(fs.existsSync(outputRoot), false);
  } finally {
    fs.rmSync(parent, { recursive: true, force: true });
  }
});

test('full launcher contains no Git, persistent environment, network, or shell-string mutation route', () => {
  const launcher = fs.readFileSync(path.join(projectRoot, 'scripts', 'run-complete-research.ps1'), 'utf8');
  assert.match(launcher, /ReadLineAsync\(\)/);
  assert.match(launcher, /TimeoutMilliseconds = 120000/);
  assert.doesNotMatch(launcher, /git\s+config|SetEnvironmentVariable|\bsetx\b|Start-Process|Invoke-Expression|cmd(?:\.exe)?\s+\/c|Invoke-WebRequest|https?:\/\//i);
  assert.doesNotMatch(launcher, /\$env:[A-Za-z_][A-Za-z0-9_]*\s*=/i);
});

test('launcher contract, registered profile fixture, canonical rules, and package lock have exact identities', () => {
  const protectedHashes = {
    'scripts/run-complete-research.ps1': '55346c189e0387f7bced2886f1ff4abd8ae82e801d375618043774fa19978d59',
    'scripts/start-windows.bat': '0249b514431c6049e7241cb0f3937164b8275df47048f18669b2840cba66c7ed',
    'scripts/verify-environment.ps1': '2cf773f2fe3b311cb380e3c1fbf2f02290cd89573c9726560befd12f9ad3aea1',
    'engine/test/fixtures/registered-full-profile.json': '306947eb349f2d0ac38323137d123ff4e0a1f62c2997510648f2e8621015cded',
    'rules/swedish-alga-free-order-v1.json': '8d15a334ea17725f3aa75c042aa600e97bb33d746a27b7061ee123ac6479e613',
    'package-lock.json': '7a75d5ff4d22f41533253916a0c5122879a4e6e0a93c1749c6c92ee377cd593d'
  };
  for (const [relative, expected] of Object.entries(protectedHashes)) assert.equal(sha256File(path.join(projectRoot, ...relative.split('/'))), expected, relative);
});
