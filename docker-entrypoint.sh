#!/bin/sh
# DevSentinel AI container entrypoint: one image, role by APP_ROLE (ADR-010).
set -e

role="${APP_ROLE:-all}"

case "$role" in
  web)
    # HTTP only; the worker loop never boots here (src/instrumentation.ts).
    exec node server.js
    ;;
  worker)
    # Background worker only: no inbound port, no web server.
    exec ./node_modules/.bin/tsx worker/index.ts
    ;;
  all)
    # Both in one process for single-container hosts and local dev:
    # server.js + the in-process worker boot (src/instrumentation.ts).
    exec node server.js
    ;;
  *)
    echo "Invalid configuration: APP_ROLE must be web, worker, or all (got '$role')" >&2
    exit 1
    ;;
esac
