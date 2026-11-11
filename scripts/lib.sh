#!/usr/bin/env bash
# Shared helpers for the PiVault maintenance scripts. Sourced, not run.

PIVAULT_HOME="${PIVAULT_HOME:-/opt/pivault}"
PIVAULT_COMPOSE="${PIVAULT_COMPOSE:-$PIVAULT_HOME/deploy/docker-compose.yml}"
PIVAULT_DATA="${PIVAULT_DATA:-/mnt/storage/pivault}"
PIVAULT_METRICS_DIR="${PIVAULT_METRICS_DIR:-/var/lib/pivault/metrics}"

log() { printf '%s %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*"; }
die() { log "ERROR: $*" >&2; exit 1; }

compose() { docker compose -f "$PIVAULT_COMPOSE" "$@"; }

# record_metric <job> <ok: 1|0> [extra_metric_name value]
# Writes a Prometheus textfile that node_exporter picks up, so Grafana can show when
# each job last succeeded.
record_metric() {
  local job="$1" ok="$2" extra_name="${3:-}" extra_value="${4:-}"
  mkdir -p "$PIVAULT_METRICS_DIR"
  local file="$PIVAULT_METRICS_DIR/pivault_${job}.prom" tmp
  tmp="$(mktemp "$PIVAULT_METRICS_DIR/.tmp.XXXXXX")"
  {
    echo "# HELP pivault_job_last_run_timestamp_seconds When the job last finished."
    echo "# TYPE pivault_job_last_run_timestamp_seconds gauge"
    echo "pivault_job_last_run_timestamp_seconds{job=\"$job\"} $(date +%s)"
    echo "# HELP pivault_job_last_run_success Whether the last run succeeded (1) or failed (0)."
    echo "# TYPE pivault_job_last_run_success gauge"
    echo "pivault_job_last_run_success{job=\"$job\"} $ok"
    if [ "$ok" = "1" ]; then
      echo "# HELP pivault_job_last_success_timestamp_seconds When the job last succeeded."
      echo "# TYPE pivault_job_last_success_timestamp_seconds gauge"
      echo "pivault_job_last_success_timestamp_seconds{job=\"$job\"} $(date +%s)"
    elif [ -f "$file" ]; then
      # Keep the previous success time when this run failed.
      grep '^pivault_job_last_success_timestamp_seconds' "$file" || true
    fi
    if [ -n "$extra_name" ]; then
      echo "# TYPE $extra_name gauge"
      echo "$extra_name{job=\"$job\"} $extra_value"
    fi
  } > "$tmp"
  chmod 644 "$tmp"
  mv "$tmp" "$file"
}

require_root() { [ "$(id -u)" -eq 0 ] || die "run this with sudo"; }
