# Build the PiVault SD-card image from Windows PowerShell. Needs Docker Desktop.
#
#   .\infra\image\build.ps1
#
# The result is infra\image\build\pivault-rpi5-arm64.img.xz. Nothing is flashed.
$ErrorActionPreference = 'Stop'

$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$repo = (Resolve-Path (Join-Path $here '..\..')).Path
$build = Join-Path $here 'build'
$key = if ($env:PIVAULT_SSH_KEY) { $env:PIVAULT_SSH_KEY } else { Join-Path $HOME '.ssh\pivault_ed25519' }

docker info *> $null
if ($LASTEXITCODE -ne 0) { throw 'Docker is not running. Start Docker Desktop and try again.' }

New-Item -ItemType Directory -Force $build | Out-Null
$config = Join-Path $here 'config.env'
if (-not (Test-Path $config)) {
    Copy-Item (Join-Path $here 'config.env.example') $config
    Write-Host 'Created infra\image\config.env from the example. Edit it (Wi-Fi, email), then run this again.'
    exit 1
}

# An SSH key just for this Pi. The private half never leaves this computer.
if (-not (Test-Path $key)) {
    New-Item -ItemType Directory -Force (Split-Path -Parent $key) | Out-Null
    ssh-keygen -t ed25519 -N '""' -C pivault -f $key | Out-Null
    Write-Host "Created an SSH key for the Pi: $key"
}
Copy-Item "$key.pub" (Join-Path $build 'authorized_keys') -Force

docker run --rm --privileged -v "${repo}:/repo" debian:trixie-slim bash /repo/infra/image/build-image.sh
exit $LASTEXITCODE
