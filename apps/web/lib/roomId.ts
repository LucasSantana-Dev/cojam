// Room IDs are the privacy boundary for private rooms (the link is the
// capability — see docs/protocol.md "Trust model"), so they must be
// crypto-random and long enough to be unguessable: 12 base36 chars ≈ 62 bits.
const ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const ROOM_ID_LENGTH = 12;

export function generateRoomId(): string {
  // Rejection sampling avoids modulo bias (256 % 36 !== 0); refill until full.
  const maxValid = Math.floor(256 / ALPHABET.length) * ALPHABET.length;
  let id = '';
  while (id.length < ROOM_ID_LENGTH) {
    const bytes = new Uint8Array(ROOM_ID_LENGTH * 2);
    crypto.getRandomValues(bytes);
    for (const b of bytes) {
      if (id.length === ROOM_ID_LENGTH) break;
      if (b < maxValid) id += ALPHABET[b % ALPHABET.length];
    }
  }
  return id;
}
