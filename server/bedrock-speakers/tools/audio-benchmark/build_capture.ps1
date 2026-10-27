param([string]$Output = (Join-Path $env:TEMP 'bedrock-audio-benchmark'))
$ErrorActionPreference = 'Stop'
$taskVswhere = 'C:\Program Files (x86)\Microsoft Visual Studio\Installer\vswhere.exe'
$taskVs = & $taskVswhere -latest -products '*' -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
if (-not $taskVs) { throw 'A Visual C++ x64 toolchain is required.' }
$taskMsvc = (Get-ChildItem (Join-Path $taskVs 'VC\Tools\MSVC') -Directory | Sort-Object Name -Descending | Select-Object -First 1).FullName
$taskSdk = 'C:\Program Files (x86)\Windows Kits\10'
$taskSdkVersion = (Get-ChildItem (Join-Path $taskSdk 'Include') -Directory | Where-Object { Test-Path (Join-Path $_.FullName 'um\audioclientactivationparams.h') } | Sort-Object Name -Descending | Select-Object -First 1).Name
if (-not $taskSdkVersion) { throw 'A Windows SDK with process-loopback audio capture is required.' }
New-Item -ItemType Directory -Force $Output | Out-Null
$taskOldPath = $env:Path
try {
    $env:Path = "$taskMsvc\bin\Hostx64\x64;" + $env:Path
    & "$taskMsvc\bin\Hostx64\x64\cl.exe" /nologo /std:c++17 /EHsc /O2 /MT /D_WIN32_WINNT=0x0A00 /DNTDDI_VERSION=0x0A00000A `
        "/I$taskMsvc\include" "/I$taskSdk\Include\$taskSdkVersion\ucrt" "/I$taskSdk\Include\$taskSdkVersion\um" `
        "/I$taskSdk\Include\$taskSdkVersion\shared" "/I$taskSdk\Include\$taskSdkVersion\winrt" `
        "/Fo$Output\capture_process.obj" "/Fe$Output\capture_process.exe" (Join-Path $PSScriptRoot 'capture_process.cpp') `
        /link "/LIBPATH:$taskMsvc\lib\x64" "/LIBPATH:$taskSdk\Lib\$taskSdkVersion\ucrt\x64" `
        "/LIBPATH:$taskSdk\Lib\$taskSdkVersion\um\x64" ole32.lib mmdevapi.lib uuid.lib
    if ($LASTEXITCODE -ne 0) { throw "Capture build failed ($LASTEXITCODE)." }
} finally { $env:Path = $taskOldPath }
