# Security policy

## Reporting a vulnerability

Report privately through GitHub's [private vulnerability
reporting](https://github.com/LucasSantana-Dev/cojam/security/advisories/new).
Please do not open a public issue for a security problem.

CoJam is maintained by one person in their own time, so treat these as
best-effort targets rather than guarantees:

| Stage | Target |
| --- | --- |
| Acknowledgement | 5 business days |
| Initial assessment | 10 business days |
| Fix or documented mitigation | depends on severity, communicated in the assessment |

Please include what you did, what happened, and what you expected. A minimal
reproduction helps more than anything else.

## Supported versions

Only the current `main` branch and the images published from it. There are no
maintained release branches.

## Scope

In scope:

- The Go server (`apps/server`), including connection auth, room authorization,
  and the RPC surface.
- The Next.js web app (`apps/web`), including the Spotify OAuth flow.
- The published container images.

Out of scope:

- Vulnerabilities in Spotify, Apple Music, YouTube, or Supabase themselves.
  Report those to the vendor.
- Findings that require an already-compromised host or browser.
- Missing hardening headers on the local development server. These are applied
  in production builds only, by design.

## Design notes relevant to security researchers

- **Room IDs are capabilities.** A private room is protected by the
  unguessability of its 12-character base36 ID (about 62 bits, crypto-random).
  Anything that leaks a room ID to a party who was not given the link is a real
  finding. See `docs/protocol.md`, "Trust model".
- **The server handles metadata only.** It never proxies or stores audio or
  video. Each client plays through its own provider SDK under its own account.
- **Guest identity is browser-local** and intentionally weak. Attribution
  rebinding on account upgrade is the interesting surface here.
