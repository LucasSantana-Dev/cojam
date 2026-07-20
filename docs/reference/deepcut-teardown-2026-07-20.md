# Teardown — deepcut.live (2026-07-20)

target: https://deepcut.live/ (deepcut.fm, a Turntable.fm revival by Testcode, Inc.)
evaluated-for: music-jam (cojam)
coverage: full for the logged-out surface (directory, room, signup modal, about). Logged-in DJ tools, avatar shop, and moderation were not walked (no account created).
summary: 8 findings — 0 adopt · 5 adapt · 1 already-have · 2 rejected

Context lock: cojam is per-user licensed streams synced by metadata (Stationhead/Vertigo
model, see CLAUDE.md), never rebroadcast audio. Deepcut is the opposite model: one shared
YouTube embed per room. Most findings below are shaped by that divergence.

## ADAPT list (ranked)

Nothing transfers as-is; every transferable idea needs adaptation to the per-user-stream
model. Ranked adapts:

1. F8 — room chat with system events — effort M-L · lands in `apps/server/internal/hub` (new RPCs + `Version` bump) + `apps/web/app/room`
2. F4 — queue voting (upvote-to-bump / vote-to-skip) — effort M · lands in `hub` mutating RPC + `QueuePanel.tsx`
3. F1 — "live now" public-room strip on the landing — effort M · lands in `apps/web/app/page.tsx` + hub read RPC (requires an opt-in `public` flag on rooms)
4. F7 — "people, not algorithms" positioning copy — effort S · lands in `apps/web/app/page.tsx`
5. F2 — guest-path audit (join with name only, gate only what costs us) — effort S-M · lands in join flow + `features.ts`

## Findings

### F1 — The product IS the landing page: live public room directory [UX/Growth]

