// Authorization helpers for room control gating (RFC-0005 U5).
// Pure + testable: compute whether a user can control host-only room actions.

export interface CanControlOpts {
  roomAuth: boolean;
  myUserId: string | null;
  hostUserId?: string;
}

// Derive whether the current user can control host-only room actions.
// - roomAuth off: everyone controls (v0 behavior)
// - roomAuth on, no host assigned: everyone controls (don't lock room until host set)
// - roomAuth on, I am the host: I control
// - roomAuth on, a host is assigned and it's not me: I cannot control (listener)
export function canControl(opts: CanControlOpts): boolean {
  const { roomAuth, myUserId, hostUserId } = opts;

  // Feature off: everyone can control
  if (!roomAuth) return true;

  // No host assigned yet: room is unlocked
  if (!hostUserId) return true;

  // Host is assigned: only the host can control
  if (myUserId && myUserId === hostUserId) return true;

  // A host exists and it's not me
  return false;
}

// Helper: am I the host?
export function isHost(myUserId: string | null, hostUserId?: string): boolean {
  if (!myUserId || !hostUserId) return false;
  return myUserId === hostUserId;
}
