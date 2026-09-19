# Implementation validation

The packaged v2 source was validated in a clean Linux container with Node.js v22.16.0 before distribution.

## Automated checks

- 9/9 Node test cases passed.
- All scientific preflight checks passed.
- Smoke reference value for the one-category Yatzy problem: `2.301432126285`.
- JavaScript syntax checking passed for every `.mjs` and browser `.js` file.
- Local server startup and status API were exercised.
- Interactive query API returned Yatzy = 50 when Yatzy was the only unused category.

## Full exact computation

A fresh complete solve was executed over all 1,430,528 reachable states.

```text
Starting expected value: 248.43998937785537
Value SHA-256: 59880282ab231bc87992d7e02751b4469525f2d73e555aea35ba63eadfc5a582
```

A second build using a different worker count produced identical midpoint and bounds hashes.

## End-to-end reduced pipeline

The complete one-button pipeline was executed with a reduced simulation configuration:

- 2 independently seeded optimal runs × 1,000 games;
- 5 comparison policies × 1,000 games;
- exact precomputation and deterministic rebuild;
- full verification;
- exact-state and simulation analysis;
- 18 SVG figures and 15 PNG figures;
- HTML evidence dossier and PDF fallback;
- audited research ZIP with 141 entries.

This reduced run validated orchestration, pause-safe persisted stages, simulations, analysis, dossier generation, and ZIP auditing. It is not presented as the final ten-million-game scientific result. The distributed defaults remain 10 × 1,000,000 optimal games and 1,000,000 games for each comparison policy.
