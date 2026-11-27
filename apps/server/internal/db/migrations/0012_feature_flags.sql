-- Runtime feature flags (docs/specs/feature-flags-panel.md). Until now every
-- flag came from an environment variable read at boot, so turning one on in
-- production meant editing the homelab .env and recreating the containers.
--
-- One row per flag the operator has overridden. A NULL column means "follow
-- the environment": deleting the override is setting both columns to NULL,
-- never removing the row, so the history below always has a current row to
-- point at.
--
--   enabled         the override for the flag, for both the server and the
--                   web client. NULL = FEATURE_* / COJAM_FEATURE_* decide.
--   room_allowlist  screen share only: the rooms a share may start in. NULL
--                   = SCREENSHARE_ROOM_ALLOWLIST decides; an empty array =
--                   every eligible private room.
--
-- The running server reads this table every 15 seconds (the same cycle as
-- room_restrictions) and right after its own admin endpoint writes it.
CREATE TABLE IF NOT EXISTS feature_flags (
    name           text        PRIMARY KEY,
    enabled        boolean,
    room_allowlist text[],
    updated_at     timestamptz NOT NULL DEFAULT now(),
    updated_by     text        NOT NULL DEFAULT ''
);

-- Append-only record of every change: what the flag was, what it became, who
-- changed it (the admin panel or the `server flag` command, never a person's
-- address) and the operator's note. Written in the same transaction as the
-- row above, so a change without a record cannot happen.
CREATE TABLE IF NOT EXISTS feature_flag_changes (
    id         bigserial   PRIMARY KEY,
    name       text        NOT NULL,
    before     jsonb       NOT NULL,
    after      jsonb       NOT NULL,
    actor      text        NOT NULL,
    note       text        NOT NULL DEFAULT '',
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS feature_flag_changes_created_at_idx
    ON feature_flag_changes (created_at DESC);
