[CmdletBinding()]
param([string]$CMake = 'cmake.exe')

$ErrorActionPreference = 'Stop'
$revision = 'd1be6fde11ac6e0407606b4e42fe72d34add8037'
$expected = '645445DA884DF6DBD52B30F82D7BE7C01D1767C938714E477E786B88D529E9F4'
$working = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\tmp\voice-engine'))
$archive = Join-Path $working "$revision.tar.gz"
$source = Join-Path $working "whisper.cpp-$revision"
$build = Join-Path $working 'build'
$payload = Join-Path $working 'payload'
$null = New-Item -ItemType Directory -Force -Path $working, $payload

if (!(Test-Path -LiteralPath $archive)) {
    & curl.exe --fail --location --silent --show-error --retry 2 --output "$archive.part" "https://codeload.github.com/ggml-org/whisper.cpp/tar.gz/$revision"
    if ($LASTEXITCODE) { throw 'whisper.cpp source download failed.' }
    Move-Item -LiteralPath "$archive.part" -Destination $archive
}
if ((Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash -ne $expected) {
    throw 'whisper.cpp source checksum mismatch.'
}
& tar.exe -xzf $archive -C $working
if ($LASTEXITCODE) { throw 'whisper.cpp extraction failed.' }

& $CMake -S (Join-Path $PSScriptRoot 'voice-engine') -B $build -G 'Visual Studio 17 2022' -A x64 "-DWHISPER_SOURCE=$source"
if ($LASTEXITCODE) { throw 'Voice engine configuration failed.' }
& $CMake --build $build --config Release --parallel 6
if ($LASTEXITCODE) { throw 'Voice engine build failed.' }

$bin = Join-Path $build 'bin\Release'
$runtime = @('maid-voice-worker.exe', 'whisper.dll', 'ggml.dll', 'ggml-base.dll', 'ggml-cpu-x64.dll')
foreach ($file in $runtime) { Copy-Item -LiteralPath (Join-Path $bin $file) -Destination $payload -Force }
Get-ChildItem -LiteralPath $bin -Filter 'ggml-cpu-*.dll' | Copy-Item -Destination $payload -Force
Copy-Item -LiteralPath (Join-Path $source 'LICENSE') -Destination (Join-Path $payload 'LICENSE-whisper.cpp.txt') -Force
Write-Output $payload
