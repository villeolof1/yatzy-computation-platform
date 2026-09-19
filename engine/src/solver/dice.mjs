function key(counts) { return Array.from(counts).join(''); }

function enumerateCounts(total) {
  const out = [];
  const counts = new Uint8Array(6);
  function rec(face, left) {
    if (face === 5) {
      counts[5] = left;
      out.push(Uint8Array.from(counts));
      return;
    }
    for (let n = 0; n <= left; n += 1) {
      counts[face] = n;
      rec(face + 1, left - n);
    }
  }
  rec(0, total);
  return out;
}

const factorial = [1, 1, 2, 6, 24, 120];
export function multiplicity(counts) {
  const total = counts.reduce((a, b) => a + b, 0);
  let result = factorial[total];
  for (const n of counts) result /= factorial[n];
  return result;
}

export function createDiceUniverse() {
  const bySize = Array.from({ length: 6 }, (_, size) => enumerateCounts(size));
  const keepers = [];
  const sizeOffsets = new Uint16Array(7);
  let cursor = 0;
  for (let size = 0; size <= 5; size += 1) {
    sizeOffsets[size] = cursor;
    for (const counts of bySize[size]) keepers.push(counts);
    cursor = keepers.length;
  }
  sizeOffsets[6] = cursor;

  const keeperIdByKey = new Map(keepers.map((c, i) => [key(c), i]));
  const rolls = bySize[5];
  const rollIdByKey = new Map(rolls.map((c, i) => [key(c), i]));
  const rollKeeperIds = new Uint16Array(rolls.length);
  const initialMultiplicity = new Uint8Array(rolls.length);
  for (let i = 0; i < rolls.length; i += 1) {
    rollKeeperIds[i] = keeperIdByKey.get(key(rolls[i]));
    initialMultiplicity[i] = multiplicity(rolls[i]);
  }

  const children = new Uint16Array(keepers.length * 6);
  children.fill(0xffff);
  for (let id = 0; id < keepers.length; id += 1) {
    const counts = keepers[id];
    const size = counts.reduce((a, b) => a + b, 0);
    if (size === 5) continue;
    for (let face = 0; face < 6; face += 1) {
      const next = Uint8Array.from(counts);
      next[face] += 1;
      children[id * 6 + face] = keeperIdByKey.get(key(next));
    }
  }

  const legalKeepers = [];
  const legalOffsets = new Uint32Array(rolls.length + 1);
  for (let r = 0; r < rolls.length; r += 1) {
    legalOffsets[r] = legalKeepers.length;
    const roll = rolls[r];
    const sub = new Uint8Array(6);
    function rec(face) {
      if (face === 6) {
        let size = 0;
        for (const n of sub) size += n;
        if (size <= 4) legalKeepers.push(keeperIdByKey.get(key(sub)));
        return;
      }
      for (let n = 0; n <= roll[face]; n += 1) { sub[face] = n; rec(face + 1); }
    }
    rec(0);
  }
  legalOffsets[rolls.length] = legalKeepers.length;

  const keeperSizes = new Uint8Array(keepers.length);
  for (let i = 0; i < keepers.length; i += 1) keeperSizes[i] = keepers[i].reduce((a, b) => a + b, 0);

  const outcomeBySize = [];
  for (let size = 0; size <= 5; size += 1) {
    outcomeBySize[size] = bySize[size].map(c => ({ counts: c, multiplicity: multiplicity(c), denominator: 6 ** size }));
  }

  return {
    rolls,
    keepers,
    bySize,
    keeperIdByKey,
    rollIdByKey,
    rollKeeperIds,
    keeperSizes,
    children,
    legalKeepers: Uint16Array.from(legalKeepers),
    legalOffsets,
    initialMultiplicity,
    sizeOffsets,
    outcomeBySize,
    key
  };
}

export function keeperTransform(rollValues, universe, target = new Float64Array(universe.keepers.length)) {
  for (let r = 0; r < universe.rolls.length; r += 1) target[universe.rollKeeperIds[r]] = rollValues[r];
  for (let size = 4; size >= 0; size -= 1) {
    for (let id = universe.sizeOffsets[size]; id < universe.sizeOffsets[size + 1]; id += 1) {
      let sum = 0;
      for (let face = 0; face < 6; face += 1) sum += target[universe.children[id * 6 + face]];
      target[id] = sum / 6;
    }
  }
  return target;
}
