[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidateNotNullOrEmpty()]
    [string]$OutputRoot
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'

$script:RequiredAcknowledgement = 'RUN REGISTERED FULL RESEARCH'

function Test-YatzySamePath {
    param([string]$Left, [string]$Right)
    return [string]::Equals(
        [IO.Path]::GetFullPath($Left).TrimEnd('\', '/'),
        [IO.Path]::GetFullPath($Right).TrimEnd('\', '/'),
        [StringComparison]::OrdinalIgnoreCase
    )
}

function Test-YatzyAncestorOrSame {
    param([string]$Ancestor, [string]$Candidate)
    $ancestorPath = [IO.Path]::GetFullPath($Ancestor).TrimEnd('\', '/')
    $candidatePath = [IO.Path]::GetFullPath($Candidate).TrimEnd('\', '/')
    if ([string]::Equals($ancestorPath, $candidatePath, [StringComparison]::OrdinalIgnoreCase)) { return $true }
    return $candidatePath.StartsWith($ancestorPath + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)
}

function Resolve-YatzySafeOutputRoot {
    param(
        [string]$Value,
        [string]$ProjectRoot
    )

    if ([string]::IsNullOrWhiteSpace($Value) -or $Value -ne $Value.Trim() -or $Value.Contains([char]0)) {
        throw 'Output root must be a nonempty, unambiguous absolute path.'
    }
    if ($Value -match '^(\\\\\?\\|\\\\\.\\|\\\?\?\\|\\\\)') {
        throw 'Device and network/UNC output roots are prohibited.'
    }
    if ($Value -notmatch '^[A-Za-z]:[\\/]') {
        throw 'Output root must be an absolute local-drive path.'
    }

    $rawRoot = [IO.Path]::GetPathRoot($Value)
    $components = $Value.Substring($rawRoot.Length) -split '[\\/]'
    foreach ($component in $components) {
        if (-not $component) { continue }
        if ($component -eq '.' -or $component -eq '..' -or $component -match '[<>:"|?*]' -or $component -match '[. ]$') {
            throw 'Output root contains an unsafe or ambiguous path component.'
        }
    }

    try { $resolved = [IO.Path]::GetFullPath($Value) }
    catch { throw 'Output root could not be normalized safely.' }
    $volumeRoot = [IO.Path]::GetPathRoot($resolved)
    if (Test-YatzySamePath $resolved $volumeRoot) { throw 'Output root may not be a filesystem or volume root.' }

    $project = [IO.Path]::GetFullPath($ProjectRoot)
    $outerWorkspace = [IO.Directory]::GetParent($project).FullName
    $userProfile = [Environment]::GetFolderPath([Environment+SpecialFolder]::UserProfile)
    if (Test-YatzyAncestorOrSame $resolved $userProfile) {
        throw 'Output root may not contain or equal the user profile.'
    }
    if (Test-YatzyAncestorOrSame $resolved $outerWorkspace) {
        throw 'Output root may not contain or equal the controlled outer workspace.'
    }
    if ((Test-YatzyAncestorOrSame $resolved $project) -or (Test-YatzyAncestorOrSame $project $resolved)) {
        throw 'Output root may not overlap the source repository.'
    }

    $current = $volumeRoot
    $relativeComponents = $resolved.Substring($volumeRoot.Length) -split '[\\/]'
    foreach ($component in $relativeComponents) {
        if (-not $component) { continue }
        $current = Join-Path $current $component
        if (-not (Test-Path -LiteralPath $current)) { break }
        try { $item = Get-Item -Force -LiteralPath $current }
        catch { throw 'Output-root containment could not be proven.' }
        if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
            throw 'Output root contains a symbolic link, junction, or reparse point.'
        }
        if (-not $item.PSIsContainer) { throw 'An existing output-root component is not a directory.' }
        if (-not (Test-YatzySamePath $current $item.FullName)) {
            throw 'Output root contains canonical redirection.'
        }
    }
    return $resolved
}

function Get-YatzyRegisteredWorkerConfiguration {
    function Read-BoundedWorkerValue {
        param([string]$Name, [int]$Default, [int]$Minimum, [int]$Maximum)
        $raw = [Environment]::GetEnvironmentVariable($Name, 'Process')
        if ([string]::IsNullOrEmpty($raw)) { return $Default }
        if ($raw -notmatch '^[1-9][0-9]*$') { throw "Invalid $Name; expected a positive base-10 integer." }
        $parsed = 0
        if (-not [int]::TryParse($raw, [ref]$parsed) -or $parsed -lt $Minimum -or $parsed -gt $Maximum) {
            throw "Invalid $Name; expected an integer from $Minimum through $Maximum."
        }
        return $parsed
    }

    $precomputation = Read-BoundedWorkerValue 'YATZY_WORKERS' 8 1 12
    $simulation = Read-BoundedWorkerValue 'YATZY_SIM_WORKERS' 5 1 8
    return [pscustomobject]@{
        Precomputation = $precomputation
        DeterministicRebuild = [Math]::Max(1, $precomputation - 1)
        Simulation = $simulation
    }
}

function Read-YatzyAcknowledgementWithTimeout {
    param(
        [string]$Prompt,
        [int]$TimeoutMilliseconds = 120000
    )
    Write-Host -NoNewline ($Prompt + ': ')
    $readTask = [Console]::In.ReadLineAsync()
    if (-not $readTask.Wait($TimeoutMilliseconds)) {
        throw 'Full registered research acknowledgement timed out; nothing was launched.'
    }
    return $readTask.Result
}

function Write-YatzyFullResearchWarning {
    param(
        [string]$ResolvedOutputRoot,
        [object]$Workers,
        [scriptblock]$MessageWriter
    )
    $messages = @(
        'Selected profile: registered-full-v3 (official full registered research).',
        "Resolved workers: $($Workers.Precomputation) precomputation, $($Workers.DeterministicRebuild) deterministic rebuild, $($Workers.Simulation) simulation.",
        'Fixed work includes 50,000 pilot games, 10 independent runs of 1,000,000 games, 100,000 historical-compatible games, comparisons, estimands, figures, dossier/evidence, archives, and clean-room checks.',
        'RESOURCE WARNING - Runtime: one registered environment recorded 1,276,639 ms of accounted work through final provenance. This excludes or precedes later work and is not a portable promise or upper bound.',
        'RESOURCE WARNING - CPU: sustained high CPU use is expected.',
        'RESOURCE WARNING - Memory: no portable peak-memory requirement is registered; the greater-than-512-MiB preflight admission check is not evidence of sufficient memory.',
        'RESOURCE WARNING - Storage: one official inventory recorded 5,351,003,729 bytes across 209 files, plus 525,519,169-byte and 173,444,454-byte archives. Peak staging and extraction needs are higher.',
        'RESOURCE WARNING - Large artifacts: one observed policy artifact was 1,081,479,296 bytes.',
        "OUTPUT ROOT: $ResolvedOutputRoot",
        "PROPOSED RUN DIRECTORY: a new official_<timestamp>_<process-id> directory beneath $ResolvedOutputRoot",
        'Use public-smoke-v1 for ordinary testing.'
    )
    foreach ($message in $messages) { & $MessageWriter $message }
}

function Invoke-YatzyFullResearchLauncher {
    param(
        [string]$RequestedOutputRoot,
        [string]$ProjectRoot,
        [scriptblock]$AcknowledgementReader = { param($Prompt) Read-YatzyAcknowledgementWithTimeout -Prompt $Prompt },
        [scriptblock]$NodeResolver = { (Get-Command node.exe -CommandType Application -ErrorAction Stop).Source },
        [scriptblock]$ChildInvoker = {
            param($Executable, $Arguments, $WorkingDirectory)
            Push-Location -LiteralPath $WorkingDirectory
            try {
                & $Executable @Arguments | Out-Host
                $childExitCode = $LASTEXITCODE
            } finally {
                Pop-Location
            }
            if ($null -eq $childExitCode) { return 1 }
            return [int]$childExitCode
        },
        [scriptblock]$MessageWriter = { param($Message) Write-Host $Message },
        [switch]$AllowRedirectedInputForTest
    )

    $resolvedRoot = Resolve-YatzySafeOutputRoot -Value $RequestedOutputRoot -ProjectRoot $ProjectRoot
    $workers = Get-YatzyRegisteredWorkerConfiguration
    try { $nodeExecutable = & $NodeResolver }
    catch { throw 'Node.js executable prerequisite is unavailable.' }
    if ([string]::IsNullOrWhiteSpace($nodeExecutable) -or -not [IO.Path]::IsPathRooted($nodeExecutable)) {
        throw 'Node.js executable prerequisite could not be resolved to an absolute path.'
    }

    Write-YatzyFullResearchWarning -ResolvedOutputRoot $resolvedRoot -Workers $workers -MessageWriter $MessageWriter
    if (-not $AllowRedirectedInputForTest -and [Console]::IsInputRedirected) {
        throw 'Redirected input cannot acknowledge the full registered research computation.'
    }
    $prompt = "Type exactly $script:RequiredAcknowledgement to continue"
    $confirmation = & $AcknowledgementReader $prompt
    if (-not [string]::Equals([string]$confirmation, $script:RequiredAcknowledgement, [StringComparison]::Ordinal)) {
        throw 'Full registered research was not acknowledged exactly; nothing was launched.'
    }

    $arguments = @(
        'engine/src/v3/cli.mjs',
        'official',
        '--output-root',
        $resolvedRoot,
        '--acknowledge-full-research'
    )
    $result = & $ChildInvoker -Executable $nodeExecutable -Arguments $arguments -WorkingDirectory $ProjectRoot
    if ($result -is [array]) { $result = $result[-1] }
    if ($null -eq $result) { return 1 }
    return [int]$result
}

if ($MyInvocation.InvocationName -ne '.') {
    try {
        $projectRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
        $exitCode = Invoke-YatzyFullResearchLauncher -RequestedOutputRoot $OutputRoot -ProjectRoot $projectRoot
        exit $exitCode
    } catch {
        Write-Error -ErrorRecord $_
        exit 1
    }
}
