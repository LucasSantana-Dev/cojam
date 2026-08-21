# 253: Privacy policy and terms of service

Issue: [#253](https://github.com/LucasSantana-Dev/cojam/issues/253)
Status: spec, ready for review
Date: 2026-08-20

> **This spec is not legal advice.** It is an engineering inventory of what
> CoJam actually collects, retains and shares, written so a qualified Brazilian
> lawyer can turn it into a policy without first having to read the codebase.
> The drafted text must be reviewed before external users are invited.

## 1. Why this blocks launch

CoJam is live at a public hostname, holds user accounts and OAuth grants to
third-party services, and is aimed at a Brazilian audience. Three separate
things depend on having a published policy:

1. **LGPD** (Lei 13.709) requires a stated lawful basis, disclosure of what is
   collected and why, retention periods, and a route for data-subject requests
   including deletion.
2. **ECA Digital** (Lei 15.211) adds duties for platforms accessible to minors.
   The product-side obligations are #259; the disclosure side is here.
3. **Spotify and Apple both require a published privacy policy** as a condition
   of API access. The Apple Music work (#207) will need one before review.

## 2. Data inventory, from the code

This is the part that must be accurate. Everything below is what the system
actually does today, not what a template would assume.

### 2.1 Collected from every user, including guests

| Data | Where it lives | Source |
| --- | --- | --- |
| Display name | `Hub.clientName`, presence, and stamped into queue attribution | `room.join` param |
| Guest identity (`clientID` / anon sub) | Browser-local, plus connection JWT | `internal/connauth` |
| Room membership and join time | `Hub.members`, `memberJoinTimes` | in-memory |
| Queue entries and who added them | `RoomState.queue`, Postgres | `queue.add` |
| Votes, keyed to `user:<id>` or `client:<id>` | `RoomState.votes`, Postgres | `queue.vote` |
| Chat messages | `Room.chat`, in-memory ring only | `chat.send` |
| Reports | durable, and they **copy** the reported content | member action (#259) |
| Host-set room name and public flag | `RoomState.name`, `RoomState.public` | host action |

Note that **votes are personal data**: they associate an identity with a
preference, and they are persisted to Postgres inside `RoomState`.

Chat is **not** persisted (`internal/hub/hub.go:199-202`) and dies with the
room. Say so in the policy; it is a genuinely good answer.

The one exception is a **report**: filing one copies the message content into a
durable record, because the chat line it concerns is usually gone by the time
anyone reads the report. So the lawful basis for reports is compliance with a
legal obligation, not consent.

**Report retention is not yet set, and the policy cannot publish without it.**
It is a different question from room retention (30 days) because the basis
differs: a report may need to outlive the room it concerns, and under ECA
Digital the retention that matters is however long an authority could ask about
the incident. That number is a legal answer, not an engineering one, and it is
the second thing to bring to the review alongside the minimum age. Until it is
set, reports accumulate without a defined lifetime, which is itself a finding.

Decisions behind this spec are recorded in `docs/adr/`: ADR-0006 (connection
draining, and why chat stays ephemeral and dies on deploy) and ADR-0007
(accepting the YouTube ToS risk for video co-watch).

### 2.2 Collected from account users

Supabase `profiles` and `connected_services`. Note that Supabase auth is
currently disabled in production and the configured project was deleted (#265),
so the policy should describe accounts only if they are re-enabled.

### 2.3 Third-party processors

Every one of these must be named:

| Processor | What reaches it | Why |
| --- | --- | --- |
| Spotify | OAuth grant, playback commands from the user's own browser | playback and matching |
| YouTube | search terms, video IDs, playback from the user's browser | playback and matching |
| Deezer | search terms | keyless search fallback |
| MusicBrainz, Last.fm, ListenBrainz | track metadata queries | enrichment |
| Supabase | account identifiers, if accounts are enabled | auth |
| Cloudflare | all request traffic, including IP addresses | TLS and tunnel |

Cloudflare is easy to forget and sees every request.

### 2.4 Not collected

Worth stating positively, because it is unusual and it is the product's whole
architecture:

- **No audio or video ever passes through CoJam's servers.** Each listener plays
  on their own account through the provider's own SDK.
- No analytics or tracking exists today (#251 is unimplemented). If it lands,
  the policy must change with it, in the same PR.

## 3. Retention, from the configuration

Retention claims must match the code, or the policy is false:

- `ROOM_IDLE_TTL_MINUTES` (default 30) evicts memberless rooms from memory.
- `ROOM_PERSIST_IDLE_TTL_MINUTES` deletes room **rows**. It is unset in
  production today, which means `0`, which means disabled, which means
  **persisted rooms are currently retained indefinitely**.
- Chat is ephemeral and dies with the room in memory. Deploys also end it, by
  decision (ADR-0006).

**Decided 2026-08-20: 30 days** (`ROOM_PERSIST_IDLE_TTL_MINUTES=43200`), to be
set before the policy is published. A room idle for 30 days is dead, and the
queue is not worth the retained data. Deleting the row does not break the link:
`GetOrCreateRoom` recreates the room empty, so the capability still works and
only the queue is lost.

The previous objection to enabling this was that it is single-instance-only.
ADR-0006 accepts single-instance as the architecture, so that objection is
gone.

Do not publish the policy before the setting is applied. A retention promise
the configuration does not keep is worse than no promise.

## 4. Deletion has to actually work

LGPD gives a right to deletion. Before promising it, verify end to end that a
request can be fulfilled:

- Account deletion in Supabase, if accounts are on.
- Attribution left in `RoomState.queue` by that user.
- Voter keys in `RoomState.votes`.
- Chat authored under that identity (ephemeral, so usually already gone).

`internal/rebind` already rewrites attribution when a guest upgrades to an
account (#172), so the machinery for rewriting identity inside `RoomState`
exists. Deletion can likely reuse it.

## 5. Terms of service

Shorter, and mostly about setting expectations:

- Minimum age, aligned with whatever #259 concludes.
- Acceptable use, and the right to remove content and eject users. The
  primitives exist (`chat.delete`, `room.kick`, #181).
- **CoJam transmits metadata only and never audio.** Legally load-bearing: it is
  why no synchronization or public-performance licence attaches, and it is the
  distinction that separates CoJam from the products that died of licensing cost.
- No warranty; it is a self-hosted hobby project.
- Each user's relationship with Spotify, Apple or YouTube is governed by that
  provider's own terms.

## 6. Implementation

- `/privacy` and `/terms` as real routes in `apps/web/app`, statically rendered.
- Linked from the footer, and from the join and connect flows where consent is
  implied.
- Markdown source in the repo, so changes are reviewable in git rather than
  edited live.
- A `Last updated` date, and a note that continued use after a change
  constitutes acceptance.

## 7. Acceptance criteria

- `/privacy` and `/terms` are reachable and linked.
- Every processor in section 2.3 appears in the policy.
- Retention statements match the deployed configuration, including the current
  indefinite-retention default if that is not changed first.
- A deletion request can be fulfilled end to end, demonstrated once.
- Reviewed by someone qualified in Brazilian law **before** external users are
  invited.
- If #251 analytics lands, the policy is updated in the same PR.
