// Age affirmation for the public-directory path only, not for invite-link
// joins. Rationale: docs/specs/259-eca-minor-safety.md.

// PROVISIONAL: the number is a legal question, pending the review in #253.
export const MINIMUM_AGE = 16;

const STORAGE_KEY = 'cojam_age_affirmed';

// Per browser, like guest identity itself.
export function hasAffirmedAge(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) === String(MINIMUM_AGE);
  } catch {
    return false; // blocked storage: ask again rather than assume yes
  }
}

// Stores the minimum in force, so raising MINIMUM_AGE later re-asks.
export function affirmAge(): void {
  try {
    localStorage.setItem(STORAGE_KEY, String(MINIMUM_AGE));
  } catch {
    // Gate reappears next time, which is the safe direction to fail.
  }
}
