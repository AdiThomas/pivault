#!/usr/bin/env bash
# Build the PiVault SD-card image. Needs Docker. Works from Git Bash on Windows, WSL,
# Linux and macOS:
#
#   infra/image/build.sh
#
# The result is infra/image/build/pivault-rpi5-arm64.img.xz. Nothing is flashed.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
BUILD="$HERE/build"
KEY="${PIVAULT_SSH_KEY:-$HOME/.ssh/pivault_ed25519}"

docker info > /dev/null 2>&1 || { echo "Docker is not running. Start Docker Desktop and try again." >&2; exit 1; }

mkdir -p "$BUILD"
if [ ! -f "$HERE/config.env" ]; then
  cp "$HERE/config.env.example" "$HERE/config.env"
  echo "Created infra/image/config.env from the example. Edit it (Wi-Fi, email), then run this again."
  exit 1
fi

# An SSH key just for this Pi. The private half never leaves this computer.
if [ ! -f "$KEY" ]; then
  mkdir -p "$(dirname "$KEY")"
  ssh-keygen -t ed25519 -N "" -C "pivault" -f "$KEY" > /dev/null
  echo "Created an SSH key for the Pi: $KEY"
fi
cp "$KEY.pub" "$BUILD/authorized_keys"

# Docker Desktop on Windows needs a Windows-style path for the bind mount.
MOUNT="$REPO"
if command -v cygpath > /dev/null 2>&1; then MOUNT="$(cygpath -m "$REPO")"; fi

MSYS_NO_PATHCONV=1 docker run --rm --privileged \
  -v "$MOUNT:/repo" \
  debian:trixie-slim bash /repo/infra/image/build-image.sh
