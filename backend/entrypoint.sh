#!/bin/sh
# Container entrypoint: `api` (default), `worker`, or any other command.
set -e

case "${1:-api}" in
  api)
    # Apply database migrations, then serve. Only the api container migrates.
    alembic upgrade head
    exec uvicorn app.main:app --host 0.0.0.0 --port 8000 \
      --proxy-headers --forwarded-allow-ips "${FORWARDED_ALLOW_IPS:-*}"
    ;;
  worker)
    exec arq app.worker.WorkerSettings
    ;;
  *)
    exec "$@"
    ;;
esac
