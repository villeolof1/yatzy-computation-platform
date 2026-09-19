import fs from 'node:fs';
import path from 'node:path';
import { writeJsonAtomic } from '../util/fs.mjs';

const schema = (id, required, properties) => ({ $schema: 'https://json-schema.org/draft/2020-12/schema', $id: id, type: 'object', required, properties, additionalProperties: true });
export function writeSchemas(root) {
  const dir = path.join(root, 'schemas'); fs.mkdirSync(dir, { recursive: true });
  const schemas = {
    'experiments.schema.json': schema('yatzy-v3-experiments', ['schemaVersion', 'runId', 'experiments'], { schemaVersion: { const: 3 }, runId: { type: 'string', minLength: 1 }, experiments: { type: 'array', minItems: 1 } }),
    'visit-decision.schema.json': schema('yatzy-v3-visit-decision', ['population', 'gameIndex', 'turn', 'mask', 'upper', 'dice', 'bestAction', 'alternativeAction', 'bestValue', 'alternativeValue', 'margin', 'tieClass'], {}),
    'figure-metadata.schema.json': schema('yatzy-v3-figure-metadata', ['figureId', 'source', 'transform', 'population', 'units', 'uncertainty', 'hashes', 'caption'], {}),
    'provenance.schema.json': schema('yatzy-v3-provenance', ['status', 'runId', 'sourceCommit', 'stages', 'experiments', 'inventory', 'checks'], { status: { const: 'COMPLETE' } })
  };
  for (const [name, value] of Object.entries(schemas)) writeJsonAtomic(path.join(dir, name), value);
  writeJsonAtomic(path.join(dir, 'binary-formats.json'), {
    policy: { magic: 'YTZPOL02', headerBytes: 128, recordBytesPerState: 756, stages: ['score_only', 'one_reroll_remaining', 'two_rerolls_remaining'], actionEncoding: '0..14 category; 16+ roll-local legal-keeper ordinal' },
    simulation: { magic: 'YTZSIM02', headerBytes: 64, recordBytes: 48, missingValueSemantics: { minMarginFloat32: '0 means unavailable for fast policy-archive simulation; visit_decisions supplies scientific margins' } },
    endianness: 'little'
  });
  const dictionary = [
    ['mask', 'uint15', 'Bit i is one when category i is used.'], ['upper', 'uint6', 'Upper subtotal capped at 63.'], ['weight', 'number', 'Population-specific frequency or inverse-selection weight.'],
    ['margin', 'binary64 points', 'Best action value minus second-best action value.'], ['rerollAdvantage', 'binary64 points', 'Best reroll action value minus best immediate-score action value.'],
    ['delta_continuation', 'binary64 points', 'F(M,u+1)-F(M,u).'], ['delta_grant', 'binary64 points', '1+50 I(u=62)+F(M,min(63,u+1))-F(M,u).'],
    ['optionCost', 'binary64 points', 'Best position value minus the named legal category action value.'], ['tieClass', 'enum', 'One of four scientific tie classes or certified_order.']
  ];
  fs.mkdirSync(path.join(root, 'data-dictionary'), { recursive: true }); fs.writeFileSync(path.join(root, 'data-dictionary', 'DATA_DICTIONARY.csv'), 'field,type_or_unit,definition\n' + dictionary.map(r => r.map(x => `"${String(x).replaceAll('"', '""')}"`).join(',')).join('\n') + '\n');
  return Object.keys(schemas).length + 2;
}

