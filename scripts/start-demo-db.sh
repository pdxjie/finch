#!/bin/bash
# Start an isolated MySQL 8 instance for trying Finch without touching your main DB.
# Requires MySQL 8 installed (Homebrew example: brew install mysql@8.0).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
MYSQL_BASE="${MYSQL_BASE:-$(brew --prefix mysql@8.0 2>/dev/null || true)}"
if [ -z "$MYSQL_BASE" ] || [ ! -x "$MYSQL_BASE/bin/mysqld" ]; then
  echo "MySQL 8 not found. Set MYSQL_BASE to the directory containing bin/mysqld." >&2
  exit 1
fi

PORT="${FINCH_DEMO_PORT:-3407}"
DATA="$ROOT/.demo-mysql/data"
mkdir -p "$ROOT/.demo-mysql"

if [ ! -d "$DATA/mysql" ]; then
  echo "Initializing demo database in .demo-mysql/data …"
  "$MYSQL_BASE/bin/mysqld" --initialize-insecure \
    --basedir="$MYSQL_BASE" --datadir="$DATA" \
    --log-error="$ROOT/.demo-mysql/init.log"
fi

if "$MYSQL_BASE/bin/mysqladmin" -h 127.0.0.1 -P "$PORT" -u root ping >/dev/null 2>&1; then
  echo "Demo MySQL already running on 127.0.0.1:$PORT"
else
  echo "Starting demo MySQL on 127.0.0.1:$PORT …"
  "$MYSQL_BASE/bin/mysqld" \
    --basedir="$MYSQL_BASE" --datadir="$DATA" \
    --port="$PORT" --bind-address=127.0.0.1 \
    --socket=/tmp/finch-demo.sock \
    --pid-file="$ROOT/.demo-mysql/mysqld.pid" \
    --log-error="$ROOT/.demo-mysql/error.log" \
    --mysqlx=0 >"$ROOT/.demo-mysql/stdout.log" 2>&1 &
  for _ in $(seq 1 40); do
    if "$MYSQL_BASE/bin/mysqladmin" -h 127.0.0.1 -P "$PORT" -u root ping >/dev/null 2>&1; then
      break
    fi
    sleep 0.5
  done
fi

if ! "$MYSQL_BASE/bin/mysql" -h 127.0.0.1 -P "$PORT" -u root -N -e "SHOW DATABASES LIKE 'finch_demo'" | grep -q finch_demo; then
  echo "Loading demo dataset …"
  "$MYSQL_BASE/bin/mysql" -h 127.0.0.1 -P "$PORT" -u root < "$ROOT/scripts/seed-demo.sql"
fi

echo
echo "Ready. Add this connection in Finch:"
echo "  Host: 127.0.0.1   Port: $PORT   User: root   Password: (empty)"
echo "  Database: finch_demo"
echo
echo "Stop it with:"
echo "  $MYSQL_BASE/bin/mysqladmin -h 127.0.0.1 -P $PORT -u root shutdown"
