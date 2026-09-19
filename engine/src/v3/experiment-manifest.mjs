import fs from 'node:fs';
import path from 'node:path';
import { sha256File } from '../util/hash.mjs';
import { listFilesRecursive, writeJsonAtomic } from '../util/fs.mjs';
import { relativePosix } from './paths.mjs';
import { validateExperimentManifest } from './quality-gates.mjs';

export async function artifactInventory(root, { exclude = [] } = {}) {
  const files = listFilesRecursive(root).filter(f => !exclude.some(x => relativePosix(root, f).startsWith(x)));
  const out = []; for (const file of files) { const stat = fs.statSync(file); out.push({ path: relativePosix(root, file), sizeBytes: stat.size, sha256: await sha256File(file) }); } return out;
}
export async function writeExperimentManifest({ runDir, runId, sourceCommit, identities, experiments }) {
  const manifest = { schemaVersion: 3, runId, sourceCommit, createdAt: new Date().toISOString(), identities, experiments };
  validateExperimentManifest(manifest); writeJsonAtomic(path.join(runDir, 'experiments.json'), manifest); return manifest;
}
export function completeExperiment({ id, kind, seed = 'deterministic', gameCount = 0, workers = 1, batches = 1, inputs = [{ path: 'run_configuration.json' }], outputs = [], identity, sourceCommit, durationMs = 0 }) {
  return { id, kind, required: true, status: 'COMPLETE', seed: String(seed), gameCount, workers, batches, inputs, outputs, sourceCommit, rulesHash: identity.rulesHash, valuesHash: identity.valuesHash, boundsHash: identity.boundsHash, policyHash: identity.policyHash, durationMs };
}
