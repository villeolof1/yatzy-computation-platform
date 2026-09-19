import fs from 'node:fs';
import path from 'node:path';
import { assertRelativePath } from './paths.mjs';
import { sha256File } from '../util/hash.mjs';

const HASH = /^[0-9a-f]{64}$/;

export function assertScientificValue(value, at = '$', { required = true } = {}) {
  if (value === null || value === undefined) {
    if (required) throw new Error('Required null at ' + at);
    return;
  }
  if (typeof value === 'number' && !Number.isFinite(value)) throw new Error('Nonfinite value at ' + at);
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i += 1) assertScientificValue(value[i], at + '[' + i + ']', { required });
  } else if (typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) assertScientificValue(child, at + '.' + key, { required });
  }
}

export function assertNonempty(value, name) {
  if (value === null || value === undefined) throw new Error(name + ' is required');
  if ((Array.isArray(value) || typeof value === 'string') && value.length === 0) throw new Error(name + ' is empty');
  return value;
}

export function assertHash(value, name = 'hash') {
  if (!HASH.test(String(value))) throw new Error('Missing or invalid ' + name);
  return value;
}

export function validateExperimentManifest(manifest) {
  assertScientificValue(manifest);
  assertNonempty(manifest.experiments, 'experiments');
  const ids = new Set();
  for (const experiment of manifest.experiments) {
    if (ids.has(experiment.id)) throw new Error('Duplicate experiment id: ' + experiment.id);
    ids.add(experiment.id);
    if (experiment.required && experiment.status !== 'COMPLETE') throw new Error('Incomplete required experiment: ' + experiment.id);
    for (const key of ['kind', 'sourceCommit', 'seed']) assertNonempty(experiment[key], experiment.id + '.' + key);
    for (const key of ['gameCount', 'workers', 'batches', 'durationMs']) if (!Number.isFinite(experiment[key]) || experiment[key] < 0) throw new Error('Invalid experiment field: ' + experiment.id + '.' + key);
    assertNonempty(experiment.inputs, experiment.id + '.inputs'); assertNonempty(experiment.outputs, experiment.id + '.outputs');
    for (const p of [...(experiment.inputs || []), ...(experiment.outputs || [])]) assertRelativePath(p.path || p);
    for (const key of ['rulesHash', 'valuesHash', 'boundsHash', 'policyHash']) if (experiment[key] !== undefined) assertHash(experiment[key], experiment.id + '.' + key);
  }
  return true;
}

export function assertHistogram(histogram, expected, name) {
  assertNonempty(histogram, name);
  const total = histogram.reduce((a, b) => a + b, 0);
  if (total === 0) throw new Error(name + ' has zero total');
  if (expected !== undefined && total !== expected) throw new Error(name + ' count mismatch');
  return total;
}

export async function auditInventory(root, inventory) {
  assertNonempty(inventory, 'artifact inventory');
  for (const item of inventory) {
    assertRelativePath(item.path); assertHash(item.sha256, item.path + '.sha256');
    const file = path.resolve(root, ...item.path.split('/'));
    if (!fs.existsSync(file) || !fs.statSync(file).isFile() || fs.statSync(file).size === 0) throw new Error('Missing or empty artifact: ' + item.path);
    const actual = await sha256File(file); if (actual !== item.sha256) throw new Error('Checksum failure: ' + item.path);
  }
  return true;
}

export function validateFigureMetadata(meta) {
  for (const key of ['figureId', 'source', 'transform', 'population', 'units', 'uncertainty', 'code', 'caption']) assertNonempty(meta[key], 'figure.' + key);
  if (/\b(TODO|TBD|placeholder|unknown)\b/i.test(meta.caption)) throw new Error('Invalid caption: ' + meta.caption);
  assertHash(meta.sourceSha256, 'figure.sourceSha256'); assertHash(meta.svgSha256, 'figure.svgSha256'); if (meta.pngSha256 !== undefined) assertHash(meta.pngSha256, 'figure.pngSha256');
  return true;
}
