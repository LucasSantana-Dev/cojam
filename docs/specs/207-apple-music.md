# 207: Apple Music playback

Issue: [#207](https://github.com/LucasSantana-Dev/cojam/issues/207)
Status: spec, blocked on Apple Developer Program enrolment
Date: 2026-08-20

## 1. Why this is blocked, precisely

MusicKit JS needs a developer token signed with an ES256 private key issued by
Apple, which requires a paid Apple Developer Program membership (USD 99/year).
There is no free tier and no sandbox that avoids it.

That is the entire blocker. Everything else is already scaffolded:

- `internal/appletoken` exists and is at 80.5% test coverage
- `APPLE_TEAM_ID`, `APPLE_KEY_ID` and `APPLE_PRIVATE_KEY_PATH` are documented
- the `apple` feature flag exists in `lib/features.ts` and defaults off
- the dev-token endpoint is proxied (`next.config.ts` rewrites `/api/apple/*`)
- README already lists Apple as "Stubbed"

Note the tension with the zero-cost posture that deleted the Fly.io path in
`c3e63c7`: this is the first item in the backlog with a recurring cash cost. It
should be a deliberate decision, not a default.

## 2. Is it worth the money

Argument for: CoJam's premise is "friends on **different** streaming services".
With Apple stubbed, an iPhone-heavy friend group (which in Brazil skews by
social segment rather than being uniform) cannot use the product for its stated
purpose. Apple Music is the second-largest paid service in the market.

Argument against: USD 99/year on a product with no revenue and, as of the #199
verification, **no cross-service matching configured in production at all**
(`matcher_disabled`, `spotify_matcher_disabled`). Buying a third provider while
matching between the existing two is switched off is the wrong order.

**Recommendation: fix matching first (#199 section 2), confirm the cross-service
flow is actually used, then decide on Apple.** The Apple work is small once
unblocked; the evidence for whether it is worth paying for is not yet there.

## 3. Scope once unblocked

- Generate and store the ES256 key; wire `APPLE_PRIVATE_KEY_PATH` as a secret,
  not a repo file (`.gitignore` already excludes `*.p8`).
- Verify the dev-token endpoint against a real key; `internal/appletoken` is
  tested but has never run against Apple.
- MusicKit JS in the web player behind the existing `apple` flag.
- Apple as a match target, alongside the ISRC-first path.
- Apple requires a published privacy policy for API access, so #253 is a hard
  prerequisite.

## 4. Acceptance criteria

- A user with an Apple Music subscription can join a room and play the current
  track on their own account.
- ISRC matching resolves an Apple track from a Spotify or YouTube seed.
- Flag off leaves current behaviour untouched.
- Enrolment cost recorded as a deliberate decision, with a revisit date.
