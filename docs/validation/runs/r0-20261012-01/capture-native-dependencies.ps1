[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0

# This helper owns only this run's dependency directory and named evidence files.
# It reads the installed cache, copies files without overwrite, and runs no build.
$runId = 'r0-20261012-01'
$workspace = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../../../..'))
$dependencyRoot = Join-Path $workspace '.build/native-reference/r0-20261012-01/dependencies'
$receiptPath = Join-Path $PSScriptRoot 'dependency-inputs.json'
$commandPath = Join-Path $PSScriptRoot 'dependency-capture-command.json'
$stdoutPath = Join-Path $PSScriptRoot 'dependency-capture.stdout.log'
$stderrPath = Join-Path $PSScriptRoot 'dependency-capture.stderr.log'
$installedSource = 'C:\Users\opsiclear\Desktop\projects\gaussian_splatting\SplatPreview\build\vcpkg_installed'
$vcpkgRoot = 'C:\Users\opsiclear\Desktop\projects\gaussian_splatting\vcpkg'
$vsRoot = 'C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools'
$sdkRoot = 'C:\Program Files (x86)\Windows Kits\10'
$expectedHead = '99a97de2cb371449d4fb9dc970f2ac562d689ec2'
$expectedPayloadHash = '9caf917746a5452e0ec258d39d2d4caa55fe5e636b0841a1d6d059aaa4c2f48b'
$expectedFiles = 158
$expectedBytes = 27443235L
$startedUtc = [DateTime]::UtcNow.ToString('o')
$timer = [Diagnostics.Stopwatch]::StartNew()
$nativeCommands = New-Object 'System.Collections.Generic.List[object]'
$payload = New-Object 'System.Collections.Generic.List[object]'
$metadata = New-Object 'System.Collections.Generic.List[object]'
$provenance = New-Object 'System.Collections.Generic.List[object]'
$toolInputs = New-Object 'System.Collections.Generic.List[object]'
$stdoutLines = New-Object 'System.Collections.Generic.List[string]'
$stderrLines = New-Object 'System.Collections.Generic.List[string]'
$gitBefore = $null
$gitAfter = $null
$sourceBeforeAggregate = $null
$destinationAggregate = $null
$sourceAfterAggregate = $null
$totalBytes = 0L
$result = 'failed'
$failure = $null
$exitCode = 1

function Write-NewUtf8([string]$Path, [string]$Text) {
    $stream = New-Object IO.FileStream($Path, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::Read)
    try {
        $bytes = (New-Object Text.UTF8Encoding($false)).GetBytes($Text)
        $stream.Write($bytes, 0, $bytes.Length)
    } finally { $stream.Dispose() }
}

function Get-InputState([string]$Path) {
    $item = Get-Item -LiteralPath $Path -Force
    if ($item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
        throw "Expected a regular file: $Path"
    }
    return [ordered]@{
        bytes = $item.Length
        sha256 = (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
        lastWriteUtc = $item.LastWriteTimeUtc.ToString('o')
    }
}

function Get-SafeChild([string]$Root, [string]$Relative) {
    if ([IO.Path]::IsPathRooted($Relative) -or $Relative -match '(^|[\\/])\.\.([\\/]|$)') {
        throw "Unsafe relative input: $Relative"
    }
    $absoluteRoot = [IO.Path]::GetFullPath($Root).TrimEnd('\', '/') + [IO.Path]::DirectorySeparatorChar
    $path = [IO.Path]::GetFullPath((Join-Path $Root $Relative))
    if (-not $path.StartsWith($absoluteRoot, [StringComparison]::OrdinalIgnoreCase)) {
        throw "Path escapes the declared root: $Relative"
    }
    return $path
}

function Copy-NewFile([string]$Source, [string]$Destination) {
    $before = Get-InputState $Source
    [IO.Directory]::CreateDirectory((Split-Path -Parent $Destination)) | Out-Null
    [IO.File]::Copy($Source, $Destination, $false)
    $copied = Get-InputState $Destination
    if ($before.sha256 -ne $copied.sha256 -or $before.bytes -ne $copied.bytes) {
        throw "Copy did not preserve input bytes: $Source"
    }
    return [ordered]@{
        sourcePath = $Source
        snapshotPath = $Destination
        operation = 'System.IO.File.Copy; overwrite=false'
        before = $before
        copied = $copied
        after = $null
    }
}

function Assert-Unchanged($Record) {
    $Record.after = Get-InputState $Record.sourcePath
    if ($Record.before.sha256 -ne $Record.after.sha256 -or $Record.before.bytes -ne $Record.after.bytes) {
        throw "Input changed during dependency capture: $($Record.sourcePath)"
    }
    if ($Record.Contains('snapshotPath')) {
        $Record.copied = Get-InputState $Record.snapshotPath
        if ($Record.before.sha256 -ne $Record.copied.sha256 -or $Record.before.bytes -ne $Record.copied.bytes) {
            throw "Captured file changed during dependency capture: $($Record.snapshotPath)"
        }
    }
}

function Invoke-ObservedNative([string]$Executable, [string[]]$Arguments) {
    $began = [DateTime]::UtcNow.ToString('o')
    $previousPreference = $ErrorActionPreference
    try {
        $ErrorActionPreference = 'Continue'
        $output = @(& $Executable @Arguments 2>&1 | ForEach-Object { $_.ToString() })
        $nativeExit = $LASTEXITCODE
    } finally { $ErrorActionPreference = $previousPreference }
    $nativeCommands.Add([ordered]@{
        executable = $Executable
        arguments = @($Arguments)
        workingDirectory = (Get-Location).Path
        startedUtc = $began
        completedUtc = [DateTime]::UtcNow.ToString('o')
        exitCode = $nativeExit
        output = @($output)
    })
    if ($nativeExit -ne 0) { throw "Observed native command failed: $Executable ($nativeExit)" }
    return ($output -join "`n").Trim()
}

function Get-PayloadAggregate([string]$Field) {
    $rows = New-Object 'System.Collections.Generic.List[string]'
    foreach ($entry in $payload) { $rows.Add($entry.relativePath + '=' + $entry[$Field].sha256) }
    $rows.Sort([StringComparer]::Ordinal)
    $text = ($rows -join "`n") + "`n"
    $sha = [Security.Cryptography.SHA256]::Create()
    try {
        return [BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($text))).Replace('-', '').ToLowerInvariant()
    } finally { $sha.Dispose() }
}

foreach ($path in @($dependencyRoot, $receiptPath, $commandPath, $stdoutPath, $stderrPath)) {
    if (Test-Path -LiteralPath $path) { throw "Refusing to overwrite existing capture output: $path" }
}

$process = Get-CimInstance Win32_Process -Filter "ProcessId = $PID"
$hostPath = (Get-Process -Id $PID).Path
$observedEntry = [ordered]@{
    executable = $hostPath
    argumentVector = @([Environment]::GetCommandLineArgs())
    processCommandLine = $process.CommandLine
    processId = $PID
    workingDirectory = (Get-Location).Path
    scriptPath = $PSCommandPath
    scriptSha256 = (Get-FileHash -LiteralPath $PSCommandPath -Algorithm SHA256).Hash.ToLowerInvariant()
    powerShellVersion = $PSVersionTable.PSVersion.ToString()
    startedUtc = $startedUtc
}

try {
    New-Item -ItemType Directory -Path $dependencyRoot -ErrorAction Stop | Out-Null
    $installedSnapshot = Join-Path $dependencyRoot 'vcpkg_installed'
    $gitExe = (Get-Command git.exe -CommandType Application | Select-Object -First 1).Source
    $gitBefore = [ordered]@{
        head = Invoke-ObservedNative $gitExe @('--no-optional-locks', '-C', $vcpkgRoot, 'rev-parse', 'HEAD')
        status = Invoke-ObservedNative $gitExe @('--no-optional-locks', '-C', $vcpkgRoot, 'status', '--short')
    }
    if ($gitBefore.head -ne $expectedHead -or $gitBefore.status -ne '') {
        throw 'The external vcpkg checkout no longer matches the validated clean revision.'
    }

    $listNames = @(
        'libdeflate_1.25_x64-windows-static.list',
        'libwebp_1.6.0_x64-windows-static.list',
        'nlohmann-json_3.12.0_x64-windows-static.list',
        'zlib_1.3.2_x64-windows-static.list',
        'zstd_1.5.7_x64-windows-static.list',
        'vcpkg-cmake_2024-04-23_x64-windows.list',
        'vcpkg-cmake-config_2024-05-23_x64-windows.list'
    )
    $seen = New-Object 'System.Collections.Generic.HashSet[string]' ([StringComparer]::Ordinal)
    foreach ($listName in $listNames) {
        $listRelative = 'vcpkg/info/' + $listName
        $listSource = Get-SafeChild $installedSource $listRelative
        $listCopy = Copy-NewFile $listSource (Get-SafeChild $installedSnapshot $listRelative)
        $metadata.Add($listCopy)
        if ($listName -notmatch '^(?<port>.+)_[^_]+_(?<triplet>x64-windows(?:-static)?)\.list$') {
            throw "Unexpected package list: $listName"
        }
        $packageName = $matches.port + '_' + $matches.triplet
        $packageRoot = Join-Path $vcpkgRoot ('packages/' + $packageName)
        foreach ($relative in [IO.File]::ReadAllLines($listCopy.snapshotPath)) {
            if ($relative.EndsWith('/')) { continue }
            if (-not $seen.Add($relative)) { continue }
            if ($relative -notmatch '^x64-windows(?:-static)?/') { throw "Unexpected payload prefix: $relative" }
            $sourceFile = Get-SafeChild $installedSource $relative
            $copy = Copy-NewFile $sourceFile (Get-SafeChild $installedSnapshot $relative)
            $packageRelative = $relative.Substring($relative.IndexOf('/') + 1)
            $packageFile = Get-SafeChild $packageRoot $packageRelative
            $packageBefore = Get-InputState $packageFile
            if ($packageBefore.sha256 -ne $copy.before.sha256 -or $packageBefore.bytes -ne $copy.before.bytes) {
                throw "Installed file differs from pinned package payload: $relative"
            }
            $copy.relativePath = $relative
            $copy.packageName = $packageName
            $copy.cachedPackagePath = $packageFile
            $copy.cachedPackageBefore = $packageBefore
            $copy.cachedPackageAfter = $null
            $payload.Add($copy)
            $totalBytes += $copy.before.bytes
        }
        foreach ($name in @('BUILD_INFO', 'CONTROL')) {
            $relative = 'provenance/packages/' + $packageName + '/' + $name
            $provenance.Add((Copy-NewFile (Join-Path $packageRoot $name) (Get-SafeChild $dependencyRoot $relative)))
        }
    }

    foreach ($relative in @('vcpkg/status', 'vcpkg/compiler-file-hash-cache.json')) {
        $metadata.Add((Copy-NewFile (Get-SafeChild $installedSource $relative) (Get-SafeChild $installedSnapshot $relative)))
    }
    foreach ($relative in @('scripts/buildsystems/vcpkg.cmake', 'triplets/x64-windows-static.cmake', 'scripts/buildsystems/msbuild/applocal.ps1', 'scripts/vcpkg-tool-metadata.txt')) {
        $provenance.Add((Copy-NewFile (Get-SafeChild $vcpkgRoot $relative) (Get-SafeChild $dependencyRoot ('provenance/vcpkg/' + $relative))))
    }
    $sourceBeforeAggregate = Get-PayloadAggregate 'before'
    $destinationAggregate = Get-PayloadAggregate 'copied'
    if ($payload.Count -ne $expectedFiles -or $totalBytes -ne $expectedBytes -or
        $sourceBeforeAggregate -ne $expectedPayloadHash -or $destinationAggregate -ne $expectedPayloadHash) {
        throw 'The captured dependency payload does not match the previously validated bounded manifest.'
    }

    $toolPaths = @(
        @('cmake', (Join-Path $vsRoot 'Common7/IDE/CommonExtensions/Microsoft/CMake/CMake/bin/cmake.exe')),
        @('ctest', (Join-Path $vsRoot 'Common7/IDE/CommonExtensions/Microsoft/CMake/CMake/bin/ctest.exe')),
        @('cl', (Join-Path $vsRoot 'VC/Tools/MSVC/14.44.35207/bin/Hostx64/x64/cl.exe')),
        @('link', (Join-Path $vsRoot 'VC/Tools/MSVC/14.44.35207/bin/Hostx64/x64/link.exe')),
        @('lib', (Join-Path $vsRoot 'VC/Tools/MSVC/14.44.35207/bin/Hostx64/x64/lib.exe')),
        @('dumpbin', (Join-Path $vsRoot 'VC/Tools/MSVC/14.44.35207/bin/Hostx64/x64/dumpbin.exe')),
        @('msbuild', (Join-Path $vsRoot 'MSBuild/Current/Bin/MSBuild.exe')),
        @('fxc', (Join-Path $sdkRoot 'bin/10.0.26100.0/x64/fxc.exe')),
        @('rc', (Join-Path $sdkRoot 'bin/10.0.26100.0/x64/rc.exe')),
        @('mt', (Join-Path $sdkRoot 'bin/10.0.26100.0/x64/mt.exe')),
        @('vcpkg', (Join-Path $vcpkgRoot 'vcpkg.exe')),
        @('git', $gitExe),
        @('capture-powershell', $hostPath)
    )
    $pwsh = Get-Command pwsh.exe -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($pwsh) { $toolPaths += ,@('applocal-powershell-candidate', $pwsh.Source) }
    foreach ($tool in $toolPaths) {
        $path = [IO.Path]::GetFullPath($tool[1])
        $toolInputs.Add([ordered]@{
            name = $tool[0]
            sourcePath = $path
            fileVersion = (Get-Item -LiteralPath $path).VersionInfo.FileVersion
            before = Get-InputState $path
            after = $null
        })
    }
    $cmakeVersion = Invoke-ObservedNative $toolPaths[0][1] @('--version')
    $ctestVersion = Invoke-ObservedNative $toolPaths[1][1] @('--version')

    foreach ($entry in $payload) {
        Assert-Unchanged $entry
        $entry.cachedPackageAfter = Get-InputState $entry.cachedPackagePath
        if ($entry.cachedPackageBefore.sha256 -ne $entry.cachedPackageAfter.sha256 -or
            $entry.cachedPackageBefore.bytes -ne $entry.cachedPackageAfter.bytes) {
            throw "Pinned package payload changed during capture: $($entry.cachedPackagePath)"
        }
    }
    foreach ($entry in $metadata) { Assert-Unchanged $entry }
    foreach ($entry in $provenance) { Assert-Unchanged $entry }
    foreach ($entry in $toolInputs) { Assert-Unchanged $entry }
    $sourceAfterAggregate = Get-PayloadAggregate 'after'
    $destinationAggregate = Get-PayloadAggregate 'copied'
    if ($sourceAfterAggregate -ne $expectedPayloadHash -or $destinationAggregate -ne $expectedPayloadHash) {
        throw 'The final source or destination dependency aggregate changed.'
    }
    $gitAfter = [ordered]@{
        head = Invoke-ObservedNative $gitExe @('--no-optional-locks', '-C', $vcpkgRoot, 'rev-parse', 'HEAD')
        status = Invoke-ObservedNative $gitExe @('--no-optional-locks', '-C', $vcpkgRoot, 'status', '--short')
    }
    if ($gitAfter.head -ne $gitBefore.head -or $gitAfter.status -ne $gitBefore.status) {
        throw 'The external vcpkg checkout changed during capture.'
    }
    $result = 'succeeded'
    $exitCode = 0
    $stdoutLines.Add("Captured $($payload.Count) dependency payload files ($totalBytes bytes).")
    $stdoutLines.Add("Payload SHA256: $destinationAggregate")
    $stdoutLines.Add("Installed dependency snapshot: $installedSnapshot")
    $stdoutLines.Add('All copied payloads match their cached package files; all recorded inputs remained unchanged.')
} catch {
    $failure = $_.Exception.ToString()
    $stderrLines.Add($failure)
} finally {
    $timer.Stop()
    $completedUtc = [DateTime]::UtcNow.ToString('o')
    $receipt = [ordered]@{
        schemaVersion = 1
        runId = $runId
        kind = 'bounded-native-dependency-snapshot'
        result = $result
        startedUtc = $startedUtc
        completedUtc = $completedUtc
        durationSeconds = $timer.Elapsed.TotalSeconds
        limitation = 'This captures the installed dependency payload and records selected external tool inputs. It does not establish full OS or toolchain reproducibility.'
        installedSourceRoot = $installedSource
        installedSnapshotRoot = (Join-Path $dependencyRoot 'vcpkg_installed')
        vcpkgRoot = $vcpkgRoot
        vcpkgBefore = $gitBefore
        vcpkgAfter = $gitAfter
        expected = [ordered]@{ fileCount = $expectedFiles; bytes = $expectedBytes; payloadSha256 = $expectedPayloadHash }
        observed = [ordered]@{
            fileCount = $payload.Count
            bytes = $totalBytes
            sourceBeforeSha256 = $sourceBeforeAggregate
            snapshotSha256 = $destinationAggregate
            sourceAfterSha256 = $sourceAfterAggregate
            aggregateEncoding = 'Ordinal-sort relative/path=lowercase_sha256 records; UTF-8 without BOM; LF after every record including the last.'
        }
        payload = @($payload.ToArray())
        metadata = @($metadata.ToArray())
        packageAndScriptProvenance = @($provenance.ToArray())
        externalTools = @($toolInputs.ToArray())
        observedEntryProcess = $observedEntry
        observedNativeCommands = @($nativeCommands.ToArray())
        failure = $failure
    }
    Write-NewUtf8 $receiptPath (($receipt | ConvertTo-Json -Depth 14) + "`n")
    $command = [ordered]@{
        schemaVersion = 1
        observedEntryProcess = $observedEntry
        observedNativeCommands = @($nativeCommands.ToArray())
        startedUtc = $startedUtc
        completedUtc = $completedUtc
        durationSeconds = $timer.Elapsed.TotalSeconds
        result = $result
        exitCode = $exitCode
        stdoutPath = $stdoutPath
        stderrPath = $stderrPath
        receiptPath = $receiptPath
    }
    Write-NewUtf8 $commandPath (($command | ConvertTo-Json -Depth 10) + "`n")
    Write-NewUtf8 $stdoutPath (($stdoutLines -join "`n") + "`n")
    Write-NewUtf8 $stderrPath (($stderrLines -join "`n") + "`n")
}
foreach ($line in $stdoutLines) { Write-Output $line }
foreach ($line in $stderrLines) { [Console]::Error.WriteLine($line) }
exit $exitCode
