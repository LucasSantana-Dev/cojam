CREATE TABLE IF NOT EXISTS rooms (
    room_id    text        PRIMARY KEY,
    state      jsonb       NOT NULL,
    version    bigint      NOT NULL,
    updated_at timestamptz NOT NULL DEFAULT now()
);
