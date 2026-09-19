# Yatzy Computation Platform

This repository is a sanitized public release candidate for an exact Swedish Yatzy solver and its reproducible research pipeline. It provides a bounded smoke/demo route, model and rules documentation, deterministic package tooling, and an explicitly acknowledged full registered-research route.

This candidate has been prepared for public release but has not yet been published, tagged, deposited, assigned a DOI, or archived with Software Heritage.

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

Use `CITATION.cff` to cite this software without inventing a DOI or publication record. The citation metadata names Ville Wedenberg and intentionally contains no DOI, ORCID, journal, archive identifier, or public release URL.

## Historical simulation correction

The v2.0.3 simulation correction seeded all four words of the per-game xorshift128 state and replaced modulo reduction with rejection sampling. `docs/SIMULATION_RNG_CORRECTION.md` records the affected behavior and validation context.
