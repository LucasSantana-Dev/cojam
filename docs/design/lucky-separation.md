# Lucky separation

Status: accepted. Date: 2026-10-08. Decider: Lucas Santana (owner). Local ADR number: 0009.

This lives in `docs/design/` and not `docs/adr/` because `docs/adr/` is gitignored (#256), the same as [`identity-decisions.md`](identity-decisions.md) and [`modo-palco.md`](modo-palco.md).

## Context

The owner asked (2026-10-08): "Você acha que faz sentido vincular esse produto ao Lucky?". Lucky is the owner's Discord music bot (`lucky.lucassantana.tech`). A four-lens debate ran on that question: product, legal, solo-dev cost and distribution. There were two rounds plus a synthesis. All four lenses ended on the same answer: no link. The owner then asked for this record and the checks below ("pode fazer o ADR e a checagem").

Facts behind the decision:

- **Lucky moves media bytes. CoJam does not.** Lucky extracts YouTube audio with yt-dlp and streams it into Discord voice channels. Google sent cease-and-desist letters to Groovy and Rythm for exactly that model, and both shut down (2021-08-30 and 2021-09-15). CoJam sends metadata only, and each listener plays on their own service ([`docs/platforms.md`](../platforms.md)). Local ADR-0007 already accepts CoJam's own YouTube sync risk "on precedent, not permission", so CoJam has no spare risk budget for Lucky's.
- **The audiences share a platform, not a job.** Lucky serves a Discord server already in a voice call that wants music with no setup. CoJam serves people who share a room link, each playing on their own account. Inside a call, CoJam does Lucky's job worse, because every Spotify listener needs Premium.
- **Lucky cannot carry CoJam's growth.** On 2026-10-07 Lucky had about 4 to 6 weekly active guilds (target 20, gate decision on 2026-12-20). A cross-link with that reach cannot produce a measurable result.

## Decision

CoJam and Lucky stay separate products. None of the following may be built:

1. **No merge.** No shared brand, no "CoJam by Lucky", no Lucky bot playing a CoJam room's queue into a voice channel. A merge would make CoJam the playlist source for a yt-dlp pipeline.
2. **No Lucky data in CoJam.** Lucky's listening history, recaps, votes or guild data never flow into CoJam: not into profiles, recommendations or the room directory. That data comes from a pipeline outside YouTube's terms, and using it in CoJam would add a new LGPD purpose.
3. **No CoJam promotion of Lucky.** CoJam's UI, copy and docs never recommend or link to Lucky.
4. **Separate identities on every platform:**
   - **Discord:** a separate application and team. If CoJam ever adds Discord login or a Discord Activity, it registers its own application ID and never reuses Lucky's.
   - **Google:** the Google Cloud project that holds CoJam's `YOUTUBE_API_KEY` must not belong to the Google account whose cookies Lucky's yt-dlp uses, so one ban cannot take out both. Checked 2026-10-08: the key is set in the `cojam-server` container and absent from `lucky-bot`. Which account owns CoJam's project is the owner's check (below).
   - **Web:** no redirects or deep links between `cojam.*` and `lucky.*` hosts. Sharing the owner's parent domain is accepted.
5. **A Discord Activity waits.** A CoJam Discord Activity (Embedded App SDK) may only be considered after:
   - the minor-safety work in [`docs/specs/259-eca-minor-safety.md`](../specs/259-eca-minor-safety.md) has shipped;
   - the Brazil video check below leaves a gap;
   - CoJam has measured demand (see "Next").

   If it ships, it is CoJam's own app and Lucky never launches it. Screen share ([`0008`, local] WebRTC) never ships inside an Activity.

Out of scope here, and the owner's call:

- whether Lucky gets a one-way `/cojam` command for Lucky's own retention, judged by Lucky's metrics;
- whether CoJam adopts Discord OAuth as its account system, on CoJam's own application.

## Check: Discord video in Brazil (2026-10-08)

**What the ANPD order covers.** The ANPD preventive measure of 2026-08-12 covers Go Live and "recursos de transmissão e compartilhamento de vídeo equivalentes". It rests on ECA Digital arts. 6 II and III, 10, 17, 28 and 29. Lifting it requires Discord to show adequate technical, security and governance measures, and the ANPD's "autorização expressa e prévia" ([gov.br/anpd](https://www.gov.br/anpd/pt-br/assuntos/noticias/em-medida-preventiva-anpd-determina-que-discord-suspenda-transmissoes-ao-vivo-no-brasil)).

**What Discord actually turned off.** From 2026-08-17 Discord went further than Go Live. In Brazil it suspended video calls, screen sharing and all real-time video communication in DMs, groups and servers. What still works: messages, servers, voice channels, audio-only calls, and "demais recursos que não dependem de vídeo ou compartilhamento de tela" ([O Tempo](https://www.otempo.com.br/brasil/2026/8/17/discord-comeca-a-suspender-chamadas-de-video-e-compartilhamento-de-tela), [WorkAdventure, 2026-08-19](https://workadventu.re/article/discord-screen-sharing-alternative/)).

**What stays open:**

- **Watch Together in Brazil.** No public source says whether Discord's Watch Together Activity (synced YouTube in a voice channel) still runs there. Checking takes one minute from a Brazilian account: join a voice channel, open the Activities (rocket) button, and see whether Watch Together is listed and plays.
- **Whether Activities fall under the order.** No public source covers this either. A synced YouTube Activity is a plausible "equivalent video sharing resource", and Discord has turned off more than the order required.

**What it means:**

- The gap for synchronized video in a group in Brazil is wider than the CoJam premise assumed: Discord video calls and screen share are off too, not just livestream.
- A CoJam Activity would sit inside the platform whose video features the ANPD has frozen, and would be exposed to the same order.
- Standalone web, where CoJam carries its own ECA Digital duties (#259), is the cleaner position.

## Next

1. **Owner checks (2 minutes):**
   - Watch Together in Brazil, as described above;
   - which Google account owns the Cloud project of CoJam's `YOUTUBE_API_KEY`. It must not be the account whose cookies Lucky uses.
2. **Measure:** add the `room_create`, `room_join` and `second_listener` events from [`docs/specs/245-251-client-telemetry.md`](../specs/245-251-client-telemetry.md), with a fixed `src` label (`direct|seed|discord|other`, never free text). Close the launch-readiness checklist.
3. **Seed:** for two weeks, post `?src=seed` room links in about 10 Brazilian Discord communities. Gate: at least 10 seeded rooms reach a second listener, and at least 3 rooms are used again in week two. Below that, a Discord Activity is off the table and the pitch needs work.

## Revisit when

- Lucky passes its 2026-12-20 gate with 20 or more weekly guilds. Then a one-way, tagged `/cojam` can be tested with real reach.
- Google or YouTube acts against Lucky-type bots or against a synchronized-viewing product (Watch2Gether, Kosmi). Then reopen local ADR-0007 and tighten this separation, for example by removing even portfolio cross-links.
- The ANPD lets Discord restore video in Brazil. Then re-read the CoJam premise ([`docs/specs/e1-video-cowatch.md`](../specs/e1-video-cowatch.md)), because Discord's own video is back.
- Lucky shuts down. CoJam may invite Lucky's community, but never takes its code, brand or bot.
