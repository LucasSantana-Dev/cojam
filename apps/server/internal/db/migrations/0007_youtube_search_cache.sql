-- YouTube search results survive a deploy. search.list costs 100 of the 10,000
-- daily quota units, and the in-memory cache is wiped by every restart, so the
-- same queries were paid for again after each deploy. One row per lowercased
-- "title artist" query, holding the candidates WITH their durations (the
-- catalogue duration differs by provider and is applied after the cache).
-- Written with a 30 day TTL, or 24 hours for an empty result; errors are never
-- stored. Rows past expires_at are ignored on read and purged at startup.
CREATE TABLE IF NOT EXISTS youtube_search_cache (
    query_key  text        PRIMARY KEY,
    candidates jsonb       NOT NULL,
    expires_at timestamptz NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS youtube_search_cache_expires_at_idx
    ON youtube_search_cache (expires_at);
