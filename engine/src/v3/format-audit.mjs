import fs from 'node:fs';
import path from 'node:path';
import { listFilesRecursive, writeJsonAtomic } from '../util/fs.mjs';
import { validateFigureMetadata } from './quality-gates.mjs';

export function auditRunFormats(runDir) {
  const files = listFilesRecursive(runDir), counts = { json: 0, jsonl: 0, csv: 0, svg: 0, png: 0, binary: 0 }; const failures = [];
  for (const file of files) {
    const rel = path.relative(runDir, file).replaceAll('\\', '/');
    try {
      if (file.endsWith('.json')) { const value = JSON.parse(fs.readFileSync(file, 'utf8')); if (rel.startsWith('figures/metadata/')) validateFigureMetadata(value); counts.json += 1; }
      else if (file.endsWith('.jsonl')) { const fd = fs.openSync(file, 'r'), b = Buffer.alloc(Math.min(65536, fs.statSync(file).size)); fs.readSync(fd, b, 0, b.length, 0); fs.closeSync(fd); const line = b.toString('utf8').split(/\r?\n/).find(Boolean); if (!line) throw new Error('empty JSONL'); JSON.parse(line); counts.jsonl += 1; }
      else if (file.endsWith('.csv')) { const fd = fs.openSync(file, 'r'), b = Buffer.alloc(Math.min(65536, fs.statSync(file).size)); fs.readSync(fd, b); fs.closeSync(fd); const first = b.toString('utf8').split(/\r?\n/, 2); if (!first[0] || !first[1]) throw new Error('CSV lacks header or data'); counts.csv += 1; }
      else if (file.endsWith('.svg')) { const text = fs.readFileSync(file, 'utf8'); if (!text.includes('<svg')) throw new Error('invalid SVG'); counts.svg += 1; }
      else if (file.endsWith('.png')) { const fd = fs.openSync(file, 'r'), b = Buffer.alloc(8); fs.readSync(fd, b); fs.closeSync(fd); if (b.toString('hex') !== '89504e470d0a1a0a') throw new Error('invalid PNG'); counts.png += 1; }
      else if (file.endsWith('.bin')) { const fd = fs.openSync(file, 'r'), b = Buffer.alloc(8); fs.readSync(fd, b); fs.closeSync(fd); const magic = b.toString('ascii'); if (!['YTZVAL02', 'YTZBND02', 'YTZPOL02', 'YTZSIM02'].includes(magic)) throw new Error('unknown binary magic ' + magic); counts.binary += 1; }
    } catch (error) { failures.push({ path: rel, error: error.message }); }
  }
  const report = { passed: failures.length === 0, counts, failures }; writeJsonAtomic(path.join(runDir, 'format_audit.json'), report); if (!report.passed) throw new Error('Format audit failed: ' + JSON.stringify(failures.slice(0, 5))); return report;
}
