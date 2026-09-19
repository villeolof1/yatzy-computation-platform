$ErrorActionPreference = 'Stop'
Set-Location (Resolve-Path (Join-Path $PSScriptRoot '..'))
node --version
npm --version
npm test
npm run preflight
npm run smoke
