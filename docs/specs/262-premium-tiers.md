# 262: Premium capacity tiers

Issue: [#262](https://github.com/LucasSantana-Dev/cojam/issues/262)
Status: spec, deferred — no usage data to price against
Date: 2026-08-20

## 1. The one number that matters

plug.dj shut down in February 2021 with **60,000 daily users and 2,900 paying**.
Turntable.fm folded with music licensing running roughly 2:1 against revenue
after raising USD 7M. Neither died of insufficient users.

**CoJam does not have their cost structure.** Metadata-only fan-out means
marginal cost per user is close to zero, so a small subscriber base can work
here where it could not for them. That property is worth more than any feature
in this backlog, and it is the thing to protect when weighing #261 (voice), which
is the first proposal that would change it.

## 2. Why this is deferred, specifically

Pricing without usage data is guessing, and there is currently **no usage data at
all**: #251 is unimplemented, so activation, retention and concurrency are
unmeasured. There is no way to know whether anyone reaches the second-listener
moment, which is the only event that makes a paid tier plausible.

Sequence is therefore: telemetry (#245/#251) → observe → price. Not the reverse.

## 3. Likely shape, when the time comes

Capacity is the natural lever: it is the one thing that scales with server cost,
and it is what Spotify Jam gates on (32 participants, raised from 5).

- Free: room capacity around 8, all core features
- Premium: larger rooms, persistent room identity, a custom room URL, priority
  queue slots

**Do not gate core listening.** The product's value is friends together; gating
that destroys the network effect that would make anyone pay. Comparable pricing:
Watch2Gether PLUS at USD 2.90/mo, Teleparty around USD 6.59/mo. Typical consumer
free-to-paid conversion is 2-5%.

## 4. The Brazil-specific cost nobody budgets for

Pricing must be in BRL and payment must include **Pix**. A USD card checkout will
not convert in this market.

That is not a config toggle. It means a payment provider with Pix support, a
CNPJ, and Brazilian consumer tax handling. Scope it before committing to any
launch date; it is plausibly larger than the feature work it funds.

## 5. Prerequisites

1. Live product with real retention data (#245/#251)
2. Terms of service and privacy policy (#253), which any payment processor will
   require
3. A CNPJ and tax handling
4. A reason to believe someone would pay, from observed behaviour rather than
   from comparable products

## 6. Recommendation

Correctly last in the backlog. Recorded so the reasoning is on file and the
metadata-only cost advantage is not accidentally traded away by a future
architecture decision that predates the revenue conversation.
