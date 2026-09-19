import fs from 'node:fs';
import path from 'node:path';
import { barChart, lineChart } from '../analysis/charts.mjs';
import { writeJsonAtomic } from '../util/fs.mjs';
import { sha256File } from '../util/hash.mjs';

function render(runDir, name, fn, args) { const svgDir = path.join(runDir, 'figures', 'svg'), pngDir = path.join(runDir, 'figures', 'png'); fs.mkdirSync(svgDir, { recursive: true }); fs.mkdirSync(pngDir, { recursive: true }); const base = path.join(svgDir, name); fn({ ...args, fileBase: base }); fs.renameSync(base + '.png', path.join(pngDir, name + '.png')); }
function csv(file, header, rows) { fs.writeFileSync(file, header.join(',') + '\n' + rows.map(r => r.join(',')).join('\n') + '\n'); }
export async function writeCorrectedFigures({ runDir, simulationSummaries, upperReport, visitReport, hashes }) {
  const sourceDir = path.join(runDir, 'figures', 'source-data'); fs.mkdirSync(sourceDir, { recursive: true });
  const pooled = Array(375).fill(0); for (const s of simulationSummaries) for (let i = 0; i < pooled.length; i += 1) pooled[i] += s.aggregate.histogram[i]; const total = pooled.reduce((a, b) => a + b, 0);
  const bins = []; for (let lo = 0; lo < pooled.length; lo += 10) bins.push([lo, Math.min(lo + 9, pooled.length - 1), pooled.slice(lo, lo + 10).reduce((a, b) => a + b, 0)]); csv(path.join(sourceDir, 'figure_04.csv'), ['bin_low', 'bin_high', 'count'], bins);
  render(runDir, '04_final_score_distribution', barChart, { title: 'Optimal final-score distribution (10-point bins)', labels: bins.filter(x => x[2]).map(x => `${x[0]}-${x[1]}`), values: bins.filter(x => x[2]).map(x => x[2]), yLabel: 'Games' });
  let cumulative = 0; const cdf = pooled.map((n, score) => { cumulative += n; return [score, cumulative / total]; }); csv(path.join(sourceDir, 'figure_05.csv'), ['final_score', 'cumulative_probability'], cdf);
  render(runDir, '05_score_cdf', lineChart, { title: 'Empirical cumulative final-score distribution', series: [{ label: 'CDF at every integer score 0..374', values: cdf.map(x => x[1]) }], xLabel: 'Final score (array index equals score)', yLabel: 'Cumulative probability' });
  const upper = upperReport.aggregates; csv(path.join(sourceDir, 'figure_12.csv'), ['upper_subtotal', 'n', 'mean_delta_continuation', 'mean_delta_grant'], upper.map(x => [x.upper, x.n, x.mean_delta_continuation, x.mean_delta_grant]));
  render(runDir, '12_upper_point_estimands', lineChart, { title: 'Upper-point continuation and grant estimands', series: [{ label: 'delta_continuation', values: upper.map(x => x.mean_delta_continuation) }, { label: 'delta_grant', values: upper.map(x => x.mean_delta_grant) }], xLabel: 'Reachable capped upper subtotal (ordered rows)', yLabel: 'Expected final-score points' });
  const ties = Object.entries(visitReport.tieClasses); csv(path.join(sourceDir, 'figure_15.csv'), ['tie_class', 'visit_count'], ties); render(runDir, '15_decision_margins', barChart, { title: 'Finite visit-weighted decision classifications', labels: ties.map(x => x[0]), values: ties.map(x => x[1]), yLabel: 'Decision visits' });
  const definitions = {
    '04_final_score_distribution': ['figures/source-data/figure_04.csv', 'Sum raw integer-score histogram into disjoint 10-point bins.', 'independent optimal-policy games', 'games per 10-point bin', 'empirical counts', 'True bins; no every-tenth-score subsampling.'],
    '05_score_cdf': ['figures/source-data/figure_05.csv', 'Cumulative sum of every integer final-score count divided by total games; x array index is final score.', 'independent optimal-policy games', 'cumulative probability', 'empirical distribution', 'Empirical CDF with explicit final-score x mapping.'],
    '12_upper_point_estimands': ['figures/source-data/figure_12.csv', 'Aggregate separately defined delta_continuation and delta_grant by reachable upper subtotal.', 'reachable model states', 'expected final-score points', 'exhaustive descriptive state aggregate', 'Continuation difference and one-point grant are shown as distinct estimands.'],
    '15_decision_margins': ['figures/source-data/figure_15.csv', 'Count finite value-aware decision visits by mutually exclusive classification.', 'visit-weighted optimal-policy decisions', 'decision visits', 'descriptive counts', 'Finite visit-weighted action-value classifications; tolerance is not exactness.']
  };
  const metadataDir = path.join(runDir, 'figures', 'metadata'); fs.mkdirSync(metadataDir, { recursive: true });
  for (const [id, d] of Object.entries(definitions)) {
    const svg = path.join(runDir, 'figures', 'svg', id + '.svg'), png = path.join(runDir, 'figures', 'png', id + '.png'), source = path.join(runDir, ...d[0].split('/'));
    writeJsonAtomic(path.join(metadataDir, id + '.json'), { figureId: id, source: d[0], sourceSha256: await sha256File(source), transform: d[1], population: d[2], units: d[3], uncertainty: d[4], hashes, code: 'engine/src/v3/corrected-figures.mjs', caption: d[5], svgSha256: await sha256File(svg), pngSha256: await sha256File(png) });
  }
  const master = path.join(runDir, 'master_results.json');
  for (const name of fs.readdirSync(path.join(runDir, 'figures', 'svg')).filter(x => x.endsWith('.svg'))) {
    const id = name.slice(0, -4), metadata = path.join(metadataDir, id + '.json'); if (fs.existsSync(metadata)) continue;
    const svg = path.join(runDir, 'figures', 'svg', name), png = path.join(runDir, 'figures', 'png', id + '.png');
    writeJsonAtomic(metadata, { figureId: id, source: 'master_results.json and declared analysis tables', sourceSha256: await sha256File(master), transform: 'Deterministic transformation implemented by engine/src/analysis/analyze.mjs and charts.mjs.', population: id.includes('architecture') || id.includes('compression') || id.includes('durability') ? 'method diagram' : 'declared canonical model or independent optimal-policy simulation population', units: 'declared on axes', uncertainty: 'descriptive unless a displayed interval is explicitly labeled', hashes, code: 'engine/src/analysis/analyze.mjs', caption: `Figure ${id}: deterministic v3 analysis output with source, population, units, and transformation recorded here.`, svgSha256: await sha256File(svg), ...(fs.existsSync(png) ? { pngSha256: await sha256File(png) } : {}) });
  }
  return fs.readdirSync(metadataDir).length;
}
