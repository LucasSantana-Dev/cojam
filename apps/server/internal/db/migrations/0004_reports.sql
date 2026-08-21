-- Member reports (#259). Durable on purpose: chat is ephemeral, so content is
-- copied here rather than referenced, or the record is empty by the time it is
-- read. Retention is part of the #253 review.
CREATE TABLE IF NOT EXISTS reports (
    id           text        PRIMARY KEY,
    room_id      text        NOT NULL,
    kind         text        NOT NULL CHECK (kind IN ('message', 'member', 'room')),
    reporter_sub text        NOT NULL DEFAULT '',
    subject_id   text        NOT NULL DEFAULT '',
    content      text        NOT NULL DEFAULT '',
    reason       text        NOT NULL DEFAULT '',
    created_at   timestamptz NOT NULL DEFAULT now()
);

-- The operator reads newest-first.
CREATE INDEX IF NOT EXISTS reports_created_at_idx ON reports (created_at DESC);
