#!/usr/bin/env bash
# Records invocations to $SMOLVM_STUB_LOG (if set), emulates enough of the CLI for tests.
LOG="${SMOLVM_STUB_LOG:-/dev/null}" && echo "$@" >> "$LOG"
cmd="${1:-}" sub="${2:-}" ; shift 2 2>/dev/null || shift $# 2>/dev/null
case "$cmd/$sub" in
  machine/create|machine/start) exit 0 ;;
  machine/exec) echo "stub-stdout"; echo "stub-stderr" >&2; exit 0 ;;
  machine/stop|machine/delete|machine/rm) exit 0 ;;
  *) exit 0 ;;
esac
