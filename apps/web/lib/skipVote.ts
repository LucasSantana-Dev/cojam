// Vote to skip (now_playing.vote_skip). The threshold mirrors the server's
// queue.SkipVotesNeeded; the server is authoritative, this only labels the
// button ("Pular 1/2") from the listener count the room page already shows.

// How many skip votes pass the track for n distinct listeners: half rounded up,
// never fewer than 2 once two or more people are present, 1 when alone.
export function skipVotesNeeded(listeners: number): number {
  const n = Math.max(1, Math.floor(listeners));
  const half = Math.ceil(n / 2);
  return n >= 2 ? Math.max(2, half) : 1;
}

// The pressed state lives in the store's myVotes map (persisted per room for
// the session). Track ids are UUIDs, so a "skip:" prefix cannot collide with
// the queue-vote entries, and a new track id starts unpressed on its own.
export function skipVoteKey(trackId: string): string {
  return `skip:${trackId}`;
}
