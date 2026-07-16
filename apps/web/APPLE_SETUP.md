# Apple MusicKit setup (operator steps)

The server issues MusicKit developer tokens from `GET /api/apple/dev-token`
(proxied at `/api/apple/dev-token` on the web app). It needs three env vars.

## 1. Create the key (Apple Developer portal — requires membership, $99/yr)

1. https://developer.apple.com/account → Certificates, Identifiers & Profiles → **Keys** → **+**
2. Name it (e.g. `music-jam`), check **Media Services (MusicKit)**, Continue → Register.
3. **Download the .p8** (one-time download — Apple never re-serves it) and note the **Key ID** (10 chars).
4. Your **Team ID** is under Membership Details (10 chars).

## 2. Install the key locally (never in the repo)

```sh
mkdir -p ~/.config/music-jam
mv ~/Downloads/AuthKey_<KEYID>.p8 ~/.config/music-jam/
chmod 600 ~/.config/music-jam/AuthKey_<KEYID>.p8
```

`*.p8` is gitignored as a second line of defense.

## 3. Export env vars (Keychain pattern per shell-secret-management standard)

Team/Key IDs are identifiers, not secrets — plain exports are fine; the .p8 file is the secret:

```sh
export APPLE_TEAM_ID=<team id>
export APPLE_KEY_ID=<key id>
export APPLE_PRIVATE_KEY_P8="$HOME/.config/music-jam/AuthKey_<KEYID>.p8"
```

## 4. Verify

```sh
cd apps/server && go run ./cmd/server   # restart with the env vars set
curl -s localhost:8080/api/apple/dev-token | head -c 60   # JWT, not the 501 stub
```

Then in a room: **Connect Apple Music** button appears → authorize with an
Apple Music subscriber account → add a track with an Apple Music Song ID
(from a catalog URL, e.g. https://music.apple.com/us/album/x/123?i=SONGID)
→ it plays via MusicKit for authorized users; others get the YouTube fallback.
