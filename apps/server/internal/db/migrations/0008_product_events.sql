-- First-party product events (owner decision 2026-10-09, "tabela de eventos
-- propria"). One row per anonymous product event: room created or joined, track
-- started, skipped or liked, a search (never its text), a provider connected,
-- peak listeners. room_hash and actor_hash are truncated HMAC-SHA256 hex digests
-- keyed by EVENTS_HMAC_KEY: the clear room id (a capability, spec 245) and the
-- clear user id are never stored, and neither are IPs, nicknames, chat or
-- search text. props holds a small allowlisted set of enum-like values per
-- event name (see internal/events). Rows older than 13 months are purged by
-- the retention job.
--
-- RLS is enabled with no policies, like Lucky's command_events: the server
-- role owns the table and is exempt, every other role sees nothing until a
-- policy names it (observability/postgres/grafana-ro.sql adds a SELECT policy
-- for the read-only dashboard role only).
CREATE TABLE IF NOT EXISTS product_events (
    id         bigserial   PRIMARY KEY,
    at         timestamptz NOT NULL DEFAULT now(),
    name       text        NOT NULL,
    room_hash  text,
    actor_hash text,
    props      jsonb       NOT NULL DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS product_events_name_at_idx ON product_events (name, at);
CREATE INDEX IF NOT EXISTS product_events_at_idx ON product_events (at);

ALTER TABLE product_events ENABLE ROW LEVEL SECURITY;
