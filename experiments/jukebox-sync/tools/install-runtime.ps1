$ErrorActionPreference = 'Stop'
$labRoot = Split-Path -Parent $PSScriptRoot
$runtimeRoot = Join-Path $labRoot '.runtime'
$archive = Join-Path $runtimeRoot 'java25.zip'
$runtimeName = 'zulu25.38.107-ca-jre25.0.5-win_x64'
$expectedHash = '0aee5f9816045d4f33207f266102d25ac7ab83b24506798130f8649d01196aac'
# Pinned publisher metadata: https://api.azul.com/metadata/v1/zulu/packages/679c7eb0-dbc2-4869-843c-f51b78c8b219
New-Item -ItemType Directory -Force $runtimeRoot | Out-Null
if (!(Test-Path -LiteralPath $archive) -or (Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash -ne $expectedHash) {
    & curl.exe -fL --silent --show-error "https://cdn.azul.com/zulu/bin/$runtimeName.zip" -o $archive
    if ($LASTEXITCODE -ne 0) { throw 'Runtime download failed' }
}
if ((Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash -ne $expectedHash) {
    throw 'Runtime checksum mismatch'
}
$javaExecutable = Join-Path $runtimeRoot "$runtimeName/bin/java.exe"
if (!(Test-Path -LiteralPath $javaExecutable)) {
    Expand-Archive -LiteralPath $archive -DestinationPath $runtimeRoot -Force
}
Write-Output "Local runtime ready: $javaExecutable"