- evidence: `.claude/design/refs/deepcut-01-landing.png`
- what: no marketing page at all. `/` is a sortable directory of live public rooms: album-art thumb, room name, current DJ + now-playing track, open DJ spots, listener count, "Listen now". Sorts: All rooms, DJs needed, What's Hot, # of Listeners, Recent, Random. A 💬 prefix marks rooms with active chat.
- why-it-works-for-them: network-effect product whose entire value prop is live rooms; showing 42 listeners in "Aunt Jackie" and real track names proves the place is alive better than any hero copy. Sort tabs map to visitor intents (join a crowd vs. find a room that needs a DJ).
- rationale: [their constraint: cold-start solved by surfacing live activity; rooms public by default] → [applies to us: yes for the activity signal — cojam's landing is pure marketing/showcase and a visitor sees zero proof of life; no for public-by-default, our rooms are link-based] → make rooms opt-in public and show a live strip on the landing.
- verdict: adapt
- effort: M
- lands-in: `apps/web/app/page.tsx`, hub read RPC for public room summaries (name, now-playing metadata, listener count), `RoomState.public` flag

### F2 — Zero-auth guest listening; signup is avatar + DJ name only [UX/Growth]

- evidence: `.claude/design/refs/deepcut-04-room-live.png` (listened as a guest), `.claude/design/refs/deepcut-05-signup-modal.png`
- what: guests enter rooms and listen immediately; the only gate is a bottom banner ("Sign up to customize your avatar, participate in the room chat, step up to DJ"). Signup itself is one modal: pick an avatar, pick a DJ name, done. No email wall up front.
- why-it-works-for-them: their media source (YouTube embeds) needs no user credentials, so a guest costs them nothing and top-of-funnel is frictionless.
- rationale: [their constraint: license-free media source] → [applies to us: partially — full playback in cojam needs the listener's own streaming account (Spotify or Apple OAuth), but presence, queue, chat, and previews cost nothing] → keep the guest path open as far as the licensed-stream model allows; gate only what actually costs us.
- verdict: adapt
- effort: S-M
- lands-in: join flow (`apps/web/app/room/[id]`), `features.ts`

### F3 — Stage + dance-floor avatar presence [Visual/UX]

- evidence: `.claude/design/refs/deepcut-04-room-live.png`
- what: a literal stage: DJ avatars behind decks, a crowd of listener avatars on a floor, floating point totals. Presence is spatial and playful, not a list.
- why-it-works-for-them: deliberate Turntable.fm nostalgia clone; the retro game-room metaphor IS the brand.
- rationale: [their constraint: retro revival aesthetic] → [applies to us: no — our repaint went premium/cockpit, and the underlying need (presence you can feel) is already served by `PresenceBar` + deterministic gradient avatars in `apps/web/lib/avatar.ts`] → keep our bar; borrow only liveliness cues (join/leave motion) if the room feels static.
- verdict: already-have
- lands-in: n/a (state-check: `PresenceBar.tsx`, `avatar.ts`)

### F4 — Vote-driven DJ points economy [Features/Growth]

- evidence: `.claude/design/refs/deepcut-04-room-live.png` (thumbs up/down flanking the songboard, "1,566,140 points" over a DJ)
- what: listeners vote on the current track; DJs accumulate points; points are status and unlock cosmetics. DJ seats are scarce (5), so voting allocates attention.
- why-it-works-for-them: DJ-slot scarcity needs a merit mechanism; points give DJs a reason to perform and listeners a reason to react.
- rationale: [their constraint: DJ-seat rotation with scarcity] → [applies to us: no for seats/points — cojam is host+queue with no scarcity to allocate; yes for the reaction loop — voting on queue items fits our model directly] → queue upvote-to-bump and vote-to-skip threshold; skip the points economy.
- verdict: adapt
- effort: M
- lands-in: hub mutating RPC (remember: bump `RoomState.Version`, assert in test per AGENTS.md), `apps/web/app/room/components/QueuePanel.tsx`, protocol in `packages/shared`

### F5 — YouTube as the media source, and its visible failure mode [Platform]

- evidence: `.claude/design/refs/deepcut-04-room-live.png` (left screen: "Video unavailable — UMG has blocked it from display on this website")
- what: the room plays one synced YouTube embed for everyone. Mid-room, label-blocked videos render a dead "Video unavailable" panel on the stage screens.
- why-it-works-for-them: zero licensing cost, zero user auth, full catalog — until a label pulls the embed.
- rationale: [their constraint: accept embed-blocks and ads in exchange for free media] → [applies to us: no — CLAUDE.md fixes per-user licensed streams, never rebroadcast; the dead screen is exactly the fragility that model avoids] → do not adopt YouTube as a primary source (note: `NEXT_PUBLIC_FEATURE_YOUTUBE` already exists and defaults true; audit what it powers before assuming). Secondary lesson: they show the raw provider error; we already designed a proper unavailable state (`.claude/design/refs/room2-repaint-unavailable.png`).
- verdict: reject
- lands-in: n/a

### F6 — Charity gate with cosmetic reward [Growth/Monetization]

- evidence: `.claude/design/refs/deepcut-02-charity-gate.png`
- what: first room entry shows "Just one thing": donate to World Central Kitchen or Direct Relief to unlock a special avatar. Fully skippable ("Continue to Room"), no guilt copy.
- why-it-works-for-them: no visible subscription revenue; a cosmetic economy plus goodwill monetizes without paywalling music.
- rationale: [their constraint: no paywall, cosmetics exist] → [applies to us: not yet — pre-revenue, no cosmetic economy, no monetization decision made] → park it.
- verdict: reject (revisit when monetization is on the table)
- lands-in: n/a

### F7 — Manifesto About page: "people, not algorithms" [Copy/Growth]

- evidence: `.claude/design/refs/deepcut-06-about.png`
- what: "We believe music is better with friends", "Listen to music selected by people, not algorithms", DJ-skills framing, press quotes (NYT, Wired, Mashable — inherited 2011-era Turntable.fm press; "10 years later — We're back").
- why-it-works-for-them: positions against the dominant solitary/algorithmic listening model in one line.
- rationale: [their constraint: revival brand leaning on nostalgia + old press] → [applies to us: the anti-algorithm angle fits cojam exactly — rooms curated by friends is our differentiator; the borrowed-press tactic does not] → take the positioning line, not the quotes.
- verdict: adapt
- effort: S
- lands-in: `apps/web/app/page.tsx` hero/subcopy

### F8 — Room chat with system events, mentions, sounds [Features]

- evidence: room snapshot this session (chat panel: "PEAK started playing 'Love The Way You Lie ft. Rihanna' by Eminem"; `chatsound mention` classes in DOM); 💬 badges in `.claude/design/refs/deepcut-01-landing.png`
- what: chat is a first-class room panel; system messages announce track changes; mentions and chat sounds exist; chat activity is advertised on directory cards.
- why-it-works-for-them: synchronous hangout is the product; chat is where "together" actually happens.
- rationale: [their constraint: synchronous social rooms] → [applies to us: yes — cojam has zero talk channel; state-check found no chat in `packages/shared` protocol or hub; it is the largest structural gap vs every social-listening competitor. Moderation burden is the honest cost; start minimal] → room chat MVP: text + system events, membership-gated like other mutating RPCs.
- verdict: adapt
- effort: M-L
- lands-in: `apps/server/internal/hub` (chat RPCs, membership-gated, `Version` bump), `packages/shared` protocol, new `ChatPanel` in `apps/web/app/room`

## Deliberate absences worth noting

- No algorithmic recommendations anywhere; discovery is the directory + sorts.
- No mobile-app push in the logged-out surface.
- No audio rebroadcast infrastructure at all: the "player" is a YouTube iframe, which is also why guests need nothing.

## State-check record

- Memory: no `reference_deepcut_evaluated_*` note existed (checked `~/.agents/memory/`, project `.agents/`).
- Repo: grep for `vote|chat|point|dj|avatar|listener` across `apps/` and `packages/shared` — avatars + presence exist (`avatar.ts`, `PresenceBar.tsx`); no voting, points, chat, or DJ-seat systems; no public room listing RPC. `NEXT_PUBLIC_FEATURE_YOUTUBE` flag exists (default true) and should be audited separately.
