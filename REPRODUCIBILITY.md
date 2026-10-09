# Reproducibility and package verification

This document separates the bounded smoke check, current packaged-release verification, and the full registered research workload. They establish different things and should not be presented as interchangeable.

## Environment

Use Node.js 22.5 or newer. The package metadata declares no external npm dependencies. Public provenance records only allowlisted environment fields: Node version, operating-system family, architecture, and logical core count.

## Bounded smoke reproducibility

Run:

```powershell
npm run smoke
```

The `public-smoke-v1` profile performs scientific preflight and one deterministic reference query. Success reports:

```text
2.301432126285
```

This check launches no precomputation or simulation workers and creates no research payload. It does not reproduce the full-game expected value, simulations, figures, dossier, or archives.

## Build and verify the sanitized package

Choose a fresh local output root and run:

```powershell
node engine/src/v3/cli.mjs public-package --output-root C:\yatzy-package-build
Push-Location C:\yatzy-package-build\public-source-package
node engine/src/v3/cli.mjs verify-public-package
Pop-Location
```

The build copies only the reviewed public allowlist and writes:

- `PUBLIC_PACKAGE_MANIFEST.json`, the live integrity manifest for the packaged payload;
- `PUBLIC_PROVENANCE.json`, the public packaged-source, scientific-identity, environment, and rights-boundary record.

Verification recomputes the package identity and checks every governed payload entry. Deterministic package reproduction has been demonstrated at different absolute roots and from a generated source root without `.git`. A local build from later documentation commits has different payload bytes and must not be treated as the published v3.0.0 package. Verify the published artifacts against their frozen release metadata; do not rebuild or replace them to incorporate documentation updates.

## Historical registered-source evidence

`SOURCE_CHECKSUMS.sha256` records historical registered-source evidence. It is not the live integrity manifest for the sanitized/current public checkout. Use the current release/package manifest and public provenance metadata for current packaged-release verification.

`SOURCE_CHECKSUMS.sha256` is deliberately frozen. Do not regenerate or modify it to make it current.

## Full registered research

Full research is explicit, computationally substantial, and not part of the bounded smoke or package-verification commands. Noninteractive expert invocation is:

```powershell
npm run pipeline:official -- --output-root C:\yatzy-output --acknowledge-full-research
```

On Windows, the interactive launcher displays the fixed workload and resource warnings and requires the exact typed phrase `RUN REGISTERED FULL RESEARCH`:

```powershell
powershell -NoProfile -File .\scripts\run-complete-research.ps1 -OutputRoot C:\yatzy-output
```

The output root must be an explicitly supplied, safe local path owned by the user and must not overlap the source repository or user profile. The browser cannot launch or acknowledge full research. See `engine/test/fixtures/registered-full-profile.json` and `docs/ANALYSIS_AND_RESEARCH_PLAN.md` for the frozen scientific configuration and workload description.

## Release status

Release [v3.0.0](https://github.com/villeolof1/yatzy-computation-platform/releases/tag/v3.0.0) was published on 2026-09-20. Its Zenodo software version DOI is [10.5281/zenodo.22858643](https://doi.org/10.5281/zenodo.22858643), and the Zenodo record reports a Software Heritage capture. These software publication records do not establish preprint or journal publication.

The release/root commit `0b93de080a711adfa54a57f6922834f81938ae24` identifies the sanitized public release, not the historical registered/private research commit. The public repository does not include the complete private Git history, preserve its original ancestry, or make all historical research artifacts public. The published tag, assets, and archival deposit remain frozen independently of current documentation.

The related dataset, [*Swedish free-order Yatzy: canonical solution and research data*](https://doi.org/10.5281/zenodo.23141334), version 3.0.0, was published on 2026-10-07 under CC BY 4.0. It contains selected research data and excludes the final raw ten-million-game records. Earlier registered simulation populations do not substitute for those missing records. Neither dataset availability nor a successful bounded smoke check establishes reproduction of the full scientific paper.
