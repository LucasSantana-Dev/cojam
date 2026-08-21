import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { MINIMUM_AGE, hasAffirmedAge, affirmAge } from './ageGate';

describe('ageGate (#259)', () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => vi.unstubAllGlobals());

  it('starts unaffirmed', () => {
    expect(hasAffirmedAge()).toBe(false);
  });

  it('remembers an affirmation', () => {
    affirmAge();
    expect(hasAffirmedAge()).toBe(true);
  });

  // Records the minimum in force, so raising it later re-asks instead of
  // honouring consent given to a lower bar.
  it('does not honour an affirmation made against a lower minimum', () => {
    localStorage.setItem('cojam_age_affirmed', String(MINIMUM_AGE - 1));
    expect(hasAffirmedAge()).toBe(false);
  });

  it('ignores a malformed value', () => {
    localStorage.setItem('cojam_age_affirmed', 'true');
    expect(hasAffirmedAge()).toBe(false);
  });

  // Private mode throws on access. Asking again is the safe direction.
  it('asks again when storage is unavailable', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => { throw new Error('blocked'); },
      setItem: () => { throw new Error('blocked'); },
    });
    expect(hasAffirmedAge()).toBe(false);
    expect(() => affirmAge()).not.toThrow();
  });
});
