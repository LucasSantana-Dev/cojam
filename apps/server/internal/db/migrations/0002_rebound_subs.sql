CREATE TABLE IF NOT EXISTS rebound_subs (
    sub         text        PRIMARY KEY,
    consumed_at timestamptz NOT NULL DEFAULT now()
);
