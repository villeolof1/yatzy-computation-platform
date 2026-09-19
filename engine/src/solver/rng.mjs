import { createHash } from 'node:crypto';

export function seed64(namespace) {
  const b = createHash('sha256').update(String(namespace)).digest();
  return b.readBigUInt64LE(0);
}

function splitmix32(x) {
  x = (x + 0x9e3779b9) >>> 0;
  let z = x;
  z = Math.imul(z ^ (z >>> 16), 0x21f0aaad);
  z = Math.imul(z ^ (z >>> 15), 0x735a2d97);
  return (z ^ (z >>> 15)) >>> 0;
}

export function gameSeed(baseSeed, gameIndex) {
  const lo = Number(baseSeed & 0xffffffffn) >>> 0;
  const hi = Number((baseSeed >> 32n) & 0xffffffffn) >>> 0;
  return [splitmix32(lo ^ gameIndex), splitmix32(hi ^ Math.imul(gameIndex, 0x85ebca6b))];
}

export class XorShift128 {
  constructor(a, b) {
    this.a = a || 0x12345678; this.b = b || 0x9abcdef0; this.c = splitmix32((a ^ 0xa5a5a5a5) >>> 0) || 0x6c8e9cf5; this.d = splitmix32((b ^ 0x5a5a5a5a) >>> 0) || 0xda3e39cb;
  }
  nextUint() {
    const t = (this.a ^ (this.a << 11)) >>> 0;
    this.a = this.b; this.b = this.c; this.c = this.d;
    this.d = (this.d ^ (this.d >>> 19) ^ t ^ (t >>> 8)) >>> 0;
    return this.d;
  }
  int(n) {
    if (!Number.isInteger(n) || n <= 0 || n > 0x100000000) throw new RangeError('n must be an integer in 1..2^32');
    const range = 0x100000000;
    const limit = Math.floor(range / n) * n;
    let x;
    do x = this.nextUint(); while (x >= limit);
    return x % n;
  }
  float() { return this.nextUint() / 0x100000000; }
}
