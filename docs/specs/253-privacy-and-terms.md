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
3. **Spotify requires a published privacy policy** as a condition of API
   access.

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
- No third-party analytics or tracking exists. First-party product events do
  (section 8, added 2026-10-09 in the same change that introduced them), kept
  in CoJam's own Postgres. Any further collection must change the policy in
  the same PR.

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

Product events (section 8) are kept **13 months**, then purged by the
retention sweep (`retention_purged_total{table="product_events"}`). The window
is a constant in `cmd/server/events.go`, not an environment variable, because
the policy states it.

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
- Each user's relationship with Spotify or YouTube is governed by that
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
- The product events description in section 8 and the policy table agree with
  `docs/observability-metrics.md` (events, props, retention) in the same PR.

## 8. First-party product events (owner decision 2026-10-09)

Decision: "Tabela de eventos propria". Product events live in CoJam's Postgres
(`product_events`), with no IP, no nickname, no chat text, deleted after 13
months, read later through aggregated Grafana dashboards. Until now the policy
promised only counts (the browser telemetry of 245/251, Prometheus counters).
This section is what makes the wider promise true; `/privacidade` sections 3, 4,
5 and 8 were updated in the same change.

### 8.1 What is recorded

Eight event names, exact strings in `internal/events`: `room_created`,
`room_joined`, `track_started`, `track_skipped`, `track_liked`, `search`,
`provider_connected`, `listener_peak`. Each row is `at`, `name`, `room_hash`,
`actor_hash` and a small `props` object whose keys and values are an allowlist
enforced in code (an unknown key or value is dropped before it is buffered).

`room_hash` and `actor_hash` are the first 16 bytes of HMAC-SHA256 over the
room id or the connection identity, keyed by `EVENTS_HMAC_KEY`. Room ids are
capabilities (spec 245 section 2.5), so the clear value is never stored.

### 8.2 What is not recorded

IP address, display name, chat text, search text, track titles and artists, the
clear room id, the clear guest identifier, Spotify tokens or scopes.

### 8.3 Pseudonymised, not anonymous

The same input always yields the same hash, which is what lets a dashboard
count distinct rooms and people. Whoever holds the key and a candidate id can
recompute the hash, so under LGPD these are **pseudonymised personal data**, not
anonymised data (art. 13 paragraph 4 and art. 12). The policy says so in plain
words. Guests without room auth get a per-connection actor, so they are not
linkable across visits; users with an anonymous or account sub are stable.

### 8.4 Balancing test (legitimo interesse, art. 7 IX and art. 10)

Drafted by engineering to hand to the reviewer. Not reviewed by a lawyer.

- **Purpose.** Understand how CoJam is used (do rooms get created and shared,
  do tracks play, do people skip, which provider) so the product can be
  improved. Legitimate, specific and stated on the policy.
- **Necessity.** Aggregate Prometheus counters already answer "how many". They
  cannot answer "how many distinct rooms" or "what share of rooms ever had a
  second listener" without a per-room identifier, and they vanish on restart.
  The data collected is the minimum for those questions: a pseudonymous room
  and actor, an event name and enum props. No content, no identity, no IP.
- **Balancing and safeguards.** Impact on the person is low: the data is
  behavioural at the level of "a track started", cannot be tied to a name or an
  IP from the table alone, and is never used to profile, target or sell.
  Safeguards: keyed hashing; allowlisted props; 13 month retention with an
  automatic purge; RLS on with no policy for anyone but a read-only role that
  sees only the table's non-id columns; access through aggregated dashboards.
  Reasonable expectation: a shared listening room is a social product and its
  operator measuring room and track counts is expected, but the policy states
  it up front. A minor-specific concern (ECA Digital) is limited by the same
  minimisation: nothing recorded reveals who a minor is.
- **Objection.** The policy gives the contact for objection (art. 18
  paragraph 2). Honouring it needs the person's identifier to find their
  hashes; the operational procedure is a `[[CONFIRMAR]]` item on the page, not
  yet implemented (a suppression list would be the mechanism).
- **Open items for the reviewer.** Whether pseudonymised events need a DPIA
  line in the records of processing; whether the minimum age text must mention
  events for the public directory; whether a longer or shorter window fits.

### 8.5 Operations

`EVENTS_HMAC_KEY` must be set in production (32 or more random bytes). Without
it each boot uses a random key and hashes do not compare across restarts.
`FEATURE_PRODUCT_EVENTS=false` turns the writer off; the purge still runs
whenever a database exists, so earlier rows keep the 13 month promise. The
dashboard role is `observability/postgres/grafana-ro.sql`.
