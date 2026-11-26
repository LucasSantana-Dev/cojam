-- Operator block of one person across every room (#259). Closing a room
-- (0009) stops the room, not the person: whoever was reported could open or
-- join another room a minute later. One row per identity the operator acted
-- on, written by `server person`:
--
--   blocked  the running server disconnects every connection with this
--            identity within one poll interval and refuses new connections
--            for it (terminal code 4502).
--
-- user_id is the connection identity: "sb:<uuid>" for an account, the guest
-- id (cojam_uid) otherwise. A block stops one identity, not a person: a
-- blocked account holder can still use CoJam as a guest, and a guest gets a
-- fresh id by clearing the browser's storage. No content lives here; the
-- report id links the row to the case.
CREATE TABLE IF NOT EXISTS person_blocks (
    user_id    text        PRIMARY KEY,
    blocked    boolean     NOT NULL DEFAULT false,
    report_id  text        NOT NULL DEFAULT '',
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

-- The identity of whoever a report is about, resolved by the server when the
-- report is filed (member reports name a connection, message reports a chat
-- line; neither survives the connection). Empty when the subject had already
-- left, the report is about a room, or the connection carried no identity.
-- `server person --report <id>` reads it, so the operator can block the
-- person a report names without ever seeing their id elsewhere.
--
-- subject_sub comes from the server, but the content and reason the operator
-- reads come from the reporter, who could point a report about "X" at
-- someone else's connection. subject_name (the display name the server had
-- for that connection or chat line) and subject_text (the chat line as the
-- server stored it, message reports only) let `server person --report` show
-- what the server saw next to what the reporter wrote, and refuse a mismatch.
ALTER TABLE reports ADD COLUMN IF NOT EXISTS subject_sub  text NOT NULL DEFAULT '';
ALTER TABLE reports ADD COLUMN IF NOT EXISTS subject_name text NOT NULL DEFAULT '';
ALTER TABLE reports ADD COLUMN IF NOT EXISTS subject_text text NOT NULL DEFAULT '';
