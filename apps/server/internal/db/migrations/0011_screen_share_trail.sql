-- Screen share (#310). Every share start and end goes to the moderation
-- trail, and a report can be about a broadcast. The trail is the record that
-- answers "who was broadcasting in room X at time T": the share itself lives
-- only in memory and dies with the process.
--
-- The CHECKs were declared inline in 0004 and 0005, so Postgres named them
-- <table>_<column>_check. They are dropped by name: a bare ADD would leave the
-- old CHECK in force and every new value would still fail.
ALTER TABLE reports DROP CONSTRAINT IF EXISTS reports_kind_check;
ALTER TABLE reports ADD CONSTRAINT reports_kind_check
    CHECK (kind IN ('message', 'member', 'room', 'broadcast'));

ALTER TABLE moderation_actions DROP CONSTRAINT IF EXISTS moderation_actions_action_check;
ALTER TABLE moderation_actions ADD CONSTRAINT moderation_actions_action_check
    CHECK (action IN ('chat.delete', 'room.kick',
                      'screen.start', 'screen.stop', 'screen.host_stop', 'screen.refuse'));

-- Session facts for screen rows: display name, start and end (unix ms), peak
-- viewers, the age affirmation and the end reason. No content and no network
-- addresses. Empty for the older actions.
ALTER TABLE moderation_actions ADD COLUMN IF NOT EXISTS detail jsonb NOT NULL DEFAULT '{}';

-- A broadcast report resolves its subject from the latest screen.start in
-- the room: served by the (room_id, created_at DESC) index from 0005.
