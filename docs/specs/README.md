# Specs

One file per feature, written before implementation and kept alongside the code
it describes. Committed deliberately: this repo is built in public, and a spec
that only exists on one machine cannot be reviewed, linked from an issue, or
read by a contributor.

Naming is either `<issue-number>-<slug>.md` for work that started from an issue,
or `<feature-id>-<slug>.md` for the lettered feature track (F1, F4, F8, E1).

Each spec carries the issue link, a status, and a date in its header. Status is
`spec` while it is a proposal, and is not rewritten after implementation: the
git history is the record of what changed, and a spec is a snapshot of the
intent at the time it was written.

## What does not live here

`docs/adr/`, `docs/rfc/`, `docs/runbooks/` and `docs/failures/` are gitignored
and local-only. That split is deliberate for host-specific operational detail,
but it has a real cost: see #269 and #256. Anything a contributor needs in order
to make a correct decision belongs in a committed file.
