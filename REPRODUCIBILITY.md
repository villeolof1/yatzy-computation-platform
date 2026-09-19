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

Verification recomputes the package identity and checks every governed payload entry. Deterministic package reproduction has been demonstrated at different absolute roots and from a generated source root without `.git`; a new candidate must establish its own exact identities rather than reuse older hashes.

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

This repository is a release candidate. These instructions do not mean that a public Git release, archival deposit, DOI, Software Heritage capture, preprint, or journal publication exists.
