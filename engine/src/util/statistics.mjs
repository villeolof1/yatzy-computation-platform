export class RunningStats {
  constructor() { this.n = 0; this.mean = 0; this.m2 = 0; this.min = Infinity; this.max = -Infinity; }
  push(x) {
    this.n += 1;
    const d = x - this.mean;
    this.mean += d / this.n;
    this.m2 += d * (x - this.mean);
    if (x < this.min) this.min = x;
    if (x > this.max) this.max = x;
  }
  merge(other) {
    if (!other.n) return;
    if (!this.n) { Object.assign(this, other); return; }
    const n = this.n + other.n;
    const d = other.mean - this.mean;
    this.m2 += other.m2 + d * d * this.n * other.n / n;
    this.mean = (this.mean * this.n + other.mean * other.n) / n;
    this.n = n;
    this.min = Math.min(this.min, other.min);
    this.max = Math.max(this.max, other.max);
  }
  get variance() { return this.n > 1 ? this.m2 / (this.n - 1) : 0; }
  get sd() { return Math.sqrt(this.variance); }
  get se() { return this.n ? this.sd / Math.sqrt(this.n) : 0; }
  toJSON() { return { n: this.n, mean: this.mean, variance: this.variance, sd: this.sd, se: this.se, min: this.min, max: this.max }; }
}

export function normal95(mean, se) { return [mean - 1.959963984540054 * se, mean + 1.959963984540054 * se]; }
export function normal99(mean, se) { return [mean - 2.5758293035489004 * se, mean + 2.5758293035489004 * se]; }

export function quantileFromHistogram(hist, q, minScore = 0) {
  const total = hist.reduce((a, b) => a + b, 0);
  if (!total) return null;
  const target = q * (total - 1);
  let cumulative = 0;
  for (let i = 0; i < hist.length; i += 1) {
    cumulative += hist[i];
    if (cumulative > target) return i + minScore;
  }
  return hist.length - 1 + minScore;
}

export function wilsonInterval(successes, n, z = 1.959963984540054) {
  if (!n) return [0, 0];
  const p = successes / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const center = (p + z2 / (2 * n)) / denom;
  const half = z * Math.sqrt((p * (1 - p) + z2 / (4 * n)) / n) / denom;
  return [center - half, center + half];
}

export function pearsonFromSums(n, sx, sy, sxx, syy, sxy) {
  const num = n * sxy - sx * sy;
  const den = Math.sqrt((n * sxx - sx * sx) * (n * syy - sy * sy));
  return den ? num / den : 0;
}
