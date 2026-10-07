-- Retention purge (#319) deletes moderation actions oldest-first by
-- created_at; the existing (room_id, created_at) index cannot serve that.
CREATE INDEX IF NOT EXISTS moderation_actions_created_at_idx
    ON moderation_actions (created_at);
