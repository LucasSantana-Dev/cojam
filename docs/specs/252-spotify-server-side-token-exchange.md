# 252: Move the Spotify token exchange server-side

Issue: [#252](https://github.com/LucasSantana-Dev/cojam/issues/252)
Status: spec, ready for review
Date: 2026-08-20

## 1. The problem, precisely

Spotify tokens are obtained and held entirely in the browser.

- `apps/web/lib/spotifyAuth.ts:115-141` performs the PKCE code-for-token
  exchange with a client-side `fetch` straight to Spotify's token endpoint.
- `apps/web/lib/spotifyAuth.ts:66-77` reads and writes the resulting
  `{accessToken, refreshToken, expiresAt, scope}` to `sessionStorage`.

PKCE protects the **authorization code** in transit against interception. It
does nothing for the tokens once they exist. The refresh token is a long-lived
credential for the user's Spotify account, sitting in web storage where any
script executing on the page can read it.

The production CSP added in #237 raises the bar for getting such a script to
execute, and it is a real mitigation. It is not the fix, and it does not apply
in development: `apps/web/next.config.ts:33` gates the headers on
`NODE_ENV === 'production'`.

### Secondary defect, same file

`refresh()` returns `null` on a failed refresh with no retry and no user-facing
signal. An expired token mid-playback leaves the user silently stuck, with a
connected-looking UI that no longer works. This is the same class as the silent
playback failures fixed in #176, and it should be fixed in the same pass.

## 2. Goal and non-goals

**Goal.** The refresh token never reaches JavaScript. The access token may live
in memory for the Web Playback SDK, and nowhere else.

**Non-goals.**

- Changing what the user sees. The connect flow, the consent screen and the
  redirect all stay as they are.
- Server-side playback. Playback stays in the browser SDK; this is about
  credential custody only.
- Reworking Supabase account auth. Separate concern, see #265.

## 3. Design

### 3.1 Which server

The Go server already holds `SPOTIFY_CLIENT_ID` and `SPOTIFY_CLIENT_SECRET` for
client-credentials matching, and already owns `/api/*` behind the proxy. Put the
new endpoints there rather than in a Next route handler, so there is exactly one
process holding Spotify credentials.

### 3.2 Flow

Unchanged up to the redirect back. `beginAuth` keeps generating PKCE and
redirecting; the verifier stays in `sessionStorage`, which is correct because it
is single-use, short-lived, and useless without the code.

Changed from the callback onward:

1. `/callback/spotify` POSTs `{code, code_verifier, redirect_uri}` to
   `POST /api/spotify/token` instead of calling Spotify directly.
2. The server exchanges the code with Spotify, using the client secret. Keeping
   PKCE as well as the secret is deliberate: it costs nothing and preserves the
   binding between this browser and this code.
3. The server stores the **refresh token** server-side, keyed to the user, and
   returns only `{accessToken, expiresIn, scope}` to the browser.
4. `POST /api/spotify/refresh` returns a fresh access token from the stored
   refresh token.

### 3.3 Where the refresh token lives

**Decided 2026-08-20: key it to the `connauth` anonymous `sub`.**

- **Account users.** The `connected_services` concept in the Supabase schema is
  the natural home and survives across devices.
- **Guests.** `connauth.Mint` already issues a server-signed JWT carrying a
  stable anonymous `sub`, and #172 already accepts that token as proof of
  ownership when rebinding attribution on guest-to-account upgrade. So a
  server-verifiable guest identity **already exists**; the refresh token is
  keyed to that `sub`. The browser only ever holds the access token, in memory.

This reverses an earlier recommendation in this spec, which proposed a new
httpOnly cookie holding an opaque handle. That would stand up a second
guest-identity mechanism beside the `connauth` `sub`, giving two sources of
truth for "who is this guest". Reusing the existing one is smaller and keeps
the identity model singular.

**Residual risk, stated plainly:** whoever holds a guest's connection JWT can
mint Spotify access tokens for that account until the record expires. That is
the same trust level #172 already accepts for attribution rebinding, and it is
strictly better than today, where the refresh token itself sits in
`sessionStorage` and is readable by any script on the page.

The record must expire, so an abandoned guest session does not leave a live
Spotify refresh token indefinitely.

### 3.4 Access token handling in the browser

Hold it in a module-level variable, not `sessionStorage` and not `localStorage`.
It is short-lived, and losing it on reload is fine because `/api/spotify/refresh`
can mint a new one without user interaction.

This is a real behaviour change: today a reload keeps the session from storage.
After this, a reload costs one refresh round-trip. That is the right trade.

## 4. Trade-offs, stated plainly

**Playback now depends on the server for refresh.** If CoJam's server is
unreachable, a user whose access token expires cannot renew it. Previously the
browser could refresh against Spotify directly.

This is acceptable, because the room is useless without the server anyway: the
queue, presence and now-playing all come from it. It does mean a server blip
during a long listening session can interrupt playback where it previously would
not, so the refresh path needs retry with backoff rather than the current
`return null`.

**One more place holding user credentials.** The server becomes a custodian of
Spotify refresh tokens, which is a meaningful obligation: it needs encryption at
rest, and it needs to be covered by the privacy policy (#253). Worth stating
explicitly rather than discovering later.

## 5. Edge cases

- **Consent denied.** `/callback/spotify` receives `error` and
  `error_description`; today the description is parsed but never shown
  (`callback/spotify/page.tsx:15-40`). Surface it.
- **Verifier missing.** Already throws; keep, but render it as a recoverable
  "start over" rather than a bare error.
- **Refresh token revoked by the user in Spotify's dashboard.** The refresh call
  returns `invalid_grant`. Delete the stored record and prompt reconnect. Do not
  retry: it will never succeed.
- **Two tabs refreshing at once.** Spotify may rotate the refresh token. The
  server must serialise per user, or the second refresh invalidates the first.
- **Rate limiting.** The refresh endpoint is callable by any client. It draws on
  a third-party API, so it belongs on the `fanoutLimiter` pattern in
  `internal/hub/hub.go:266-268`, not on an unlimited path.

## 6. Acceptance criteria

- No Spotify refresh token is reachable from `document`, `sessionStorage` or
  `localStorage` at any point in the flow.
- The client never holds the client secret.
- Code-for-token exchange happens server-side; the browser sends the code and
  receives only an access token.
- An expired access token mid-session refreshes transparently, and a **failed**
  refresh surfaces a reconnect affordance rather than failing silently.
- A revoked grant clears server state and prompts reconnect.
- Concurrent refreshes from two tabs do not invalidate each other.
- The refresh endpoint is rate-limited.
- e2e covers connect, expiry, refresh and revoke.

## 7. Sequencing

Not urgent relative to the rest of the backlog: prod CSP mitigates the immediate
exposure, and the ROI ranking put this at 27 against 125 for the viewport fix.

It should land before any marketing push that grows the user base, because the
blast radius scales with the number of connected Spotify accounts, and it should
land alongside #253 since the privacy policy has to describe this custody either
way.
