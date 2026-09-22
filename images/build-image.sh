#!/usr/bin/env bash
# Builds a .smolmachine pack from a Smolfile. Usage: ./build-image.sh <name> [out]
#   VERIFY_CMD="<words>" — in-guest verification command (default: node --version)
set -euo pipefail
NAME="${1:?usage: build-image.sh <name>}"
DIR="$(cd "$(dirname "$0")" && pwd)"
OUT="${2:-$HOME/.pisandboxed/images/$NAME.smolmachine}"
VM="imgbuild-$NAME-$$"
VERIFY_CMD="${VERIFY_CMD:-node --version}"

smolvm machine create --name "$VM" -s "$DIR/$NAME.toml"
smolvm machine start --name "$VM"
# shellcheck disable=SC2086 — intentional word splitting of the verify command
smolvm machine exec --name "$VM" -- $VERIFY_CMD
smolvm machine stop  --name "$VM"
mkdir -p "$(dirname "$OUT")"
smolvm pack create --from-vm "$VM" -o "${OUT%.smolmachine}"
smolvm machine delete -f --name "$VM"
echo "built: $OUT"
