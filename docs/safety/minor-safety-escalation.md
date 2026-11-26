# Reports involving a minor at risk

How CoJam handles a report that a child may be at risk, and what the operator
commits to. Issue [#259](https://github.com/LucasSantana-Dev/cojam/issues/259),
spec [`259-eca-minor-safety.md`](../specs/259-eca-minor-safety.md).

> **Not legal advice.** The scope of the obligations under ECA Digital
> (Lei 15.211) is pending the legal review that #259 and #253 call for. This
> page changes when that review concludes.

## Our commitment

CoJam is run by one person. These are commitments that person can keep:

- A report in the **minor at risk** category is looked at the same day it
  arrives, within **12 waking hours**.
- Every other report is looked at within **72 hours**.
- The report channel is checked at least twice a day.
- When the operator is unreachable for more than **24 hours** (travel,
  illness), the **public room directory is switched off first**. A directory of
  stranger rooms that nobody can answer for is the risk this policy exists to
  limit. Rooms reached by an invite link keep working.

## How to report

Anyone in a room can report a chat message, a member or the room itself, from
inside the room. No account is needed: guests can report. Pick **minor at
risk** when a child may be in danger.

The report keeps a copy of what was reported, because room chat is never
stored and the original is gone once the room ends. The operator is notified
with a summary that carries no chat content and no names.

If you believe a child is in **immediate danger**, do not wait for CoJam:
call **190**. Online child sexual abuse material can be reported directly to
**SaferNet Brasil** at [denuncie.org.br](https://new.safernet.org.br/denuncie).
Violations of children's rights can be reported to **Disque 100**.

## What the operator does

1. **Contain.** End the room (everyone in it is disconnected within seconds
   and nobody can rejoin, by link or by directory), and switch the whole
   directory off when in doubt.
2. **Preserve.** Put the room under legal hold, so its reports and moderation
   record outlive the retention window and any erasure request until the case
   is closed. Ending a room sets the hold too.
3. **Assess.** Read the copied content and record the decision and the reasons.
4. **Escalate.** Where a child is at risk, refer the case to the competent
   authorities. Evidence goes to them directly, never through chat apps.
5. **Close.** Record the outcome. Re-enable the directory only once the cause is
   understood.

Moderation actions taken by room hosts (deleting a message, removing a member)
are recorded with who, what and when, so a case can be reconstructed.

Operators do both with `server room --room <id> --close --apply` (`--hold`
alone preserves without ending; `--reopen` and `--release` undo them, and
`--list` shows what is in force). When the problem is a person rather than a
room, `server person --report <id> --block --apply` disconnects that
identity from every room within seconds, refuses it from then on, and holds
the report's room. The command refuses a report whose content does not match
what the server saw of its subject; check the identity another way before
blocking with `--user`. See `docs/configuration.md`.

## Known gaps

Stated so nobody relies on something that does not exist yet:

- A block stops one identity, not a person. A blocked account holder can sign
  out and come back as a guest, and a guest can come back with a fresh guest
  id. There is no device, address or person-level ban, so a block contains
  someone only for as long as they do not try to get around it.
- A report names the person only if they are still in the room (or their
  message still in the recent chat) when it is filed; otherwise the operator
  needs the identity by other means.
- Ending a room and the legal hold need the database; a deployment without
  `DATABASE_URL` has neither.
