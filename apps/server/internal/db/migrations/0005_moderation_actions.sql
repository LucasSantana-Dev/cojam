-- Moderation audit trail (#259). chat.delete and room.kick previously left only
-- a stdout log line, which is unqueryable and gone when the container recycles.
CREATE TABLE IF NOT EXISTS moderation_actions (
    id            text        PRIMARY KEY,
    room_id       text        NOT NULL,
    action        text        NOT NULL CHECK (action IN ('chat.delete', 'room.kick')),
    actor_user_id text        NOT NULL DEFAULT '',
    subject_id    text        NOT NULL DEFAULT '',
    created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS moderation_actions_room_idx
    ON moderation_actions (room_id, created_at DESC);
