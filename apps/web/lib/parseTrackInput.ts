// Turn a pasted YouTube/Spotify link (or a bare id/uri) into the canonical
// identifier the queue stores. Lets users paste a normal share link instead of
// hunting for a raw video id or track uri. Pure + no network.

const YT_ID = /^[A-Za-z0-9_-]{11}$/;
// watch?v=, youtu.be/, shorts/, embed/ — capture the 11-char id after any of them.
const YT_URL = /(?:v=|youtu\.be\/|\/shorts\/|\/embed\/)([A-Za-z0-9_-]{11})/;

export function parseYouTube(input: string): string | null {
  const s = input.trim();
  if (!s) return null;
  if (YT_ID.test(s)) return s;
  const m = s.match(YT_URL);
  return m ? m[1] : null;
}

const SPOTIFY_ID = /^[A-Za-z0-9]{22}$/;
const SPOTIFY_URI = /^spotify:track:([A-Za-z0-9]{22})$/;
const SPOTIFY_URL = /open\.spotify\.com\/track\/([A-Za-z0-9]{22})/;

export function parseSpotify(input: string): string | null {
  const s = input.trim();
  if (!s) return null;
  const uri = s.match(SPOTIFY_URI);
  if (uri) return `spotify:track:${uri[1]}`;
  const url = s.match(SPOTIFY_URL);
  if (url) return `spotify:track:${url[1]}`;
  if (SPOTIFY_ID.test(s)) return `spotify:track:${s}`;
  return null;
}
