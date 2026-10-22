[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0
$workspace = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../../../..'))
$sourceRoot = Join-Path $workspace 'reference/targets/windows-r0-20261012-02/source'
$captureManifestPath = Join-Path (Split-Path -Parent $sourceRoot) 'CAPTURE_MANIFEST.json'
$captureStatusPath = Join-Path (Split-Path -Parent $sourceRoot) 'CAPTURE_STATUS.json'
$dependencyReceiptPath = Join-Path $PSScriptRoot 'dependency-inputs.json'
$buildRoot = Join-Path $workspace '.build/native-reference/r0-20261012-01/build'
$outcomePath = Join-Path $PSScriptRoot 'native-attempt03-outcome.json'
$vsRoot = 'C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools'
$vcpkgRoot = 'C:\Users\opsiclear\Desktop\projects\gaussian_splatting\vcpkg'
$cmakeExe = Join-Path $vsRoot 'Common7/IDE/CommonExtensions/Microsoft/CMake/CMake/bin/cmake.exe'
$ctestExe = Join-Path $vsRoot 'Common7/IDE/CommonExtensions/Microsoft/CMake/CMake/bin/ctest.exe'
$powershellExe = 'C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe'
$fxcExe = 'C:\Program Files (x86)\Windows Kits\10\bin\10.0.26100.0\x64\fxc.exe'
$testFilter = '^(SelectionMorphologyContracts|ExportFormatContracts|InputFormatContracts|ViewCommandPolicyContracts|CliOutputContracts|SettingsContracts|ToolsModeContracts|LanguageContracts)$'
$targets = @('SplatView', 'SplatViewSelectionMorphologyTests', 'SplatViewExportFormatTests',
    'SplatViewInputFormatTests', 'SplatViewCommandPolicyTests', 'SplatViewToolsTests',
    'SplatViewModeTests', 'SplatViewLanguageTests', 'SplatViewFixtureGenerator')
$startedUtc = [DateTime]::UtcNow.ToString('o')
$timer = [Diagnostics.Stopwatch]::StartNew()
$commands = New-Object 'System.Collections.Generic.List[object]'
$externalInputs = New-Object 'System.Collections.Generic.List[object]'
$artifacts = New-Object 'System.Collections.Generic.List[object]'
$sourceBefore = $null
$sourceAfter = $null
$dependenciesBefore = $null
$dependenciesAfter = $null
$result = 'failed'
$failure = $null
$exitCode = 1
$stage = 'preflight'
$capture = $null
$dependencyReceipt = $null
$discoveredTests = $null
$originalVcpkg = $env:VCPKG_ROOT

function Write-NewUtf8([string]$Path, [string]$Text) {
    $stream = New-Object IO.FileStream($Path, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::Read)
    try {
        $bytes = (New-Object Text.UTF8Encoding($false)).GetBytes($Text)
        $stream.Write($bytes, 0, $bytes.Length)
    } finally { $stream.Dispose() }
}

function Get-State([string]$Path) {
    $file = Get-Item -LiteralPath $Path -Force
    if ($file.PSIsContainer -or ($file.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw "Expected regular input file: $Path" }
    return [ordered]@{ bytes = $file.Length; sha256 = (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant() }
}

function Get-SafeChild([string]$Root, [string]$Relative) {
    if ([IO.Path]::IsPathRooted($Relative) -or $Relative -match '(^|[\\/])\.\.([\\/]|$)') { throw "Unsafe relative path: $Relative" }
    $rootPrefix = [IO.Path]::GetFullPath($Root).TrimEnd('\', '/') + [IO.Path]::DirectorySeparatorChar
    $path = [IO.Path]::GetFullPath((Join-Path $Root $Relative))
    if (-not $path.StartsWith($rootPrefix, [StringComparison]::OrdinalIgnoreCase)) { throw "Path escapes root: $Relative" }
    return $path
}

function Test-CapturedSource {
    $manifestState = Get-State $captureManifestPath
    $statusState = Get-State $captureStatusPath
    $manifest = Get-Content -LiteralPath $captureManifestPath -Raw | ConvertFrom-Json
    $status = Get-Content -LiteralPath $captureStatusPath -Raw | ConvertFrom-Json
    if ($status.state -ne 'complete' -or $status.manifestSha256 -ne $manifestState.sha256 -or
        $manifest.treeSha256 -ne '162c4bb2b129dc49169b3678e21b1b607a13bfd249f75cb1a2b3a5b7e8e9a2f4' -or
        $status.treeSha256 -ne $manifest.treeSha256 -or $status.captureId -ne $manifest.captureId) {
        throw 'Source capture status/identity is inconsistent with the authorized capture02.'
    }
    $count = 0
    $bytes = 0L
    foreach ($entry in $manifest.files) {
        $state = Get-State (Get-SafeChild $sourceRoot $entry.path)
        if ($state.sha256 -ne $entry.sha256 -or $state.bytes -ne $entry.bytes) { throw "Captured source file changed: $($entry.path)" }
        $count++
        $bytes += $state.bytes
    }
    if ($count -ne $manifest.fileCount -or $bytes -ne $manifest.totalBytes) { throw 'Source manifest file count/bytes are inconsistent.' }
    return [ordered]@{ validatedUtc = [DateTime]::UtcNow.ToString('o'); captureId = $manifest.captureId;
        treeSha256 = $manifest.treeSha256; manifest = $manifestState; status = $statusState;
        filesChecked = $count; bytesChecked = $bytes; allManifestFilesMatch = $true }
}

function Test-CapturedDependencies {
    $rows = New-Object 'System.Collections.Generic.List[string]'
    $bytes = 0L
    foreach ($entry in $dependencyReceipt.payload) {
        $state = Get-State $entry.snapshotPath
        if ($state.sha256 -ne $entry.copied.sha256 -or $state.bytes -ne $entry.copied.bytes) { throw "Captured dependency changed: $($entry.relativePath)" }
        $rows.Add($entry.relativePath + '=' + $state.sha256)
        $bytes += $state.bytes
    }
    $rows.Sort([StringComparer]::Ordinal)
    $sha = [Security.Cryptography.SHA256]::Create()
    try { $hash = [BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes(($rows -join "`n") + "`n"))).Replace('-', '').ToLowerInvariant() }
    finally { $sha.Dispose() }
    if ($rows.Count -ne 158 -or $bytes -ne 27443235L -or $hash -ne $dependencyReceipt.expected.payloadSha256) { throw 'Dependency payload identity mismatch.' }
    return [ordered]@{ validatedUtc = [DateTime]::UtcNow.ToString('o'); filesChecked = $rows.Count; bytesChecked = $bytes; payloadSha256 = $hash }
}

function Invoke-RecordedCommand([string]$Name, [string]$Executable, [string[]]$Arguments, [string]$WorkingDirectory) {
    $Name = $Name.Replace('native-', 'native-attempt03-')
    $logPath = Join-Path $PSScriptRoot ($Name + '.log')
    $recordPath = Join-Path $PSScriptRoot ($Name + '.command.json')
    if ((Test-Path -LiteralPath $logPath) -or (Test-Path -LiteralPath $recordPath)) { throw "Refusing existing command evidence: $Name" }
    $stream = New-Object IO.FileStream($logPath, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::ReadWrite)
    $writer = New-Object IO.StreamWriter($stream, (New-Object Text.UTF8Encoding($false)))
    $writer.AutoFlush = $true
    $oldLocation = Get-Location
    $oldPreference = $ErrorActionPreference
    $commandStart = [DateTime]::UtcNow.ToString('o')
    $watch = [Diagnostics.Stopwatch]::StartNew()
    $nativeExit = $null
    try {
        Set-Location -LiteralPath $WorkingDirectory
        $ErrorActionPreference = 'Continue'
        & $Executable @Arguments 2>&1 | ForEach-Object {
            $line = $_.ToString()
            $writer.WriteLine($line)
            Write-Output $line
        }
        $nativeExit = $LASTEXITCODE
    } finally {
        $ErrorActionPreference = $oldPreference
        Set-Location -LiteralPath $oldLocation.Path
        $writer.Dispose()
        $watch.Stop()
        $record = [ordered]@{ name = $Name; executable = $Executable; executableSha256 = (Get-State $Executable).sha256;
            arguments = @($Arguments); workingDirectory = $WorkingDirectory; startedUtc = $commandStart;
            completedUtc = [DateTime]::UtcNow.ToString('o'); durationSeconds = $watch.Elapsed.TotalSeconds;
            exitCode = $nativeExit; mergedOutputLog = $logPath; mergedOutputLogSha256 = (Get-State $logPath).sha256 }
        Write-NewUtf8 $recordPath (($record | ConvertTo-Json -Depth 8) + "`n")
        $commands.Add($record)
    }
    if ($null -eq $nativeExit -or $nativeExit -ne 0) { throw "Native command $Name failed with exit code $nativeExit. Evidence: $recordPath" }
}

if (Test-Path -LiteralPath $outcomePath) { throw "Refusing existing outcome: $outcomePath" }
if (-not (Test-Path -LiteralPath (Join-Path $buildRoot 'CMakeCache.txt'))) { throw 'The retry requires the preserved first-attempt build tree.' }
$process = Get-CimInstance Win32_Process -Filter "ProcessId = $PID"
$parentProcess = Get-CimInstance Win32_Process -Filter "ProcessId = $($process.ParentProcessId)"
$observedEntry = [ordered]@{ executable = (Get-Process -Id $PID).Path; argumentVector = @([Environment]::GetCommandLineArgs());
    processCommandLine = $process.CommandLine; processId = $PID; workingDirectory = (Get-Location).Path;
    scriptPath = $PSCommandPath; scriptSha256 = (Get-State $PSCommandPath).sha256; powerShellVersion = $PSVersionTable.PSVersion.ToString();
    parentProcessId = $process.ParentProcessId; parentExecutable = $parentProcess.ExecutablePath; parentCommandLine = $parentProcess.CommandLine }
$buildEnvironment = [ordered]@{}
foreach ($name in @('CL', '_CL_', 'LINK', '_LINK_', 'CFLAGS', 'CXXFLAGS', 'CC', 'CXX', 'CMAKE_PREFIX_PATH', 'CMAKE_TOOLCHAIN_FILE', 'PATH', 'INCLUDE', 'LIB', 'LIBPATH')) {
    $value = [Environment]::GetEnvironmentVariable($name, 'Process')
    $buildEnvironment[$name] = $value
    if ($name -in @('CL', '_CL_', 'LINK', '_LINK_', 'CFLAGS', 'CXXFLAGS', 'CC', 'CXX', 'CMAKE_PREFIX_PATH', 'CMAKE_TOOLCHAIN_FILE') -and -not [string]::IsNullOrEmpty($value)) {
        throw "An unpinned compiler/configuration environment override is present: $name"
    }
}

try {
    $capture = Get-Content -LiteralPath $captureManifestPath -Raw | ConvertFrom-Json
    $dependencyReceipt = Get-Content -LiteralPath $dependencyReceiptPath -Raw | ConvertFrom-Json
    if ($dependencyReceipt.result -ne 'succeeded') { throw 'The dependency capture receipt did not succeed.' }
    $sourceBefore = Test-CapturedSource
    $dependenciesBefore = Test-CapturedDependencies
    foreach ($entry in @($dependencyReceipt.externalTools) + @($dependencyReceipt.packageAndScriptProvenance | Where-Object { $_.sourcePath.StartsWith($vcpkgRoot + '\scripts\') -or $_.sourcePath.StartsWith($vcpkgRoot + '\triplets\') })) {
        $state = Get-State $entry.sourcePath
        if ($state.sha256 -ne $entry.before.sha256) { throw "Recorded external tool input changed: $($entry.sourcePath)" }
        $externalInputs.Add([ordered]@{ sourcePath = $entry.sourcePath; before = $state; after = $null })
    }
    $env:VCPKG_ROOT = $vcpkgRoot
    $buildEnvironment.VCPKG_ROOT = $vcpkgRoot
    $buildEnvironment.VCPKG_INSTALLED_DIR = $dependencyReceipt.installedSnapshotRoot
    $developerInputs = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'native-developer-environment.inputs.json') -Raw | ConvertFrom-Json
    foreach ($entry in $developerInputs.inputs) {
        $state = Get-State $entry.path
        if ($state.sha256 -ne $entry.beforeSha256) { throw "Developer/PDB input changed before retry: $($entry.path)" }
        $externalInputs.Add([ordered]@{ sourcePath = $entry.path; before = $state; after = $null })
    }
    $stage = 'configure'
    $configureArguments = @('--preset', 'win-release', '-S', $sourceRoot, '-B', $buildRoot,
        '-T', 'v143,host=x64,version=14.44.35207', "-DCMAKE_GENERATOR_INSTANCE:PATH=$vsRoot",
        '-DCMAKE_SYSTEM_VERSION:STRING=10.0.26100.0', "-DSPLATVIEW_FXC:FILEPATH=$fxcExe",
        "-DVCPKG_INSTALLED_DIR:PATH=$($dependencyReceipt.installedSnapshotRoot)", '-DVCPKG_MANIFEST_INSTALL:BOOL=OFF',
        '-DVCPKG_TARGET_TRIPLET:STRING=x64-windows-static', '-DBUILD_TESTING:BOOL=ON',
        '-DSPLATVIEW_BUILD_BENCHMARKS:BOOL=OFF', '-DSPLATVIEW_ENABLE_ASAN:BOOL=OFF',
        '-DCMAKE_FIND_USE_PACKAGE_REGISTRY:BOOL=OFF', '-DCMAKE_FIND_USE_SYSTEM_PACKAGE_REGISTRY:BOOL=OFF',
        "-DZ_VCPKG_POWERSHELL_PATH:FILEPATH=$powershellExe",
        '-DCMAKE_C_FLAGS_DEBUG:STRING=/Z7 /Ob0 /Od /RTC1',
        '-DCMAKE_CXX_FLAGS_DEBUG:STRING=/Z7 /Ob0 /Od /RTC1')
    Invoke-RecordedCommand 'native-configure' $cmakeExe $configureArguments $sourceRoot
    $cache = @{}
    foreach ($line in [IO.File]::ReadAllLines((Join-Path $buildRoot 'CMakeCache.txt'))) {
        if ($line -match '^([^#/:][^:]*):[^=]+=(.*)$') { $cache[$matches[1]] = $matches[2] }
    }
    if ($cache.BUILD_TESTING -ne 'ON' -or $cache.SPLATVIEW_BUILD_BENCHMARKS -ne 'OFF' -or
        $cache.VCPKG_MANIFEST_INSTALL -ne 'OFF' -or $cache.VCPKG_TARGET_TRIPLET -ne 'x64-windows-static' -or
        [IO.Path]::GetFullPath($cache.CMAKE_HOME_DIRECTORY) -ine [IO.Path]::GetFullPath($sourceRoot) -or
        [IO.Path]::GetFullPath($cache.VCPKG_INSTALLED_DIR) -ine [IO.Path]::GetFullPath($dependencyReceipt.installedSnapshotRoot)) {
        throw 'Generated CMake cache differs from the requested source/dependency/configuration pins.'
    }
    $stage = 'build'
    $binaryLogPath = Join-Path $PSScriptRoot 'native-attempt03-build.binlog'
    if (Test-Path -LiteralPath $binaryLogPath) { throw 'Refusing existing MSBuild binary log.' }
    $buildArguments = @('--build', $buildRoot, '--config', 'Release', '--parallel', '6', '--target') + $targets + @('--', "/bl:$binaryLogPath")
    Invoke-RecordedCommand 'native-build' $cmakeExe $buildArguments $sourceRoot
    $stage = 'test-discovery'
    Invoke-RecordedCommand 'native-ctest-discovery' $ctestExe @('--test-dir', $buildRoot, '-C', 'Release', '--show-only=json-v1', '-R', $testFilter) $sourceRoot
    $discoveredTests = (Get-Content -LiteralPath (Join-Path $PSScriptRoot 'native-attempt03-ctest-discovery.log') -Raw | ConvertFrom-Json).tests
    $stage = 'test'
    $junitPath = Join-Path $PSScriptRoot 'native-attempt03-ctest.junit.xml'
    if (Test-Path -LiteralPath $junitPath) { throw 'Refusing existing CTest JUnit evidence.' }
    Invoke-RecordedCommand 'native-ctest' $ctestExe @('--test-dir', $buildRoot, '-C', 'Release', '--output-on-failure',
        '--no-tests=error', '--parallel', '1', '--output-junit', $junitPath, '-R', $testFilter) $sourceRoot
    $result = 'succeeded'
    $exitCode = 0
} catch {
    $failure = $_.Exception.ToString()
    [Console]::Error.WriteLine($failure)
} finally {
    try {
        if ($capture) { $sourceAfter = Test-CapturedSource }
        if ($dependencyReceipt) { $dependenciesAfter = Test-CapturedDependencies }
        foreach ($entry in $externalInputs) {
            $entry.after = Get-State $entry.sourcePath
            if ($entry.before.sha256 -ne $entry.after.sha256 -or $entry.before.bytes -ne $entry.after.bytes) { throw "External tool input changed during native validation: $($entry.sourcePath)" }
        }
        foreach ($target in $targets) {
            $path = Join-Path $buildRoot ('Release/' + $target + '.exe')
            if (Test-Path -LiteralPath $path -PathType Leaf) {
                $item = Get-Item -LiteralPath $path
                $artifacts.Add([ordered]@{ target = $target; path = $path; fileVersion = $item.VersionInfo.FileVersion;
                    productVersion = $item.VersionInfo.ProductVersion; state = Get-State $path })
            }
        }
    } catch {
        $result = 'failed'
        $exitCode = 1
        $failure = ($failure + "`nPost-run input verification: " + $_.Exception.ToString()).Trim()
        [Console]::Error.WriteLine($_.Exception.ToString())
    }
    $timer.Stop()
    $outcome = [ordered]@{ schemaVersion = 1; runId = 'r0-20261012-01'; kind = 'matching-captured-native-reference-validation';
        result = $result; lastStage = $stage; startedUtc = $startedUtc; completedUtc = [DateTime]::UtcNow.ToString('o');
        durationSeconds = $timer.Elapsed.TotalSeconds; sourceRoot = $sourceRoot; buildRoot = $buildRoot;
        dependencyReceiptPath = $dependencyReceiptPath; dependencyReceiptSha256 = (Get-State $dependencyReceiptPath).sha256;
        sourceBefore = $sourceBefore; sourceAfter = $sourceAfter; dependenciesBefore = $dependenciesBefore; dependenciesAfter = $dependenciesAfter;
        toolchain = [ordered]@{ generator = 'Visual Studio 17 2022'; architecture = 'x64'; configuration = 'Release';
            visualStudioRoot = $vsRoot; toolset = 'v143,host=x64,version=14.44.35207'; windowsSdk = '10.0.26100.0';
            externalInputHashes = @($externalInputs.ToArray()); environment = $buildEnvironment };
        requestedTargets = $targets; testFilter = $testFilter; discoveredTests = $discoveredTests;
        observedEntryProcess = $observedEntry; observedCommands = @($commands.ToArray()); artifacts = @($artifacts.ToArray());
        limitation = 'A build from the validated frozen source and dependency capture using recorded installed tools. This is not a claim of full OS/toolchain or bit-for-bit reproducibility.';
        failure = $failure }
    Write-NewUtf8 $outcomePath (($outcome | ConvertTo-Json -Depth 18) + "`n")
    $env:VCPKG_ROOT = $originalVcpkg
}
Write-Output "Native validation $result. Outcome: $outcomePath"
exit $exitCode
