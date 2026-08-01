# 167: Signal that guest identity is browser-local

Issue: #167 (https://github.com/LucasSantana-Dev/cojam/issues/167)
Parent: #140
Status: spec, ready for implementation
Date: 2026-08-01
Scope note: internal design doc, committed alongside docs/rfc/ and docs/adr/ (precedent: PR #146).

## 1. Goal and non-goals

Goal: tell a guest, before and during a session, that their identity lives only in this
browser. Guest identity is bound to localStorage at `apps/web/lib/auth.ts:6-7`. Clearing
site data, switching browsers, or using a private window produces a new identity, which
silently drops the host role and the ability to remove tracks the guest queued. The loss is
invisible until it bites.

Decision: two signals, no gate.

- A guest clearing their browser storage is making a choice. The app should make the
  consequence visible, not block the join or interrupt with a modal.
- Signed-in members already have a durable identity and must not see either signal, or the
  signal becomes noise that trains people to ignore it.

Non-goals:

- No sign-in flow. That is #172, which this slice deliberately precedes so that the honest
  signal ships even if the upgrade path slips.
- No identity export, import, or recovery mechanism.
- No special handling for private browsing. Ephemeral storage there is expected and known.

## 2. Join-form signal

A single line below the join control, shown only when accounts are available and the visitor
is not signed in.

Copy: "Your identity is stored in this browser. Sign in to keep your room role on any
device."

Three things about the wording are deliberate:

- "this browser" is the accurate scope. Not device, not account. localStorage is per browser
  profile, and a user with two browsers open will observe exactly that.
- "room role" names the concrete stake, which is host status and the ability to remove your
  own tracks. "Your data" would overclaim, since the queue itself is shared and persists.
- It states a fact and offers a remedy. No warning icon, no "careful", no alarm styling. The
  situation is normal, and treating it as a hazard would misrepresent it.

Styling follows the existing muted subtitle treatment already used on the join form. No
icon. Not interactive in this slice, because the destination does not exist until #172.

Condition: accounts feature enabled and no active session. If accounts are disabled entirely
the line must not render, since it would advertise a remedy the deployment does not offer.

## 3. In-room signal

A compact "Guest" marker beside the member's own name in the room header, under the same
conditions, once joined.

It repeats the state rather than the explanation. The join form is where the consequence is
explained, at the moment of choosing; the in-room marker is a persistent reminder of which
mode you are in. A guest who is host benefits most: seeing "you are Alice (Guest)" while
holding host makes the fragility legible before the tab closes.

Styling matches the existing room-code chip treatment, muted, no icon.

## 4. Edge cases

- Accounts disabled at deploy: neither signal renders.
- Signed in before joining: neither signal renders.
- Signs in mid-session (once #172 lands): both signals disappear on the next render, since
  both are derived from session state rather than captured at mount.
- Private browsing: signals render normally. The statement stays true, and is arguably more
  useful there.
- Narrow viewport: the join-form line wraps; the in-room marker must not push the room code
  or member name out of the header, so it is the first element to be allowed to truncate.

## 5. Acceptance criteria (mapped to verify commands)

Web (`cd apps/web && npx tsc --noEmit`, `pnpm lint`, `npx vitest run`):

- Join form renders the line when accounts are enabled and no session exists.
- Join form does not render it when accounts are disabled.
- Join form does not render it when a session exists.
- Room header renders the "Guest" marker under the same three conditions, once joined.
- Room header does not render the marker for a signed-in member.
- Copy is asserted verbatim against section 2, so a reword cannot land silently.
- Both signals derive from current session state, verified by re-rendering with a session
  present and asserting both disappear without a remount.

E2E (`pnpm --filter web e2e` only, never raw playwright on :3000):

- Guest opens the join form with accounts enabled: the line is visible. After joining, the
  "Guest" marker is visible in the header.
- With accounts disabled by env, neither is present.
