export function popcount15(x) {
  x = x - ((x >>> 1) & 0x5555);
  x = (x & 0x3333) + ((x >>> 2) & 0x3333);
  x = (x + (x >>> 4)) & 0x0f0f;
  x += x >>> 8;
  return x & 0x1f;
}

export function createStateIndex() {
  const reachableByUpperMask = [];
  const rank = new Int16Array(64 * 64);
  rank.fill(-1);
  const count = new Uint8Array(64);
  const base = new Uint32Array(64);
  let upperPairCount = 0;

  for (let mask = 0; mask < 64; mask += 1) {
    let totals = new Set([0]);
    for (let face = 1; face <= 6; face += 1) {
      if (!(mask & (1 << (face - 1)))) continue;
      const next = new Set();
      for (const t of totals) for (let k = 0; k <= 5; k += 1) next.add(Math.min(63, t + k * face));
      totals = next;
    }
    const sorted = [...totals].sort((a, b) => a - b);
    reachableByUpperMask[mask] = Uint8Array.from(sorted);
    count[mask] = sorted.length;
    base[mask] = upperPairCount * 512;
    for (let i = 0; i < sorted.length; i += 1) rank[mask * 64 + sorted[i]] = i;
    upperPairCount += sorted.length;
  }

  const totalStates = upperPairCount * 512;
  const stateMask = new Uint16Array(totalStates);
  const stateUpper = new Uint8Array(totalStates);
  const layerLists = Array.from({ length: 16 }, () => []);

  for (let upperMask = 0; upperMask < 64; upperMask += 1) {
    const totals = reachableByUpperMask[upperMask];
    for (let lowerMask = 0; lowerMask < 512; lowerMask += 1) {
      const mask = upperMask | (lowerMask << 6);
      for (let r = 0; r < totals.length; r += 1) {
        const index = base[upperMask] + lowerMask * totals.length + r;
        stateMask[index] = mask;
        stateUpper[index] = totals[r];
        layerLists[popcount15(mask)].push(index);
      }
    }
  }

  function indexOf(mask, upper) {
    const upperMask = mask & 63;
    const lowerMask = mask >>> 6;
    const r = rank[upperMask * 64 + upper];
    if (r < 0) return -1;
    return base[upperMask] + lowerMask * count[upperMask] + r;
  }

  return {
    reachableByUpperMask,
    rank,
    count,
    base,
    upperPairCount,
    totalStates,
    stateMask,
    stateUpper,
    layers: layerLists.map(a => Uint32Array.from(a)),
    indexOf
  };
}


export function createStateLookup() {
  const rank = new Int16Array(64 * 64);
  rank.fill(-1);
  const count = new Uint8Array(64);
  const base = new Uint32Array(64);
  let upperPairCount = 0;
  for (let mask = 0; mask < 64; mask += 1) {
    let totals = new Set([0]);
    for (let face = 1; face <= 6; face += 1) {
      if (!(mask & (1 << (face - 1)))) continue;
      const next = new Set();
      for (const t of totals) for (let k = 0; k <= 5; k += 1) next.add(Math.min(63, t + k * face));
      totals = next;
    }
    const sorted = [...totals].sort((a, b) => a - b);
    count[mask] = sorted.length;
    base[mask] = upperPairCount * 512;
    for (let i = 0; i < sorted.length; i += 1) rank[mask * 64 + sorted[i]] = i;
    upperPairCount += sorted.length;
  }
  const indexOf = (mask, upper) => {
    const um = mask & 63;
    const lm = mask >>> 6;
    const r = rank[um * 64 + upper];
    return r < 0 ? -1 : base[um] + lm * count[um] + r;
  };
  return { rank, count, base, indexOf, totalStates: upperPairCount * 512 };
}
