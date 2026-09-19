import path from 'node:path';
import { writeJsonAtomic } from '../util/fs.mjs';
import { assertScientificValue, assertNonempty } from './quality-gates.mjs';

export function writeFinalProvenance({ runDir, runId, sourceCommit, stages, experiments, inventory, checks, recoveryEvents = [] }) {
  if (!stages.length || stages.some(s => s.status !== 'COMPLETE')) throw new Error('Provenance cannot complete with incomplete stages');
  if (!experiments.length || experiments.some(e => e.status !== 'COMPLETE')) throw new Error('Provenance cannot complete with incomplete experiments');
  assertNonempty(inventory, 'provenance inventory'); if (checks.some(c => !c.passed)) throw new Error('Provenance has failed checks');
  const report = { schemaVersion: 3, status: 'COMPLETE', generatedAt: new Date().toISOString(), runId, sourceCommit, stages, experiments, recoveryEvents, inventory, checks };
  assertScientificValue(report); writeJsonAtomic(path.join(runDir, 'final_provenance.json'), report); return report;
}

