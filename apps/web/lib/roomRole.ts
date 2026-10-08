// Authorization helpers for room control gating (RFC-0005 U5).
// Pure + testable: compute whether a user can control host-only room actions.

export interface CanControlOpts {
  roomAuth: boolean;
  myUserId: string | null;
  hostUserId?: string;
  // Room creator: always controls, cannot be demoted.
  ownerUserId?: string;
  // Admins named by the host or owner: full queue and transport control.
  admins?: readonly string[];
}

// Derive whether the current user can control host-only room actions.
// - roomAuth off: everyone controls (v0 behavior)
// - roomAuth on, no host assigned: everyone controls (don't lock room until host set)
// - roomAuth on, I am the host, the owner or an admin: I control
// - roomAuth on, a host is assigned and I hold none of those roles: I cannot control (listener)
export function canControl(opts: CanControlOpts): boolean {
  const { roomAuth, myUserId, hostUserId, ownerUserId, admins } = opts;

  // Feature off: everyone can control
  if (!roomAuth) return true;

  // No host assigned yet: room is unlocked
  if (!hostUserId) return true;

  // Host, owner or admin controls (mirror of the server's CanControl)
  if (myUserId && (myUserId === hostUserId || myUserId === ownerUserId || admins?.includes(myUserId))) return true;

  // A host exists and it's not me
  return false;
}

// Helper: am I the host?
export function isHost(myUserId: string | null, hostUserId?: string): boolean {
  if (!myUserId || !hostUserId) return false;
  return myUserId === hostUserId;
}

// Helper: may I manage roles and moderate (host or owner)? Admins may not.
export function isHostOrOwner(myUserId: string | null, hostUserId?: string, ownerUserId?: string): boolean {
  if (!myUserId) return false;
  return myUserId === hostUserId || myUserId === ownerUserId;
}
