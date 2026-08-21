# 244: Redis broker and the horizontal-scale ceiling

Issue: [#244](https://github.com/LucasSantana-Dev/cojam/issues/244)
Status: spec, ready for review
Date: 2026-08-20

## 0. What is actually true today

CoJam runs exactly one server process, and there is currently no way to run two.
This is not a configuration gap; several pieces of state are process-local by
construction.

`cmd/server/main.go:119` builds the centrifuge node with no `Broker` and no
`PresenceManager`, so centrifuge falls back to its in-memory implementations. A
publication reaches only the clients connected to that process.
`github.com/redis/rueidis` appears in `go.mod` as an **indirect** dependency
pulled in by centrifuge and is unused.

Everything else follows from that.

### State inventory

| State | Where | Survives restart | Cross-instance today |
| --- | --- | --- | --- |
| `RoomState` (queue, now playing) | Postgres via `store`, version-guarded | yes | yes, through the store |
| Publications | centrifuge memory broker | no | **no** |
| Presence | centrifuge memory presence | no | **no** |
| `members`, `roomMembers`, `memberJoinTimes` | `Hub` maps (`hub.go:447-451`) | no | **no** |
| `clientUserID`, `clientName` | `Hub` maps | no | **no** |
| Chat ring | `Room.chat` (`hub.go:202`) | no, deliberately | **no** |
| Rate limiter buckets | `Hub` limiters | no | **no** |
| `lastActivityUnix`, `sharedObserved` | `Room` atomics | no | **no** |

Only the first row is ready for more than one process.

## 1. Goal and non-goals

**Goal.** Two or more server instances behind one load balancer serve the same
room correctly: a mutation on instance A reaches a client on instance B, and
presence is the union across instances.

**Why it matters beyond scale.** Single-instance means **every deploy drops
every live room**, and a single machine failure is a total outage. Zero-downtime
deploys are the near-term payoff, not throughput. Today's traffic does not need
two instances; today's deploy story does.

**Non-goals.**

- Multi-region. One Redis, one region.
- Sharding rooms across instances. Any instance serves any room.
- Removing Postgres. Redis carries ephemeral fan-out state; Postgres stays the
  durable record.
- Making the chat ring durable. It is deliberately ephemeral (`hub.go:199-202`)
  and stays that way.

## 2. The five problems, in dependency order

### 2.1 Broker and presence (the enabling change)

Wire `centrifuge.RedisBroker` and `centrifuge.RedisPresenceManager` when
`REDIS_URL` is set. Unset keeps today's in-memory behaviour so local dev and the
test suite need no Redis.

This alone fixes publications and presence. It does not fix 2.2 to 2.5, and
shipping it without them produces subtler bugs than not shipping at all, which
is why this spec treats them as one unit.

### 2.2 Hub membership maps

`members`, `roomMembers`, `memberJoinTimes`, `clientUserID` and `clientName` are
authoritative for "who is in this room" and are process-local. With two
instances each has a partial view, so `room.list` counts are wrong, presence
disambiguation (#170) sees only local names, and moderation (`room.kick`) can
only reach locally-connected clients.

Centrifuge's presence already carries per-client `ConnInfo`. The work is to make
these maps a **cache of presence** rather than the source of truth, and to read
through to presence for anything cross-instance. Closed issue #197 removed
`O(allClients)` membership scans on hot paths, so whatever replaces them has to
keep that property: a presence round-trip per queue mutation is not acceptable.

This is the largest piece of the work and the one most likely to produce
regressions.

### 2.3 Chat ring

`Room.chat` is per-process, so with two instances two members in the same room
see two different histories, and `chat.history` returns whichever fragment the
serving instance happens to hold. Silent divergence, no error.

Options, in order of preference:

1. **Redis list per room**, capped with `LTRIM` to the current ring size. Keeps
   the ephemeral property (Redis eviction or TTL), fixes divergence, adds one
   round-trip per send.
2. Publish chat through centrifuge and keep a local ring per instance,
   accepting that late joiners get only what their instance saw. Cheaper, but
   the divergence is exactly the bug.

Take option 1. Option 2 trades a correctness bug for a round-trip.

### 2.4 Rate limiters

`fanoutLimiter`, `voteLimiter`, `chatLimiter` and `listLimiter` are per-process
token buckets. With N instances the effective limit is N times the intended one,
and a client that reconnects to a different instance gets a fresh bucket.

`fanoutLimiter` is the one that matters: it exists to protect third-party API
quota (Spotify, YouTube), and quota is global. N instances means N times the
burst against a fixed quota.

Move `fanoutLimiter` to Redis. `chatLimiter`, `voteLimiter` and `listLimiter`
protect the server itself, which scales with instance count, so per-instance
buckets are defensible there. Document that choice rather than leaving it
implicit.

### 2.5 Idle eviction

`cmd/server/main.go:175` reaps persistent rooms using process-local membership.
In a cluster it can **delete a room row while another instance still has members
in it**. The README already flags `ROOM_PERSIST_IDLE_TTL_MINUTES` as
single-instance only, which is this constraint surfacing.

Two viable approaches:

1. Leader lock in Redis (`SET NX PX`, renewed) so exactly one instance evicts.
2. Check cluster-wide presence instead of `h.members` before deleting.

Prefer 1. It is smaller, and `store.DeleteIdleRooms` already takes a `protected`
set, so the leader can build that set from cluster presence and reuse the
existing query unchanged.

## 3. Room state under two writers

`store.Postgres.Save` is a version-guarded upsert that applies only when the
incoming version is newer, and reports rejections through
`WithVersionGuardObserver` (`postgres.go:84-108`, from #194). So concurrent
writers do not corrupt state; the loser is rejected.

What is untested is the **hub's** behaviour when that rejection happens under
genuine cross-instance concurrency. Today a rejection is nearly impossible, so
the path is effectively unexercised. Needs a test that drives two hubs against
one Postgres and asserts the loser reloads and retries rather than silently
dropping the mutation, which is the #194 failure mode in a new setting.

## 4. Rollout

Ship the whole thing behind `REDIS_URL`, then:

1. Deploy with `REDIS_URL` set, still **one** instance. Redis is now in the
   path, and any bug in the broker wiring shows up without a second instance to
   confuse the diagnosis.
2. Soak. Confirm publications, presence, chat history and rate limiting behave
   exactly as before.
3. Scale to two instances. This is the moment 2.2 to 2.5 are actually tested.
4. Only then enable `ROOM_PERSIST_IDLE_TTL_MINUTES`, which is the one setting
   that can lose data if the leader lock is wrong.

Redis becomes a hard dependency for the deployed instance at step 1. It is a new
failure mode, and it is worth naming: if Redis is down, rooms stop working, where
today they would not. Given the deployment is self-hosted alongside Postgres,
that is an acceptable trade, but it needs a healthcheck and an entry in the
readiness probe.

## 5. Acceptance criteria

- Two instances behind one load balancer: a `queue.add` on A reaches a client on
  B within the normal publication latency.
- Presence is the union across instances; `room.list` counts match reality.
- `chat.history` returns the same messages regardless of serving instance.
- `room.kick` reaches a client connected to the other instance.
- `fanoutLimiter` is enforced globally: N instances do not multiply the budget.
- Idle eviction never deletes a room that another instance is serving.
- Two hubs against one Postgres: a version-guard rejection causes a reload and
  retry, not a dropped mutation.
- `REDIS_URL` unset boots single-instance with today's behaviour, and the whole
  existing test suite passes untouched.
- `/readyz` reports not-ready when Redis is configured but unreachable.

## 6. Effort and sequencing note

This is the largest item in the backlog and it is worth being honest that
section 2.2 is most of it. If the goal is zero-downtime deploys rather than
throughput, there is a cheaper intermediate: keep one instance and accept a brief
drop on deploy, or add connection draining so clients reconnect to the new
container after it is healthy. That does not need Redis at all.

Worth deciding which problem is actually being solved before starting, because
the cheap path buys most of the near-term value.
