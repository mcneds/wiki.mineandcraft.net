param(
    [int]$Rounds = 20,
    [int]$StressThreads = 0,
    [switch]$Baseline,
    [switch]$Full,
    [switch]$Network,
    [switch]$NativeChecks,
    [string]$Java = '',
    [string]$RunName = 'measurement'
)
$ErrorActionPreference = 'Stop'
$labRoot = Split-Path -Parent $PSScriptRoot
if (!$Java) {
    $localJava = Join-Path $labRoot '.runtime/zulu25.38.107-ca-jre25.0.5-win_x64/bin/java.exe'
    $Java = if (Test-Path -LiteralPath $localJava) { $localJava } else { 'java' }
}
$environmentKeys = @('SYNCLAB_ROUNDS', 'SYNCLAB_STRESS', 'SYNCLAB_FULL', 'SYNCLAB_RUN', 'SYNCLAB_NETWORK')
$previousEnvironment = @{}
foreach ($key in $environmentKeys) { $previousEnvironment[$key] = [Environment]::GetEnvironmentVariable($key, 'Process') }
Push-Location $labRoot
try {
    $gradleArguments = @('prepareLabClient')
    if ($Baseline) { $gradleArguments += '-Pbaseline' }
    # Windows PowerShell 5 treats redirected native stderr warnings as errors.
    $ErrorActionPreference = 'Continue'
    & ./gradlew.bat @gradleArguments
    $ErrorActionPreference = 'Stop'
    if ($LASTEXITCODE -ne 0) { throw 'Lab build failed.' }
    $env:SYNCLAB_ROUNDS = [string]$Rounds
    $env:SYNCLAB_STRESS = [string]$StressThreads
    $env:SYNCLAB_FULL = $Full.IsPresent.ToString().ToLowerInvariant()
    $env:SYNCLAB_RUN = $RunName
    $env:SYNCLAB_NETWORK = $Network.IsPresent.ToString().ToLowerInvariant()
    $ErrorActionPreference = 'Continue'
    $javaArguments = @()
    if ($NativeChecks) { $javaArguments += '-Xcheck:jni' }
    & $Java @javaArguments '@build/ide-vm.args' net.fabricmc.devlaunchinjector.Main
    $ErrorActionPreference = 'Stop'
    if ($LASTEXITCODE -ne 0) { throw 'Client experiment failed. See logs/latest.log.' }
    & python tools/summarize.py "results/$RunName.json"
    if ($LASTEXITCODE -ne 0) { throw 'Report validation failed.' }
} finally {
    foreach ($key in $environmentKeys) { [Environment]::SetEnvironmentVariable($key, $previousEnvironment[$key], 'Process') }
    Pop-Location
}
