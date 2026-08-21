# 268: External uptime checking

Issue: [#268](https://github.com/LucasSantana-Dev/cojam/issues/268)
Status: partially implemented (PR #271); external check outstanding
Date: 2026-08-20

> Written after the implementation rather than before it, which is the wrong
> order and is noted here rather than hidden. The endpoint in PR #271 is twenty
> lines reusing an existing handler, so the rationale went into the PR body and
> commit message. Recorded properly now so the spec set is complete.

## 1. What happened

On 2026-08-20 `cojam.lucassantana.tech` returned 502 on every request for
roughly eight hours. Nothing alerted. The outage was found by accident, while
attempting the #199 launch-gate verification.

## 2. Why every existing signal missed it

This is the useful part. Four independent health signals were all reporting
green throughout.

- **Container healthchecks probe from inside the container.** `cojam-web` runs
  `wget --spider http://127.0.0.1:3000/` in its own namespace. The fault was
  that the *published* port had moved off loopback, which an in-container probe
  structurally cannot detect.
- **`/readyz` is not publicly routed.** The proxy sends only `/connection/*` and
  `/api/*` to the Go server.
- **Healthchecks, the uptime monitor, was itself down**, broken by the same
  `BIND_IP` cause. A monitor sharing fate with what it monitors is not a monitor.
- **Prometheus metrics were unconfigured** in production (`METRICS_ADDR` unset,
  confirmed by #199), so even the private signal was absent.

Every layer measured something other than what a user experiences.

## 3. The trap that made this hard to fix

The obvious probe target is `/healthz`. It is the wrong one: it belongs to the
Go server, and the proxy does not route it publicly, so a public `/healthz`
lands on the Next app and returns **404 even when everything is healthy**.

Pointing an uptime check at it produces a permanently-failing check, which gets
muted, which is worse than no check at all.

I made this mistake myself during the #264 diagnosis and reported the 404 as a
regression before working out it was correct.

## 4. Implemented (PR #271)

`GET /api/healthz` returning `{"status":"ok"}`, under a path the proxy already
forwards, so no proxy change is needed. Reaching it exercises the whole public
path: edge, tunnel, proxy, container.

Two deliberate omissions:

- **No build version**, unlike the private `/healthz`. This one is
  internet-facing and the stamp only helps fingerprint the deployment. Both
  directions are tested so neither drifts.
- **No public readiness endpoint.** Readiness exists for the proxy, which can
  reach the server port directly. Exposing database reachability to the internet
  leaks infrastructure state for no gain.

## 5. Outstanding

The check itself, which is configuration rather than code:

- Probe `https://cojam.lucassantana.tech/api/healthz` **and** `/` — they fail
  independently and route to different containers.
- Every minute or two; alert after 2 or 3 consecutive failures.
- **Hosted off the CoJam host.** This is the requirement, not a detail. The
  monitor must not share fate with the monitored.

## 6. Also worth fixing

Container healthchecks should assert the **published binding**, not in-container
liveness. A healthcheck that cannot fail when the service is unreachable is not
measuring anything useful, and that is precisely how eight hours passed.

## 7. Acceptance criteria

- An external check runs from outside the host against both paths.
- Killing the container produces an alert within minutes.
- Breaking the published binding (the #264 fault) produces an alert. This is the
  case every previous signal missed, so it is the one worth testing deliberately.
- Alert delivery does not depend on the CoJam host.
