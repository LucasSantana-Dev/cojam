# 259: Minor safety and reporting under ECA Digital

Issue: [#259](https://github.com/LucasSantana-Dev/cojam/issues/259)
Status: spec, ready for review
Date: 2026-08-20

> **Not legal advice.** This spec covers the product mechanism. The scope of the
> legal obligation needs a qualified Brazilian lawyer, and that review should
> happen before, not after, this is built: it determines how much of section 3
> is actually required.

## 1. This is live exposure, not a future risk

Confirmed against production on 2026-08-20, from `/env.js`:

```json
"features":{"spotify":true,"roomAuth":true,"queueVoting":true,"roomChat":true,"publicRooms":true}
```

So the currently-serving surface is:

- a **browsable directory of public rooms** on the landing page
- **live chat** in every room
- **guest join with no account required**
- **no age signal, no reporting route, no moderation audit trail**

ECA Digital (Lei 15.211, signed 2025-09-17, enforcement decree 2026-03-18) is
the law the AGU used in August 2026 to force Discord to suspend its livestream
feature after a 13-year-old's death. A directory of stranger rooms with live
chat and anonymous access is closer to that surface than is comfortable.

The original backlog ranked this on the assumption it was theoretical. It is
not.

## 2. Immediate mitigation, available today

`FEATURE_PUBLIC_ROOMS` and `COJAM_FEATURE_PUBLIC_ROOMS` both default to `false`
in `compose/cojam.yml`; they are on by explicit opt-in. Setting them to `false`
and recreating the two containers removes the directory in about a minute.

**This is a product decision, not an engineering one**, and it trades real value
against a legal exposure only the operator can weigh. It is recorded here as an
available option, deliberately not taken unilaterally.

Note the asymmetry: a room reached by an invite link is a very different
exposure from a directory that surfaces stranger rooms to anyone. Chat and
voting can stay on while the **directory** goes off, and that is probably the
right shape if a middle option is wanted.

## 3. What is missing

### 3.1 Age signal

There is none anywhere. The minimum age must be stated in the terms (#253) and
collected at the point of first join.

Deliberately **not** proposing hard age verification: it is disproportionate for
a hobby project, it collects far more personal data than the current design (a
privacy harm of its own), and self-declaration is the norm for comparable
products. What matters is that a stated minimum exists and is asked.

### 3.2 Reporting route

Users cannot report anything. This is the largest single gap: moderation
primitives exist but only the **host** can act, and the host may be the problem.

Needed:

- report a chat message
- report a user
- report a room (chiefly for the public directory)

Reports must reach the operator somewhere actually monitored. Email or a
webhook; the point is that an unread queue is the same as no reporting route.

### 3.3 Moderation audit trail

`chat.delete` and `room.kick` (#181) leave no durable record.
`internal/hub/moderation.go:61` logs `chat_deleted` to stdout, which is not an
audit trail: it is unqueryable, unretained, and gone when the container recycles.

If an incident is investigated, "what was removed, by whom, when" must be
answerable. A `moderation_actions` table is the smallest thing that works.

### 3.4 Escalation path

For a report indicating a minor at risk, a documented path with an actual
response commitment. This is a runbook, not code, and it is the part most likely
to be skipped and most likely to matter.

## 4. What already helps

Worth stating, because the gap is narrower than it first looks:

- `chat.delete` and `room.kick` exist (#181)
- chat is rate-limited (`internal/hub/chat.go:29-38`)
- chat is **ephemeral and never persisted** (`hub.go:199-202`), which limits
  what can be recovered but also limits standing exposure
- rooms are capability-URLs (12-char crypto-random), so non-public rooms are not
  discoverable
- the public flag is host-set and opt-in per room

## 5. Design notes

**Reporting must work for guests.** Most users are guests; a reporting route
that requires an account misses the population it exists to protect.

**Reports are abuse surface.** They are an unauthenticated write from the
public internet, so they need the rate-limiter pattern from
`internal/hub/hub.go:266-285`, a body cap, and rune-safe truncation (the #185
class of bug).

**Do not build a moderation queue UI.** At this scale, reports going to an inbox
the operator reads is sufficient and honest. Building a console for a product
with no moderators is the wrong shape.

## 6. Acceptance criteria

- Minimum age stated in the terms and collected at first join.
- Report a message, a user, and a room, all available to guests.
- Reports reach a monitored destination, verified end to end once.
- Moderation actions produce a durable, queryable record.
- Escalation path documented with a response commitment that can actually be met
  by one person.
- Reporting endpoints rate-limited, body-capped, rune-safe.
- Legal review completed and its conclusions recorded, including whether the
  public directory can stay on.

## 7. Sequencing

Section 2 (turn the directory off) is available now and needs no code. Everything
else should follow the legal review, because the review determines how much of
section 3 is obligation and how much is good practice.

Do not ship section 3 as a way of avoiding the section 2 decision. They answer
different questions, and the exposure is live in the meantime.
