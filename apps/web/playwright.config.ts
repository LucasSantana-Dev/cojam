import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  use: {
    baseURL: 'http://localhost:3000',
  },
  webServer: [
    {
      command: 'go run ./cmd/server',
      cwd: '../server',
      url: 'http://localhost:8080/healthz',
      // false for the same reason as the web server below: a reused flagless
      // server would silently mask FEATURE_ROOM_AUTH (auth.spec.ts needs it).
      reuseExistingServer: false,
      timeout: 60_000,
      env: {
        // Room auth on so host/listener gating is exercised end to end; the
        // secret only signs throwaway e2e tokens.
        FEATURE_ROOM_AUTH: 'true',
        ROOM_AUTH_SECRET: 'e2e-room-auth-secret',
      },
    },
    {
      // Flags on so the gated Spotify/Apple UI renders in e2e. The SDKs are never
      // called (tests don't click Connect), so the dummy client id is safe.
      // reuseExistingServer:false guarantees this env applies (a stale flagless
      // `pnpm dev` on :3000 would otherwise be reused and mask the flag) — keep
      // port 3000 free when running e2e.
      command: 'pnpm dev',
      url: 'http://localhost:3000',
      reuseExistingServer: false,
      timeout: 120_000,
      env: {
        NEXT_PUBLIC_FEATURE_SPOTIFY: 'on',
        NEXT_PUBLIC_FEATURE_APPLE: 'off',
        NEXT_PUBLIC_SPOTIFY_CLIENT_ID: 'e2e-test-client-id',
        // Room auth must match the Go server above: the client fetches a
        // connection token from the Go origin before opening the websocket
        // (see e2e/connectionTokenProxy.ts for the CORS bridge).
        NEXT_PUBLIC_FEATURE_ROOM_AUTH: 'on',
        NEXT_PUBLIC_WS_URL: 'ws://localhost:8080/connection/websocket',
      },
    },
  ],
});
