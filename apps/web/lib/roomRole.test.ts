import { describe, it, expect } from 'vitest';
import { canControl, isHost } from './roomRole';

describe('roomRole', () => {
  describe('canControl', () => {
    it('returns true when roomAuth is off, regardless of host', () => {
      expect(canControl({ roomAuth: false, myUserId: 'user1', hostUserId: 'user2' })).toBe(true);
      expect(canControl({ roomAuth: false, myUserId: null, hostUserId: 'user2' })).toBe(true);
      expect(canControl({ roomAuth: false, myUserId: 'user1' })).toBe(true);
    });

    it('returns true when roomAuth is on but hostUserId is empty (no host assigned yet)', () => {
      expect(canControl({ roomAuth: true, myUserId: 'user1', hostUserId: undefined })).toBe(true);
      expect(canControl({ roomAuth: true, myUserId: 'user1', hostUserId: '' })).toBe(true);
      expect(canControl({ roomAuth: true, myUserId: null, hostUserId: undefined })).toBe(true);
    });

    it('returns true when roomAuth is on and I am the host', () => {
      expect(canControl({ roomAuth: true, myUserId: 'user1', hostUserId: 'user1' })).toBe(true);
    });

    it('returns false when roomAuth is on, a host is assigned, and I am not the host', () => {
      expect(canControl({ roomAuth: true, myUserId: 'user1', hostUserId: 'user2' })).toBe(false);
    });

    it('returns false when roomAuth is on, a host is assigned, and myUserId is null', () => {
      expect(canControl({ roomAuth: true, myUserId: null, hostUserId: 'user2' })).toBe(false);
    });
  });

  describe('isHost', () => {
    it('returns true when myUserId matches hostUserId', () => {
      expect(isHost('user1', 'user1')).toBe(true);
    });

    it('returns false when myUserId does not match hostUserId', () => {
      expect(isHost('user1', 'user2')).toBe(false);
    });

    it('returns false when myUserId is null', () => {
      expect(isHost(null, 'user2')).toBe(false);
    });

    it('returns false when hostUserId is undefined or empty', () => {
      expect(isHost('user1', undefined)).toBe(false);
      expect(isHost('user1', '')).toBe(false);
    });
  });
});
