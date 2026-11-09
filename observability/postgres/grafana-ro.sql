-- Read-only Postgres role for the CoJam Grafana dashboards (product events).
--
-- Idempotent: rerun after restoring a dump on a new host (roles are not in
-- pg_dump) or after a migration that drops and recreates product_events.
-- Expects psql variable `pw` (the password). Pass it on stdin, never in argv:
--
--   { printf "\\set pw '%s'\n" "$(cat <password-file>)"; cat observability/postgres/grafana-ro.sql; } \
--     | psql "$DIRECT_DATABASE_URL" -v ON_ERROR_STOP=1 -1 -q
--
-- Run it with a role that can CREATE ROLE and GRANT (the database owner or a
-- superuser), not with grafana_ro itself. Test it with
-- observability/postgres/test-grafana-ro.sh before pointing Grafana at it.
--
-- Access model: column-level SELECT on product_events only. Those rows hold
-- hashes and enum-like props, never a clear room id, user id, IP, nickname,
-- chat or search text (see apps/server/internal/events). Nothing else is
-- granted: not rooms (room state and ids), reports, moderation actions,
-- spotify_tokens or schema_migrations.
-- default_transaction_read_only and statement_timeout are guardrails a session
-- can override; the privileges below are the actual control.
-- CONNECTION LIMIT 5 is intentional: keep the Grafana datasource's
-- maxOpenConns at 5 or below, or panels fail with "too many connections for
-- role grafana_ro".
--
-- Note: REVOKE TEMPORARY ON DATABASE ... FROM PUBLIC (same as Lucky) removes
-- temp-table creation from every role that has not been granted it directly.
-- The application role owns its objects and does not use temp tables; if a
-- shared database has another tenant that does, grant it back to that role.

SELECT format('CREATE ROLE grafana_ro LOGIN PASSWORD %L', :'pw')
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'grafana_ro') \gexec
ALTER ROLE grafana_ro LOGIN PASSWORD :'pw' CONNECTION LIMIT 5
    NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
ALTER ROLE grafana_ro SET default_transaction_read_only = on;
ALTER ROLE grafana_ro SET statement_timeout = '15s';

SELECT format('REVOKE ALL ON DATABASE %I FROM grafana_ro', current_database()) \gexec
SELECT format('REVOKE TEMPORARY ON DATABASE %I FROM PUBLIC', current_database()) \gexec
SELECT format('GRANT CONNECT ON DATABASE %I TO grafana_ro', current_database()) \gexec
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM grafana_ro;
GRANT USAGE ON SCHEMA public TO grafana_ro;

GRANT SELECT (at, name, room_hash, actor_hash, props)
    ON product_events TO grafana_ro;

-- product_events has RLS enabled with no policies (migration
-- 0008_product_events), which hides every row from a non-owner role. A
-- SELECT-only policy scoped to grafana_ro opens it for this role alone; the
-- column grant above still limits what it can read (no id column).
DROP POLICY IF EXISTS grafana_ro_read ON product_events;
CREATE POLICY grafana_ro_read ON product_events FOR SELECT TO grafana_ro USING (true);
