export const CANONICAL = Object.freeze({
  rulesetId: 'swedish-alga-free-order-v1',
  rulesHash: 'd122c68b140b42a4509c8fc3f2252661b8bf51a791d630996706458b05825018',
  valuesHash: '59880282ab231bc87992d7e02751b4469525f2d73e555aea35ba63eadfc5a582',
  boundsHash: '03d977013c8827a422191213c3562c4b24d165a72a4ee9a484b7da7e0e5cc458',
  priorPolicyHash: '0063e3a2f4b5de8aed8dbabfbe29b6de95d83e205d055669fb9cc102a20d9298',
  midpoint: 248.43998937785537,
  lower: 248.43997337785535,
  upper: 248.44000537785539,
  stateCount: 1430528
});

export const HISTORICAL = Object.freeze({
  rulesetId: 'kth-2012-implementation-compatible-v1',
  sourceCommit: '301ab6b3dad94a9bf1f75c495dd1505d235d1823',
  paperSha256: '64244ff3ad18e2fdfc1938e3aefb4bbd0e6fec32603ec248c745a6ee36c7d10b',
  reportedRoundedValue: 248.63,
  twoPairSinglePairFallback: true
});

export function assertCanonicalIdentity(manifest) {
  const failures = [];
  for (const [field, expected] of [
    ['rulesHash', CANONICAL.rulesHash],
    ['valuesSha256', CANONICAL.valuesHash],
    ['boundsSha256', CANONICAL.boundsHash],
    ['startingExpectedValue', CANONICAL.midpoint],
    ['startingLowerBound', CANONICAL.lower],
    ['startingUpperBound', CANONICAL.upper],
    ['stateCount', CANONICAL.stateCount]
  ]) if (manifest[field] !== expected) failures.push({ field, expected, actual: manifest[field] });
  if (failures.length) throw new Error('Fatal canonical identity mismatch: ' + JSON.stringify(failures));
  return true;
}
