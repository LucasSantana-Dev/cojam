import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock localStorage
const mockLocalStorage = () => {
  const store: Record<string, string> = {};
  return {
    getItem: (key: string) => store[key] || null,
    setItem: (key: string, value: string) => {
      store[key] = value;
    },
    removeItem: (key: string) => {
      delete store[key];
    },
    clear: () => {
      Object.keys(store).forEach((key) => delete store[key]);
    },
  };
};

describe('auth module', () => {
  beforeEach(() => {
    global.fetch = vi.fn();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('fetchConnectionToken', () => {
    it('fetches and returns token when feature is available', async () => {
      const mockLS = mockLocalStorage();
      (global as any).localStorage = mockLS;
      (global as any).window = (global as any).window || {};
      (global as any).window.localStorage = mockLS;
      
      const auth = await import('./auth');

      (global.fetch as any).mockResolvedValueOnce({
        ok: true,
        json: async () => ({ token: 'jwt-token-123', userId: 'anon-456' }),
      });

      const result = await auth.fetchConnectionToken('http://localhost:8080');

      expect(result).toEqual({ token: 'jwt-token-123', userId: 'anon-456' });
      expect(global.fetch).toHaveBeenCalledWith('http://localhost:8080/api/connection-token');
    });

    it('includes ?userId query param when userId is stored', async () => {
      const mockLS = mockLocalStorage();
      mockLS.setItem('cojam_uid', 'stored-user-789');
      (global as any).localStorage = mockLS;
      (global as any).window = (global as any).window || {};
      (global as any).window.localStorage = mockLS;
      
      const auth = await import('./auth');

      (global.fetch as any).mockResolvedValueOnce({
        ok: true,
        json: async () => ({ token: 'jwt-token-xyz', userId: 'stored-user-789' }),
      });

      const result = await auth.fetchConnectionToken('http://localhost:8080');

      expect(result).toEqual({ token: 'jwt-token-xyz', userId: 'stored-user-789' });
      expect(global.fetch).toHaveBeenCalledWith('http://localhost:8080/api/connection-token?userId=stored-user-789');
    });

    it('includes the previous token as ownership proof when stored', async () => {
      const mockLS = mockLocalStorage();
      mockLS.setItem('cojam_uid', 'stored-user-789');
      mockLS.setItem('cojam_token', 'previous-jwt');
      (global as any).localStorage = mockLS;
      (global as any).window = (global as any).window || {};
      (global as any).window.localStorage = mockLS;

      const auth = await import('./auth');

      (global.fetch as any).mockResolvedValueOnce({
        ok: true,
        json: async () => ({ token: 'new-jwt', userId: 'stored-user-789' }),
      });

      const result = await auth.fetchConnectionToken('http://localhost:8080');

      expect(result).toEqual({ token: 'new-jwt', userId: 'stored-user-789' });
      expect(global.fetch).toHaveBeenCalledWith(
        'http://localhost:8080/api/connection-token?userId=stored-user-789&token=previous-jwt'
      );
      // Returned identity replaces the stored one for the next refresh.
      expect(mockLS.getItem('cojam_token')).toBe('new-jwt');
    });

    it('returns null on 501 response (feature off)', async () => {
      const mockLS = mockLocalStorage();
      (global as any).localStorage = mockLS;
      (global as any).window = (global as any).window || {};
      (global as any).window.localStorage = mockLS;
      
      const auth = await import('./auth');

      (global.fetch as any).mockResolvedValueOnce({
        ok: false,
        status: 501,
      });

      const result = await auth.fetchConnectionToken('http://localhost:8080');

      expect(result).toBeNull();
    });

    it('returns null on 404 response', async () => {
      const mockLS = mockLocalStorage();
      (global as any).localStorage = mockLS;
      (global as any).window = (global as any).window || {};
      (global as any).window.localStorage = mockLS;
      
      const auth = await import('./auth');

      (global.fetch as any).mockResolvedValueOnce({
        ok: false,
        status: 404,
      });

      const result = await auth.fetchConnectionToken('http://localhost:8080');

      expect(result).toBeNull();
    });

    it('returns null on network error', async () => {
      const mockLS = mockLocalStorage();
      (global as any).localStorage = mockLS;
      (global as any).window = (global as any).window || {};
      (global as any).window.localStorage = mockLS;
      
      const auth = await import('./auth');

      (global.fetch as any).mockRejectedValueOnce(new Error('Network error'));

      const result = await auth.fetchConnectionToken('http://localhost:8080');

      expect(result).toBeNull();
    });

    it('does not throw or persist when network error occurs', async () => {
      const mockLS = mockLocalStorage();
      (global as any).localStorage = mockLS;
      (global as any).window = (global as any).window || {};
      (global as any).window.localStorage = mockLS;
      
      const auth = await import('./auth');

      (global.fetch as any).mockRejectedValueOnce(new Error('Network timeout'));

      const result = await auth.fetchConnectionToken('http://localhost:8080');

      expect(result).toBeNull();
    });

    it('does not throw when window is undefined (SSR)', async () => {
      const mockLS = mockLocalStorage();
      (global as any).localStorage = mockLS;
      const originalWindow = (global as any).window;
      // Simulate SSR by removing window from the global scope.
      delete (global as any).window;
      
      const auth = await import('./auth');

      (global.fetch as any).mockResolvedValueOnce({
        ok: true,
        json: async () => ({ token: 'jwt-token', userId: 'user' }),
      });

      const result = await auth.fetchConnectionToken('http://localhost:8080');

      expect(result).not.toBeNull();
      (global as any).window = originalWindow;
    });

    it('derives HTTP base URL when not provided with window.location', async () => {
      const mockLS = mockLocalStorage();
      (global as any).localStorage = mockLS;
      (global as any).window = (global as any).window || {};
      (global as any).window.localStorage = mockLS;
      (global as any).window.location = { origin: 'http://app.local:3000' };

      const auth = await import('./auth');

      (global.fetch as any).mockResolvedValueOnce({
        ok: true,
        json: async () => ({ token: 'jwt-auto', userId: 'auto-user' }),
      });

      const result = await auth.fetchConnectionToken();

      expect(result).not.toBeNull();
      expect(global.fetch).toHaveBeenCalledWith('http://app.local:3000/api/connection-token');
    });
  });
});
