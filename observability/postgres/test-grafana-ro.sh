#!/usr/bin/env bash
# Verifies observability/postgres/grafana-ro.sql against a THROWAWAY Postgres.
#
#   ADMIN_URL='postgres://postgres:pw@localhost:55432/postgres' \
#     observability/postgres/test-grafana-ro.sh
#
# ADMIN_URL must point at a superuser on a disposable server (for example
# `docker run --rm -e POSTGRES_PASSWORD=pw -p 55432:5432 postgres:17-alpine`).
# The script creates a scratch database, applies every server migration, loads
# the grafana-ro.sql role (twice, to prove it is idempotent), then checks as
# the role that it can read product_events and nothing else. It drops the
# scratch database and the grafana_ro role when it ends. Needs psql, openssl.
set -euo pipefail

: "${ADMIN_URL:?set ADMIN_URL to a superuser URL on a disposable Postgres}"
here="$(cd "$(dirname "$0")" && pwd)"
root="$(cd "$here/../.." && pwd)"
db="cojam_grafana_ro_test"
pw="$(openssl rand -hex 16)"

# Swap the database name in a postgres:// URL (path before an optional query).
with_db() {
  local url="$1" name="$2"
  python3 - "$url" "$name" <<'PY'
import sys
from urllib.parse import urlsplit, urlunsplit
u = urlsplit(sys.argv[1])
print(urlunsplit((u.scheme, u.netloc, "/" + sys.argv[2], u.query, u.fragment)))
PY
}

admin="$ADMIN_URL"
scratch="$(with_db "$ADMIN_URL" "$db")"
ro_url() { # URL for grafana_ro on the scratch db
  python3 - "$scratch" <<'PY'
import sys
from urllib.parse import urlsplit, urlunsplit
u = urlsplit(sys.argv[1])
host = u.hostname + (":%d" % u.port if u.port else "")
print(urlunsplit((u.scheme, "grafana_ro@" + host, u.path, u.query, u.fragment)))
PY
}

cleanup() {
  psql "$admin" -q -c "DROP DATABASE IF EXISTS $db WITH (FORCE)" >/dev/null 2>&1 || true
  psql "$admin" -q -c "DROP ROLE IF EXISTS grafana_ro" >/dev/null 2>&1 || true
}
trap cleanup EXIT
cleanup

psql "$admin" -q -v ON_ERROR_STOP=1 -c "CREATE DATABASE $db"
for f in "$root"/apps/server/internal/db/migrations/*.sql; do
  psql "$scratch" -q -v ON_ERROR_STOP=1 -f "$f" >/dev/null
done
# The server creates schema_migrations at boot, not a migration file.
psql "$scratch" -q -v ON_ERROR_STOP=1 -c "CREATE TABLE IF NOT EXISTS schema_migrations (version text PRIMARY KEY)"
psql "$scratch" -q -v ON_ERROR_STOP=1 -c \
  "INSERT INTO product_events (name, room_hash, actor_hash, props) VALUES ('room_created', 'aaaa', NULL, '{}'), ('track_started', 'aaaa', 'bbbb', '{\"provider\":\"youtube\"}')"

load_role() {
  { printf "\\\\set pw '%s'\n" "$pw"; cat "$here/grafana-ro.sql"; } | psql "$scratch" -v ON_ERROR_STOP=1 -1 -q
}
load_role
load_role # idempotent

fail=0
ro() { PGPASSWORD="$pw" psql "$(ro_url)" -X -q -t -A -v ON_ERROR_STOP=1 -c "$1" 2>&1; }
expect_ok() { # description, sql, expected output
  local out; out="$(ro "$2")" || { echo "FAIL $1: $out"; fail=1; return; }
  if [ "$out" = "$3" ]; then echo "ok   $1"; else echo "FAIL $1: got '$out', want '$3'"; fail=1; fi
}
expect_denied() { # description, sql
  local out; if out="$(ro "$2")"; then echo "FAIL $1: succeeded ($out)"; fail=1
  elif echo "$out" | grep -qiE "permission denied|read-only transaction|row-level security|must be owner"; then echo "ok   $1"
  else echo "FAIL $1: failed for another reason: $out"; fail=1; fi
}

expect_ok     "reads product_events rows through the policy" "SELECT count(*) FROM product_events" "2"
expect_ok     "reads the granted columns" "SELECT name, props->>'provider' FROM product_events WHERE actor_hash IS NOT NULL" "track_started|youtube"
expect_denied "cannot read the id column (column-level grant)" "SELECT id FROM product_events"
expect_denied "cannot INSERT" "INSERT INTO product_events (name) VALUES ('x')"
expect_denied "cannot UPDATE" "UPDATE product_events SET name = 'x'"
expect_denied "cannot DELETE" "DELETE FROM product_events"
expect_denied "cannot INSERT even after turning read-only off" "SET default_transaction_read_only = off; INSERT INTO product_events (name) VALUES ('x')"
expect_denied "cannot read rooms" "SELECT count(*) FROM rooms"
expect_denied "cannot read reports" "SELECT count(*) FROM reports"
expect_denied "cannot read moderation_actions" "SELECT count(*) FROM moderation_actions"
expect_denied "cannot read schema_migrations" "SELECT count(*) FROM schema_migrations"
expect_denied "cannot create temp tables" "CREATE TEMP TABLE t (a int)"
expect_denied "cannot create tables" "CREATE TABLE public.t (a int)"
expect_ok     "role attributes" "SELECT rolconnlimit || ',' || rolbypassrls || ',' || rolsuper || ',' || rolcreaterole || ',' || rolcreatedb FROM pg_roles WHERE rolname = 'grafana_ro'" "5,false,false,false,false"
expect_ok     "default_transaction_read_only is on" "SHOW default_transaction_read_only" "on"
expect_ok     "statement_timeout is 15s" "SHOW statement_timeout" "15s"

if [ "$fail" -ne 0 ]; then echo "grafana-ro.sql: FAILED"; exit 1; fi
echo "grafana-ro.sql: all checks passed"
