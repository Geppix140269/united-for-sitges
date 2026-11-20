#!/usr/bin/env bash
# Throwaway local PostgreSQL for Community Agent tests. Never touches Neon.
# Usage: bash scripts/agent-test-db.sh start|stop|reset
#        AGENT_TESTDB_ADMIN_URL=postgresql://postgres:pw@host:5432 bash scripts/agent-test-db.sh apply
# "apply" targets an existing disposable server (CI service container) instead
# of a local cluster. Prints the connection URL to export as AGENT_TEST_DATABASE_URL.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# Outside the project so wrangler dev (which watches project files) never
# reloads because PostgreSQL wrote to its data directory.
if [ "$(id -u)" = "0" ]; then
  DEFAULT_DATA="$(getent passwd postgres | cut -d: -f6)/u4s-agent-testdb"   # postgres must own it
else
  DEFAULT_DATA="${XDG_CACHE_HOME:-$HOME/.cache}/u4s-agent-testdb"
fi
DATA="${AGENT_TESTDB_DIR:-$DEFAULT_DATA}"
PORT="${AGENT_TESTDB_PORT:-54329}"
PGBIN="${PGBIN:-$(ls -d /usr/lib/postgresql/*/bin 2>/dev/null | sort -V | tail -1)}"
RUNAS=()
if [ "$(id -u)" = "0" ]; then RUNAS=(runuser -u postgres --); fi
run() { "${RUNAS[@]}" "$@"; }
SOCK="$DATA/sock"
if [ -n "${AGENT_TESTDB_ADMIN_URL:-}" ]; then
  ADMIN="${AGENT_TESTDB_ADMIN_URL%/}"
  psqlc() {
    local db="$2"; shift 2
    psql "$ADMIN/$db" -v ON_ERROR_STOP=1 -q "$@"
  }
else
  psqlc() { run "$PGBIN/psql" -h "$SOCK" -p "$PORT" -U postgres -v ON_ERROR_STOP=1 -q "$@"; }
fi

apply_schema() {
  psqlc -d postgres -c "drop database if exists agent_test" -c "create database agent_test"
  psqlc -d agent_test -f "$ROOT/tests/agent/fixtures/neon-stubs.sql"
  # Same order as production: forum schema, then the agent schema.
  psqlc -d agent_test -f "$ROOT/neon/schema.sql"
  psqlc -d agent_test -f "$ROOT/neon/agent-schema.sql"
  psqlc -d agent_test -c "alter role ufs_agent_worker with login password 'agent_test_only'"
}

case "${1:-start}" in
  start)
    if [ ! -d "$DATA/pg" ]; then
      mkdir -p "$DATA/pg" "$SOCK"; chown -R postgres "$DATA" 2>/dev/null || true
      run "$PGBIN/initdb" -D "$DATA/pg" -U postgres -A trust >/dev/null
    fi
    run "$PGBIN/pg_ctl" -D "$DATA/pg" -o "-p $PORT -k $SOCK -c listen_addresses=127.0.0.1" -l "$DATA/pg.log" -w start >/dev/null || true
    apply_schema
    echo "postgresql://ufs_agent_worker:agent_test_only@127.0.0.1:$PORT/agent_test"
    ;;
  reset) apply_schema; echo "postgresql://ufs_agent_worker:agent_test_only@127.0.0.1:$PORT/agent_test" ;;
  apply)
    [ -n "${AGENT_TESTDB_ADMIN_URL:-}" ] || { echo "AGENT_TESTDB_ADMIN_URL is required for apply" >&2; exit 2; }
    apply_schema
    HOSTPART="${ADMIN#*@}"
    echo "postgresql://ufs_agent_worker:agent_test_only@${HOSTPART}/agent_test"
    ;;
  stop) run "$PGBIN/pg_ctl" -D "$DATA/pg" -w stop >/dev/null && echo stopped ;;
  *) echo "usage: $0 start|stop|reset|apply" >&2; exit 2 ;;
esac
