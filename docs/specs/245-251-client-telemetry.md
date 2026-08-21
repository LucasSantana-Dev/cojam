# 245 + 251: Client error tracking and product analytics

Issues: [#245](https://github.com/LucasSantana-Dev/cojam/issues/245),
[#251](https://github.com/LucasSantana-Dev/cojam/issues/251)
Status: spec, ready for review
Date: 2026-08-20

## 1. The decision, and why it is not Sentry or PostHog

Both issues were written assuming a third-party vendor: Sentry for errors,
Plausible or PostHog for analytics. Looking at what CoJam already runs, that is
the wrong shape.

**What exists.** `internal/obs` already exports a well-populated Prometheus
surface (`RPCDuration`, `StoreErrors`, `RateLimitRejected`, `PublishErrors`,
`VotesCast` and more) on a private listener per ADR-0004. The Go server emits
structured JSON to stdout. The host runs Grafana. `chi`'s `middleware.Recoverer`
is already wired at `cmd/server/main.go:516`, so server-side panics are caught.

**What is missing is narrower than "error tracking" and "analytics".** It is:

1. Client-side errors never reach the server at all.
2. Nothing counts product events, so activation and retention are unmeasurable.

**Decision: one server endpoint feeding the metrics stack that already exists.**
No new vendor, no new runtime dependency, no data leaving the host. This follows
the operator's zero-cost posture (the reason the Fly.io path was deleted in
`c3e63c7`) and reuses infrastructure rather than adding a parallel one.

Cost of the alternative, stated so the decision is reversible on evidence:
Sentry gives stack-trace grouping, release health and source-map symbolication
that this design does not. If client errors become frequent enough that grouping
matters, revisit. Self-hosted GlitchTip is Sentry-API-compatible and would fit
the same posture.

## 2. Design

### 2.1 One endpoint

`POST /api/telemetry` on the Go server, which already owns `/api/*` behind the
proxy.

```jsonc
{
  "type": "error" | "event" | "vital",
  "name": "string",        // bounded set, see 2.3
  "value": 0,              // vitals only
  "detail": "string"       // errors only, truncated
}
```

Deliberately not a batch endpoint and deliberately not extensible: an
unauthenticated write endpoint on a public host is attack surface, and every
field is one more thing to validate.

### 2.2 What it does

- `error` → increments `ClientErrors{name}` and emits one slog line at warn.
- `event` → increments `ProductEvents{name}`.
- `vital` → observes into a `WebVitals{name}` histogram.

Grafana already reads Prometheus, so dashboards need no new plumbing.

### 2.3 Names are a server-side allowlist, not free text

This is the part that matters. `name` is validated against a fixed list and
anything else is rejected with 400.

Rationale: a free-text label on a Prometheus metric is a **cardinality bomb**.
An attacker, or an ordinary bug generating unique error strings, creates
unbounded time series and takes down Prometheus. This is the single most likely
way this feature causes an outage.

Initial allowlist:

| Type | Names |
| --- | --- |
| `event` | `landing_view`, `room_create`, `room_join`, `second_listener`, `track_added`, `provider_connected` |
| `vital` | `LCP`, `INP`, `CLS` |
| `error` | `boundary_segment`, `boundary_root`, `ws_terminal`, `playback_failed`, `token_refresh_failed` |

`second_listener` is the one that matters most: it is the real activation event
for a co-listening product. A room with one person in it is not the product.

### 2.4 Abuse controls, non-negotiable

The endpoint is unauthenticated and public. It needs:

- **Rate limiting per caller**, following the existing `rateLimiter` pattern in
  `internal/hub/hub.go:266-285`. Its own bucket, not `fanoutLimiter`, since no
  third-party API is involved.
- **Body size cap.** `internal/httpx` already establishes `MaxResponseBytes` for
  outbound; this is the inbound counterpart. A few KB is generous.
- **`detail` truncated server-side**, rune-safe. Closed issue #185 fixed exactly
  this class of bug for chat truncation; reuse that helper rather than slicing
  bytes.
- **Rejected names counted**, so a misbehaving client is visible rather than
  silently dropped.

### 2.5 No PII, enforced by shape

The schema has nowhere to put a display name, room ID or token, which is the
point. `detail` is the only free-text field and carries an error message.

Client-side, `detail` must be the error **type and message**, never a stack
trace or a URL, since room IDs are capabilities and a URL leaks one.

## 3. Client side

- Wire `error.tsx` and `global-error.tsx` (from #249, PR #263) to post
  `boundary_segment` / `boundary_root`. They currently `console.error` with a
  comment pointing at this issue.
- `useReportWebVitals` for LCP, INP and CLS.
- Fire the six product events at their natural call sites.
- **Fire and forget.** Telemetry must never block, retry aggressively, or
  surface a failure. A failed `POST /api/telemetry` is a no-op; use
  `navigator.sendBeacon` where the page may be unloading.
- Behind `COJAM_FEATURE_TELEMETRY`, default off, so it ships dark and can be
  disabled without a rebuild (RFC-0006).

## 4. Privacy interaction

LGPD requires disclosing what is collected. This design keeps that disclosure
short and true: counts of named events, no identifiers, no cross-session
linkage, nothing leaving the host.

That is a materially better privacy story than any third-party analytics, and it
should be stated in the policy rather than buried. #253 section 2.4 currently
says no analytics exist; it must be updated **in the same PR** that lands this.

## 5. What this deliberately does not do

- **No per-user funnels or cohort retention.** Counters cannot answer "did this
  specific user come back". If that becomes the question, this design is the
  wrong tool and PostHog is the right one. Say so then rather than bolting
  identity onto this.
- **No session replay.**
- **No stack-trace grouping.** See section 1.

## 6. Acceptance criteria

- `POST /api/telemetry` accepts the allowlisted names and rejects everything
  else with 400.
- An unknown name cannot create a Prometheus series. Test this explicitly; it is
  the failure mode that takes down the metrics stack.
- Rate limiting and body caps enforced, with a test for each.
- `detail` truncation is rune-safe (#185 regression guard).
- Error boundaries report; a deliberate client error appears as a counter
  increment and a log line.
- Web vitals arrive from a real session.
- The activation funnel is visible in Grafana end to end, including
  `second_listener`.
- Flag off means zero requests from the client.
- #253 updated in the same PR.
