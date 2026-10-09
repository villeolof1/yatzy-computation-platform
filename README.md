# Yatzy Computation Platform

This repository is the sanitized public repository for the Yatzy Computation Platform, an exact Swedish Yatzy solver and its reproducible research pipeline. It provides a bounded smoke/demo route, model and rules documentation, deterministic package tooling, and an explicitly acknowledged full registered-research route.

Release [v3.0.0](https://github.com/villeolof1/yatzy-computation-platform/releases/tag/v3.0.0) was published on 2026-09-20 and deposited on Zenodo with software version DOI [10.5281/zenodo.22858643](https://doi.org/10.5281/zenodo.22858643). The Zenodo software record also reports a Software Heritage capture. The public repository is [villeolof1/yatzy-computation-platform](https://github.com/villeolof1/yatzy-computation-platform).

The release/root commit `0b93de080a711adfa54a57f6922834f81938ae24` is a sanitized public identity, distinct from the historical registered/private research source. The public release does not publish the complete private Git history or preserve its original commit ancestry. Later documentation updates do not change the frozen v3.0.0 tag, release assets, or archival deposit.

## Safe quick start

Node.js 22.5 or newer is required. The checked-in package has no external npm dependencies.

Run the bounded smoke profile first:

```powershell
npm run smoke
```

It runs scientific preflight and one deterministic reference query. A successful run reports `2.301432126285`; it does not start full-game simulation, precomputation workers, analysis, rendering, or archive generation.

To run the test suite and local interface:

```powershell
npm test
npm run preflight
npm start
```

Open <http://127.0.0.1:4317> and select **Run bounded public smoke/demo**. Bare CLI, the generic npm pipeline, browser, and `scripts/start-windows.bat` all default to the bounded `public-smoke-v1` profile. The browser cannot launch full research.

## Registered full research

Full registered research is intentionally not a default. It performs complete precomputation and deterministic rebuilds, large simulations, analysis, figures, dossier/evidence generation, archives, and clean-room checks. Expect sustained CPU use and substantial storage; no portable runtime or peak-memory promise is made.

Expert noninteractive invocation requires an explicit safe output root and the acknowledgement flag:

```powershell
npm run pipeline:official -- --output-root C:\yatzy-output --acknowledge-full-research
```

The interactive Windows launcher displays the registered workload and resource warnings, then requires the exact typed phrase `RUN REGISTERED FULL RESEARCH`:

```powershell
powershell -NoProfile -File .\scripts\run-complete-research.ps1 -OutputRoot C:\yatzy-output
```

Use a fresh local output path that you own and that does not overlap the repository or user profile. Missing acknowledgement, redirected input, or an unsafe output root is refused before the full workload starts. `pipeline:reduced` is a noncanonical development route and does not reproduce the registered result.

## Reproducibility and package integrity

See [REPRODUCIBILITY.md](REPRODUCIBILITY.md) for verified smoke, package-build, package-verification, and full-research boundaries.

A built public package contains two current integrity/provenance files:

- `PUBLIC_PACKAGE_MANIFEST.json` records the packaged payload paths, byte lengths, hashes, and packaged-source identity.
- `PUBLIC_PROVENANCE.json` records that packaged-source identity, the manifest identity, scientific identities, an allowlisted environment description, and the rights boundary.

`SOURCE_CHECKSUMS.sha256` records historical registered-source evidence. It is not the live integrity manifest for the sanitized/current public checkout. Use the current release/package manifest and public provenance metadata for current packaged-release verification. Do not regenerate `SOURCE_CHECKSUMS.sha256` to make it describe the current checkout.

## Scientific identity

The canonical result follows `swedish-alga-free-order-v1`, including the rule that Two Pairs requires two distinct face values. The historical 248.63 implementation-compatibility result is documented separately and is not used by the canonical pipeline. Scientific claims and numerical limitations are described in `SCIENTIFIC_ESTIMANDS.md` and the `docs/` records.

## Rights, attribution, and sanitization

Author-owned software and documentation are licensed under the [MIT License](LICENSE), copyright 2026 Ville Wedenberg. The isolated 27-path historical Java subtree retains its original MIT notice and attribution; see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

CC BY 4.0 applies only to original, rights-cleared, privacy-clean selected research data where that license is explicitly stated. It does not apply to software by implication. The public source/package excludes two third-party PDFs, private repositories and materials, and the removed autostart install/uninstall scripts. Nothing excluded or separately attributed is relicensed by this repository.

## Citation

Use [CITATION.cff](CITATION.cff) to cite Ville Wedenberg's *Yatzy Computation Platform*, version 3.0.0, released 2026-09-20, with software version DOI [10.5281/zenodo.22858643](https://doi.org/10.5281/zenodo.22858643). The GitHub tag and Zenodo version label are `v3.0.0`.

## Related research dataset

[*Swedish free-order Yatzy: canonical solution and research data*](https://doi.org/10.5281/zenodo.23141334), version 3.0.0, was published on 2026-10-07 under CC BY 4.0. This dataset supplements the MIT-licensed software and should be cited separately when used.

The dataset contains selected research data, not every historical or raw research artifact. It excludes the final raw ten-million-game records; earlier registered simulation populations are not substitutes for those missing records. The bounded smoke check does not reproduce the full scientific paper or the complete registered research results.

## Historical simulation correction

The v2.0.3 simulation correction seeded all four words of the per-game xorshift128 state and replaced modulo reduction with rejection sampling. `docs/SIMULATION_RNG_CORRECTION.md` records the affected behavior and validation context.
