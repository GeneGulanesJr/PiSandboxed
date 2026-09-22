#!/usr/bin/env bash
# Builds a .smolmachine pack from a Smolfile. Usage: ./build-image.sh node26-dev
set -euo pipefail
NAME="${1:?usage: build-image.sh <name>}"
DIR="$(cd "$(dirname "$0")" && pwd)"
OUT="${2:-$HOME/.pisandboxed/images/$NAME.smolmachine}"
VM="imgbuild-$NAME-$$"

smolvm machine create --name "$VM" -s "$DIR/$NAME.toml"
smolvm machine start --name "$VM"
smolvm machine exec --name "$VM" -- node --version
smolvm machine stop  --name "$VM"
mkdir -p "$(dirname "$OUT")"
smolvm pack create --from-vm "$VM" -o "${OUT%.smolmachine}"
smolvm machine delete -f --name "$VM"
echo "built: $OUT"
