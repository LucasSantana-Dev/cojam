-- Operator restrictions on a room (#259). The terms (/termos, section 5) say
-- the operator can end rooms and block access; until now nothing in the code
-- backed that. One row per room the operator acted on:
--
--   closed      the room is ended: connected members are disconnected and
--               every rejoin is refused, by the running server within one
--               poll interval (cmd/server, `server room`).
--   legal_hold  the room's reports and moderation actions are kept past
--               REPORT_RETENTION_DAYS and survive `server erase`, so an
--               open case does not lose its evidence to an age-only purge.
--
-- Closing a room also sets the hold: a closure follows a report, and that
-- report is the evidence. No content and no personal data live here; the
-- report id only links the row to the case.
CREATE TABLE IF NOT EXISTS room_restrictions (
    room_id    text        PRIMARY KEY,
    closed     boolean     NOT NULL DEFAULT false,
    legal_hold boolean     NOT NULL DEFAULT false,
    report_id  text        NOT NULL DEFAULT '',
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);
