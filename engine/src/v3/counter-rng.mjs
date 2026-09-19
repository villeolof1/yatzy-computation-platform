function mix32(x) {
  x = Math.imul(x ^ (x >>> 16), 0x7feb352d);
  x = Math.imul(x ^ (x >>> 15), 0x846ca68b);
  return (x ^ (x >>> 16)) >>> 0;
}

function seedWords(seed) {
  const s = BigInt(seed);
  return [Number(s & 0xffffffffn) >>> 0, Number((s >> 32n) & 0xffffffffn) >>> 0];
}

export function counterUint(seed, game, turn, roll, dieSlot, stream = 0, attempt = 0) {
  const [lo, hi] = seedWords(seed);
  let x = mix32(lo ^ Math.imul((game + 1) >>> 0, 0x9e3779b1));
  x = mix32(x ^ hi ^ Math.imul((turn + 1) >>> 0, 0x85ebca77));
  x = mix32(x ^ Math.imul((roll + 1) >>> 0, 0xc2b2ae3d));
  x = mix32(x ^ Math.imul((dieSlot + 1) >>> 0, 0x27d4eb2f));
  x = mix32(x ^ Math.imul((stream + 1) >>> 0, 0x165667b1));
  return mix32(x ^ Math.imul((attempt + 1) >>> 0, 0xd3a2646c));
}

export function counterInt(seed, n, game, turn, roll, dieSlot, stream = 0) {
  if (!Number.isInteger(n) || n <= 0 || n > 0x100000000) throw new RangeError('n must be in 1..2^32');
  const range = 0x100000000;
  const limit = Math.floor(range / n) * n;
  for (let attempt = 0; ; attempt += 1) {
    const x = counterUint(seed, game, turn, roll, dieSlot, stream, attempt);
    if (x < limit) return x % n;
  }
}

export function potentialDie(seed, game, turn, roll, dieSlot) {
  return counterInt(seed, 6, game, turn, roll, dieSlot, 0) + 1;
}

export class CounterStream {
  constructor(seed, game, turn, stream = 1) {
    this.seed = BigInt(seed); this.game = game; this.turn = turn; this.stream = stream; this.index = 0;
  }
  nextUint() {
    const i = this.index++;
    return counterUint(this.seed, this.game, this.turn, Math.floor(i / 5), i % 5, this.stream);
  }
  int(n) {
    const i = this.index++;
    return counterInt(this.seed, n, this.game, this.turn, Math.floor(i / 5), i % 5, this.stream);
  }
  float() { return this.nextUint() / 0x100000000; }
}
