-- Server-side custody of Spotify refresh tokens (#252), keyed to the connauth
-- anonymous sub. sealed_token is AES-GCM ciphertext, never plaintext: a dump of
-- this table must not hand over live Spotify credentials.
CREATE TABLE IF NOT EXISTS spotify_tokens (
    sub          text        PRIMARY KEY,
    sealed_token text        NOT NULL,
    expires_at   timestamptz NOT NULL,
    updated_at   timestamptz NOT NULL DEFAULT now()
);

-- Supports the expiry sweep that stops an abandoned guest session leaving a
-- live refresh token behind.
CREATE INDEX IF NOT EXISTS spotify_tokens_expires_at_idx
    ON spotify_tokens (expires_at);
