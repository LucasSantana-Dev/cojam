# CoJam

Friends on different streaming services listening together in one room. The
server coordinates metadata only; each person's audio comes from their own
account, through their own platform SDK.

## Language

### The room

**Room**:
A shared listening space with one queue and one now-playing track. Identified
by a room ID that is itself the access grant.
_Avoid_: session, channel, party

**Link capability**:
The rule that holding a room's link *is* permission to enter it. There is no
separate join-approval step, by decision. A private room's privacy rests on its
ID being unguessable, not on a server-side check.
_Avoid_: invite, access token (both imply something the server validates
separately)

**Public directory**:
The listing a host can opt a room into, making it discoverable by strangers.
Opting in trades obscurity for reach; it is per-room and off by default.
_Avoid_: lobby, browse, explore

### Who is in it

**Member**:
Anyone currently in a room. Membership is what grants the right to mutate the
room, and it follows from subscribing to the room.
_Avoid_: user, participant, attendee

**Host**:
The one member who holds moderation rights over a room. The first authenticated
joiner; reclaimed by another member if the host leaves.
_Avoid_: owner, admin, creator (the creator may not still be the host)

**Listener**:
A member who is not the host. Use only when the contrast with **Host** is the
point; otherwise say **Member**.
_Avoid_: using "listener" as a synonym for member

**Guest**:
A member with no account, whose identity lives only in their own browser. A
guest can do everything a member can, including vote and chat.
_Avoid_: anonymous, visitor

**Account**:
A durable identity that survives browsers and devices. A guest may upgrade to
an account, and their earlier attribution is rebound to it.
_Avoid_: profile, login, user

### What flows through it

**Queue**:
The ordered list of tracks a room will play. Shared and mutable by any member.
_Avoid_: playlist (a playlist is something a user imports *from* a platform)

**Track**:
One song as metadata: title, artist, ISRC, and per-platform source references.
Never audio.
_Avoid_: song, media, item

**Matching**:
Resolving one track to its equivalent on another platform, so members on
different services hear the same song. ISRC first, then fallbacks.
_Avoid_: linking, mapping, resolution

**Chat message**:
A line of room conversation. Ephemeral by definition: it lives in memory, is
never persisted, and dies with the room.
_Avoid_: comment, post

**Report**:
A member's durable record that something in a room needs attention. A report
copies the content it concerns, because the chat message it refers to may be
gone by the time anyone reads it.
_Avoid_: flag, complaint, ticket

## Flagged ambiguities

**"Member" vs "listener"** — `docs/protocol.md` uses both. Resolved above:
every person in a room is a **Member**; **Listener** means specifically a
non-host member and should only appear where that contrast matters.

**"Account" vs "guest identity"** — both are identities, but only an **Account**
survives a browser change. A guest identity is deliberately weak, and saying
"user" for either loses the distinction that guest-to-account rebinding exists
to bridge.

**"Room name" vs "member name"** — `room.join` takes a `name` that is a
person's display name, while a host can also set a `name` on the room shown in
the public directory. Say **display name** and **room label** to keep them
apart.

## Example dialogue

> **Dev:** If a guest reports a chat message, and the room gets evicted before
> I look at it, what am I holding?
>
> **Domain:** The report. Not the message — that died with the room, like every
> chat message does. The report copied what it needed when it was filed.
>
> **Dev:** So the report is the durable thing, not the chat.
>
> **Domain:** Right. Chat being ephemeral is deliberate: we do not retain
> conversation. Filing a report is a member telling us this particular line is
> the exception.
>
> **Dev:** And who can act on it? The host?
>
> **Domain:** The host can remove the message and eject the member. But the
> host might be the problem, which is exactly why reports do not go to them.
>
> **Dev:** What if the room was private and never in the directory?
>
> **Domain:** Still reportable. Being private only means it was not discoverable
> — anyone holding the link is a member with full rights, and that is the whole
> trust model.
