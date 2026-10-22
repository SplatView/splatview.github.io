Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$startedUtc = [DateTime]::UtcNow.ToString('o')
$runRoot = $PSScriptRoot
$workspace = [IO.Path]::GetFullPath((Join-Path $runRoot '../../../..'))
$outcomePath = Join-Path $runRoot 'native-attempt05-outcome.json'
$dependencyPath = Join-Path $runRoot 'dependency-inputs.json'
$terminalPath = Join-Path $runRoot 'native-terminal-observations.json'
$resultPath = Join-Path $runRoot 'native-reference-result.json'
$finalizationPath = Join-Path $runRoot 'native-reference-finalization.command.json'
foreach ($path in $resultPath,$finalizationPath) { if (Test-Path -LiteralPath $path) { throw "Refusing existing evidence: $path" } }
function Get-FileState([string]$Path) {
    $item = Get-Item -LiteralPath $Path -Force
    if ($item.PSIsContainer) { throw "Expected file: $Path" }
    [ordered]@{ path=$item.FullName; bytes=[long]$item.Length; sha256=(Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant() }
}
function Write-NewJson([string]$Path, $Value) {
    $json = ($Value | ConvertTo-Json -Depth 50) + "`n"
    $stream = [IO.File]::Open($Path,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::Read)
    try { $bytes = (New-Object Text.UTF8Encoding($false)).GetBytes($json); $stream.Write($bytes,0,$bytes.Length) } finally { $stream.Dispose() }
}
$outcome = Get-Content -LiteralPath $outcomePath -Raw | ConvertFrom-Json
$deps = Get-Content -LiteralPath $dependencyPath -Raw | ConvertFrom-Json
$terminal = Get-Content -LiteralPath $terminalPath -Raw | ConvertFrom-Json
if ($outcome.result -ne 'succeeded' -or $null -ne $outcome.failure) { throw 'Native attempt05 did not succeed.' }
if ((Get-FileState $dependencyPath).sha256 -ne $outcome.dependencyReceiptSha256) { throw 'Dependency receipt changed.' }
$inputChecks = @()
foreach ($record in @($deps.metadata)+@($deps.packageAndScriptProvenance)) {
    $state = Get-FileState $record.snapshotPath
    if ($state.bytes -ne $record.copied.bytes -or $state.sha256 -ne $record.copied.sha256) { throw "Captured dependency metadata/provenance changed: $($record.snapshotPath)" }
    $inputChecks += [ordered]@{ snapshotPath=$record.snapshotPath; recorded=$record.copied; postbuild=$state; matches=$true }
}
$artifactChecks = @()
foreach ($artifact in $outcome.artifacts) {
    $state = Get-FileState $artifact.path
    if ($state.bytes -ne $artifact.state.bytes -or $state.sha256 -ne $artifact.state.sha256) { throw "Executable changed after native validation: $($artifact.path)" }
    $artifactChecks += [ordered]@{ target=$artifact.target; path=$artifact.path; fileVersion=$artifact.fileVersion; productVersion=$artifact.productVersion; state=$state }
}
$commandReceipts = @()
foreach ($command in $outcome.observedCommands) {
    $logState = Get-FileState $command.mergedOutputLog
    if ($logState.sha256 -ne $command.mergedOutputLogSha256) { throw "Observed command log changed: $($command.name)" }
    $receiptPath = Join-Path $runRoot ($command.name+'.command.json')
    $receipt = Get-Content -LiteralPath $receiptPath -Raw | ConvertFrom-Json
    if ($receipt.exitCode -ne 0 -or $receipt.name -ne $command.name) { throw "Invalid successful command receipt: $receiptPath" }
    $commandReceipts += [ordered]@{ name=$command.name; terminalSessionId=54950; terminalChunkIds=@('20b63a','f7cc3e','e157db','abfb38','41792d'); observed=$command; receipt=Get-FileState $receiptPath; output=$logState }
}
$junitPath = Join-Path $runRoot 'native-attempt05-ctest.junit.xml'
[xml]$junit = Get-Content -LiteralPath $junitPath -Raw
if ([int]$junit.testsuite.tests -ne 9 -or [int]$junit.testsuite.failures -ne 0 -or [int]$junit.testsuite.skipped -ne 0) { throw 'Unexpected focused CTest result.' }
$testCases = @()
foreach ($case in $junit.testsuite.testcase) {
    $discovered = @($outcome.discoveredTests | Where-Object name -eq $case.name)
    if ($discovered.Count -ne 1 -or $case.status -ne 'run') { throw "Unexpected test inventory/status: $($case.name)" }
    $props = [ordered]@{}
    foreach ($property in $discovered[0].properties) { $props[$property.name] = $property.value }
    $testCases += [ordered]@{ name=[string]$case.name; status='passed'; elapsedSeconds=[double]$case.time; fixtureSetup=([string]$case.name -eq 'SharedSceneFixtures'); command=$discovered[0].command; properties=$props; output=[string]$case.'system-out' }
}
$cachePath = Join-Path $outcome.buildRoot 'CMakeCache.txt'
$cache = [ordered]@{}
foreach ($line in [IO.File]::ReadAllLines($cachePath)) {
    if ($line -match '^(?<key>[^#/][^:=]*):(?<type>[^=]+)=(?<value>.*)$') { $cache[$Matches.key] = $Matches.value }
}
$cacheSelected = [ordered]@{}
foreach ($name in 'BUILD_TESTING','SPLATVIEW_BUILD_BENCHMARKS','SPLATVIEW_ENABLE_ASAN','CMAKE_C_FLAGS_RELEASE','CMAKE_CXX_FLAGS_RELEASE','CMAKE_C_FLAGS_DEBUG','CMAKE_CXX_FLAGS_DEBUG','CMAKE_MSVC_DEBUG_INFORMATION_FORMAT','CMAKE_POLICY_DEFAULT_CMP0141','CMAKE_GENERATOR','CMAKE_GENERATOR_PLATFORM','CMAKE_GENERATOR_TOOLSET','CMAKE_GENERATOR_INSTANCE','CMAKE_SYSTEM_VERSION','CMAKE_TOOLCHAIN_FILE','VCPKG_ROOT','VCPKG_INSTALLED_DIR','VCPKG_MANIFEST_INSTALL','VCPKG_TARGET_TRIPLET','SPLATVIEW_FXC','CMAKE_HOME_DIRECTORY') { if ($cache.Contains($name)) { $cacheSelected[$name]=$cache[$name] } }
$releaseProjects = @()
foreach ($name in 'SplatView','preview_scene','preview_render','preview_save') {
    $path = Join-Path $outcome.buildRoot ($name+'.vcxproj')
    [xml]$project = Get-Content -LiteralPath $path -Raw
    $node = @($project.Project.ItemDefinitionGroup | Where-Object { $_.Condition -like '*Release|x64*' })
    if ($node.Count -ne 1) { throw "Unexpected Release settings: $name" }
    $cl = $node[0].ClCompile
    if ($cl.Optimization -ne 'MaxSpeed' -or $cl.RuntimeLibrary -ne 'MultiThreaded' -or $cl.DebugInformationFormat -ne 'ProgramDatabase') { throw "Release options diverged: $name" }
    $releaseProjects += [ordered]@{ target=$name; project=Get-FileState $path; optimization=[string]$cl.Optimization; runtime=[string]$cl.RuntimeLibrary; debugInformationFormat=[string]$cl.DebugInformationFormat; additionalOptions=[string]$cl.AdditionalOptions }
}
$configureLogPath = Join-Path $outcome.buildRoot 'CMakeFiles/CMakeConfigureLog.yaml'
$configureText = [IO.File]::ReadAllText($configureLogPath)
$abiResults = @()
foreach ($language in 'C','CXX') {
    $match = [regex]::Match($configureText,'(?s)variable: "CMAKE_'+$language+'_ABI_COMPILED"(?<body>.*?)exitCode: (?<code>[0-9]+)')
    if (-not $match.Success -or $match.Groups['code'].Value -ne '0' -or -not $match.Groups['body'].Value.Contains('/Z7')) { throw "Compiler ABI check missing or failed: $language" }
    $abiResults += [ordered]@{ language=$language; exitCode=0; debugInformationFlag='/Z7'; actualCompileAndLink=$true }
}
$actualMsbuildPath = 'C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\MSBuild\Current\Bin\amd64\MSBuild.exe'
$actualMsbuild = Get-FileState $actualMsbuildPath
if ($actualMsbuild.sha256 -ne '0c0f83a7393ca0b5b08119201819fe39bc028e134d82edea625888517f13fe48') { throw 'Actual amd64 MSBuild changed since during-build observation.' }
$git = 'C:\Program Files\Git\cmd\git.exe'
$gitCommands = @()
foreach ($arguments in @(@('-C',$deps.vcpkgRoot,'rev-parse','HEAD'),@('-C',$deps.vcpkgRoot,'status','--porcelain','--untracked-files=no'))) {
    $time = [DateTime]::UtcNow.ToString('o')
    $output = @(& $git @arguments 2>&1 | ForEach-Object { [string]$_ })
    $code = $LASTEXITCODE
    $gitCommands += [ordered]@{ executable=$git; executableSha256=(Get-FileState $git).sha256; arguments=$arguments; startedUtc=$time; completedUtc=[DateTime]::UtcNow.ToString('o'); exitCode=$code; output=$output }
    if ($code -ne 0) { throw 'Postbuild vcpkg git observation failed.' }
}
if (($gitCommands[0].output -join "`n") -ne $deps.vcpkgAfter.head -or ($gitCommands[1].output -join "`n") -ne '') { throw 'Pinned vcpkg working tree changed.' }
$failedAttempts = @()
$failedSpecs = @(
    @('native','build-native-reference.ps1','9c413d','Original configure failed compiler sanity check with C1090 PDB API call failure, error code 3.'),
    @('native-attempt02','build-native-reference-attempt02.ps1','d03422','Pinned vcvars64 developer environment retained the same C1090 compiler-check failure.'),
    @('native-attempt03','build-native-reference-attempt03.ps1','db36ff','Debug flags /Z7 override was ineffective: generated compiler check still used /Zi through the MSVC debug-information property.'),
    @('native-attempt04','build-native-reference-attempt04.ps1','034787','Fresh shorter build path with faithful original flags retained the same C1090 compiler-check failure.')
)
foreach ($spec in $failedSpecs) {
    $path=Join-Path $runRoot ($spec[0]+'-outcome.json')
    $failure=Get-Content -LiteralPath $path -Raw | ConvertFrom-Json
    if ($failure.result -ne 'failed') { throw "Expected preserved failed outcome: $path" }
    $failedAttempts += [ordered]@{ attempt=$spec[0]; summary=$spec[3]; terminalChunkId=$spec[2]; exitCode=1; outcome=Get-FileState $path; helper=Get-FileState (Join-Path $runRoot $spec[1]); configureReceipt=Get-FileState (Join-Path $runRoot ($spec[0]+'-configure.command.json')); configureOutput=Get-FileState (Join-Path $runRoot ($spec[0]+'-configure.log')); failure=$failure.failure }
}
$binaryLog = Get-FileState (Join-Path $runRoot 'native-attempt05-build.binlog')
$appPdb = Get-FileState (Join-Path $outcome.buildRoot 'Release/SplatView.pdb')
$result = [ordered]@{
    schemaVersion=1; runId='r0-20261012-01'; kind='matching-captured-native-reference-result'; result='passed'; assembledUtc=[DateTime]::UtcNow.ToString('o');
    source=[ordered]@{ captureTarget='windows-r0-20261012-02'; captureId=$outcome.sourceBefore.captureId; root=$outcome.sourceRoot; manifest=Get-FileState (Join-Path (Split-Path $outcome.sourceRoot -Parent) 'CAPTURE_MANIFEST.json'); status=Get-FileState (Join-Path (Split-Path $outcome.sourceRoot -Parent) 'CAPTURE_STATUS.json'); treeSha256=$outcome.sourceBefore.treeSha256; before=$outcome.sourceBefore; after=$outcome.sourceAfter };
    dependencies=[ordered]@{ receipt=Get-FileState $dependencyPath; root=$deps.installedSnapshotRoot; vcpkgRoot=$deps.vcpkgRoot; vcpkgCaptureBefore=$deps.vcpkgBefore; vcpkgCaptureAfter=$deps.vcpkgAfter; vcpkgPostbuildCommands=$gitCommands; before=$outcome.dependenciesBefore; after=$outcome.dependenciesAfter; metadataAndProvenancePostbuild=$inputChecks };
    toolchain=[ordered]@{ generator=$outcome.toolchain.generator; architecture=$outcome.toolchain.architecture; configuration=$outcome.toolchain.configuration; visualStudioRoot=$outcome.toolchain.visualStudioRoot; toolset=$outcome.toolchain.toolset; windowsSdk=$outcome.toolchain.windowsSdk; prePostExternalInputHashes=$outcome.toolchain.externalInputHashes; actualMsbuild=[ordered]@{ state=$actualMsbuild; fileVersion=(Get-Item -LiteralPath $actualMsbuildPath).VersionInfo.FileVersion; timing='This amd64 executable hash was first observed during the successful build, then rechecked after build; it was not included in the prebuild tool list, which hashed the sibling x86 MSBuild.' }; environment=$outcome.toolchain.environment };
    build=[ordered]@{ root=$outcome.buildRoot; requestedTargets=$outcome.requestedTargets; entryProcess=$outcome.observedEntryProcess; helper=Get-FileState $outcome.observedEntryProcess.scriptPath; startedUtc=$outcome.startedUtc; completedUtc=$outcome.completedUtc; durationSeconds=$outcome.durationSeconds; observedCommands=$commandReceipts; binaryLog=$binaryLog; cache=Get-FileState $cachePath; selectedCacheValues=$cacheSelected; releaseProjectSettings=$releaseProjects; compilerChecks=[ordered]@{ bypassed=$false; log=Get-FileState $configureLogPath; successfulAbiChecks=$abiResults }; compatibility=[ordered]@{ reason='Four preserved compiler-check attempts failed with C1090 PDB API error code 3; compiler checks succeeded using Embedded debug information.'; flags=@('-DCMAKE_POLICY_DEFAULT_CMP0141:STRING=NEW','-DCMAKE_MSVC_DEBUG_INFORMATION_FORMAT:STRING=$<$<CONFIG:Debug,RelWithDebInfo>:Embedded>'); scope='The generator expression selects Debug and RelWithDebInfo, including CMake Debug compiler sanity checks. Release targets retain source-defined /O2 /MT /Zi, confirmed in generated projects.'; sourceModified=$false; compilerChecksSkipped=$false; globalEnvironmentModified=$false } };
    tests=[ordered]@{ filter=$outcome.testFilter; contractCount=8; fixtureSetupCount=1; actualCount=9; passed=9; failed=0; skipped=0; junit=Get-FileState $junitPath; cases=$testCases };
    executable=@($artifactChecks | Where-Object target -eq 'SplatView')[0]; artifacts=$artifactChecks; applicationPdb=$appPdb;
    evidence=[ordered]@{ nativeOutcome=Get-FileState $outcomePath; terminalObservations=Get-FileState $terminalPath; terminalSessionId=54950; completionChunkId='41792d'; processExitCode=0; preservedFailedAttempts=$failedAttempts; assemblyHelper=Get-FileState $PSCommandPath };
    limitations=@('This is a successful build from the validated frozen source and copied dependency payload using recorded installed tools; full OS/toolchain or bit-for-bit reproducibility is not claimed.','The focused suite contains eight requested contracts and their shared fixture setup. The broader SplatViewContracts suite was not built or run.','The actual amd64 MSBuild executable has a during-build and postbuild hash observation, not a prebuild hash observation.');
}
Write-NewJson $resultPath $result
$process=Get-CimInstance Win32_Process -Filter "ProcessId=$PID"
$parent=Get-CimInstance Win32_Process -Filter "ProcessId=$($process.ParentProcessId)"
Write-NewJson $finalizationPath ([ordered]@{ schemaVersion=1; kind='observed-native-reference-finalization'; startedUtc=$startedUtc; completedUtc=[DateTime]::UtcNow.ToString('o'); entryExecutable=$process.ExecutablePath; entryProcessCommandLine=$process.CommandLine; entryArgumentVector=[Environment]::GetCommandLineArgs(); parentProcessCommandLine=$parent.CommandLine; workingDirectory=[Environment]::CurrentDirectory; helper=Get-FileState $PSCommandPath; observedGitCommands=$gitCommands; checks=[ordered]@{ metadataAndProvenanceFiles=$inputChecks.Count; artifacts=$artifactChecks.Count; commandReceipts=$commandReceipts.Count; tests=$testCases.Count; releaseProjects=$releaseProjects.Count; compilerAbiChecks=$abiResults.Count }; exitCode=0; result=Get-FileState $resultPath })
Write-Output ('Native reference result written: '+$resultPath)
Write-Output ('Result SHA-256: '+(Get-FileState $resultPath).sha256)
Write-Output ('Executable SHA-256: '+$result.executable.state.sha256)
Write-Output ('CTest: 9 passed, 0 failed, 0 skipped')
