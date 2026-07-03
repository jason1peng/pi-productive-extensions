#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'USAGE'
Usage: npm run report-viewer:tailscale -- <start|stop|restart|status|logs|url>

Starts the report viewer bound to this machine's Tailscale IPv4 address so it
is reachable from devices on the same tailnet.

Environment overrides:
  REPORT_VIEWER_HOST=<tailscale-ip>       Override autodetected Tailscale IP.
  REPORT_VIEWER_PORT=8765                Port to listen on.
  REPORT_VIEWER_ROOTS=$HOME/.pi/delivery-run
  REPORT_VIEWER_STATE_DIR=/tmp/pi-report-viewer
  REPORT_VIEWER_LOG_FILE=<path>          Defaults under state dir.
  REPORT_VIEWER_PID_FILE=<path>          Defaults under state dir.

Security: the viewer is reachable by devices that can reach this Tailscale IP.
Agent execution remains disabled unless REPORT_VIEWER_AGENT_PROMPT_MODE=stdin
or config explicitly enables it.
USAGE
}

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "$script_dir/../../.." && pwd)"
state_dir="${REPORT_VIEWER_STATE_DIR:-/tmp/pi-report-viewer}"
log_file="${REPORT_VIEWER_LOG_FILE:-$state_dir/report-viewer.log}"
pid_file="${REPORT_VIEWER_PID_FILE:-$state_dir/report-viewer.pid}"
port="${REPORT_VIEWER_PORT:-8765}"
roots="${REPORT_VIEWER_ROOTS:-$HOME/.pi/delivery-run}"

command="${1:-start}"

mkdir -p "$state_dir"

detect_tailscale_ip() {
  if [[ -n "${REPORT_VIEWER_HOST:-}" ]]; then
    printf '%s\n' "$REPORT_VIEWER_HOST"
    return 0
  fi
  local ip
  if command -v tailscale >/dev/null 2>&1; then
    ip="$(tailscale ip -4 2>/dev/null | head -n 1 || true)"
    if [[ -n "$ip" ]]; then
      printf '%s\n' "$ip"
      return 0
    fi
  fi
  if command -v ifconfig >/dev/null 2>&1; then
    ip="$(ifconfig 2>/dev/null | awk '/inet 100\./ { print $2; exit }')"
    if [[ -n "$ip" ]]; then
      printf '%s\n' "$ip"
      return 0
    fi
  fi
  cat >&2 <<'ERR'
Could not autodetect a Tailscale IPv4 address.
Install/login to Tailscale, or pass REPORT_VIEWER_HOST=<100.x.y.z>.
ERR
  return 1
}

is_running() {
  [[ -f "$pid_file" ]] || return 1
  local pid
  pid="$(cat "$pid_file" 2>/dev/null || true)"
  [[ -n "$pid" ]] || return 1
  kill -0 "$pid" >/dev/null 2>&1
}

start() {
  if is_running; then
    echo "report-viewer is already running (pid $(cat "$pid_file"))"
    url
    return 0
  fi
  local host
  host="$(detect_tailscale_ip)"
  echo "Starting report-viewer on http://$host:$port/reports"
  (
    cd "$repo_root"
    REPORT_VIEWER_HOST="$host" \
    REPORT_VIEWER_PORT="$port" \
    REPORT_VIEWER_ROOTS="$roots" \
    nohup npm run report-viewer > "$log_file" 2>&1 &
    echo $! > "$pid_file"
  )
  sleep 1
  if is_running; then
    echo "Started report-viewer (pid $(cat "$pid_file"))"
    echo "Logs: $log_file"
    url
  else
    echo "report-viewer failed to start; last log lines:" >&2
    tail -n 40 "$log_file" >&2 || true
    return 1
  fi
}

stop() {
  if ! is_running; then
    echo "report-viewer is not running"
    rm -f "$pid_file"
    return 0
  fi
  local pid
  pid="$(cat "$pid_file")"
  echo "Stopping report-viewer (pid $pid)"
  kill "$pid"
  for _ in {1..20}; do
    if ! kill -0 "$pid" >/dev/null 2>&1; then
      rm -f "$pid_file"
      echo "Stopped"
      return 0
    fi
    sleep 0.2
  done
  echo "Process did not stop after SIGTERM; sending SIGKILL" >&2
  kill -9 "$pid" >/dev/null 2>&1 || true
  rm -f "$pid_file"
}

status() {
  if is_running; then
    echo "report-viewer running (pid $(cat "$pid_file"))"
    url
  else
    echo "report-viewer not running"
    [[ -f "$pid_file" ]] && echo "stale pid file: $pid_file"
  fi
}

logs() {
  touch "$log_file"
  tail -f "$log_file"
}

url() {
  local host
  host="$(detect_tailscale_ip)"
  echo "http://$host:$port/reports"
}

case "$command" in
  start) start ;;
  stop) stop ;;
  restart) stop; start ;;
  status) status ;;
  logs) logs ;;
  url) url ;;
  -h|--help|help) usage ;;
  *) usage >&2; exit 2 ;;
esac
