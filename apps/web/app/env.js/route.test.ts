import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { FEATURE_ENV_VARS } from '@/lib/features';
import { GET } from './route';

const FEATURE_KEYS = Object.values(FEATURE_ENV_VARS);
const KEYS = ['COJAM_SUPABASE_URL', 'COJAM_SUPABASE_ANON_KEY', ...FEATURE_KEYS];

function parseBody(res: Response): Promise<Record<string, unknown>> {
  return res.text().then((body) => {
    const json = body.replace(/^window\.__COJAM_ENV__ = /, '').replace(/;$/, '');
    return JSON.parse(json);
  });
}

describe('env.js route supabase overrides', () => {
  let saved: Record<string, string | undefined>;

  beforeEach(() => {
    saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
  });

  afterEach(() => {
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it('emits both supabase values when both are set', async () => {
    process.env.COJAM_SUPABASE_URL = 'https://runtime.supabase.co';
    process.env.COJAM_SUPABASE_ANON_KEY = 'runtime-key';
    const env = await parseBody(GET());
    expect(env.supabaseUrl).toBe('https://runtime.supabase.co');
    expect(env.supabaseAnonKey).toBe('runtime-key');
  });

  it('emits neither when only the URL is set', async () => {
    process.env.COJAM_SUPABASE_URL = 'https://runtime.supabase.co';
    delete process.env.COJAM_SUPABASE_ANON_KEY;
    const env = await parseBody(GET());
    expect(env.supabaseUrl).toBeUndefined();
    expect(env.supabaseAnonKey).toBeUndefined();
  });

  it('emits neither when only the anon key is set', async () => {
    delete process.env.COJAM_SUPABASE_URL;
    process.env.COJAM_SUPABASE_ANON_KEY = 'runtime-key';
    const env = await parseBody(GET());
    expect(env.supabaseUrl).toBeUndefined();
    expect(env.supabaseAnonKey).toBeUndefined();
  });

  it('emits neither when both are unset', async () => {
    delete process.env.COJAM_SUPABASE_URL;
    delete process.env.COJAM_SUPABASE_ANON_KEY;
    const env = await parseBody(GET());
    expect(env.supabaseUrl).toBeUndefined();
    expect(env.supabaseAnonKey).toBeUndefined();
  });
});

describe('env.js route features map', () => {
  let saved: Record<string, string | undefined>;

  beforeEach(() => {
    saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
    for (const k of FEATURE_KEYS) delete process.env[k];
  });

  afterEach(() => {
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it('emits a flag inside features when its COJAM_FEATURE_* var is set', async () => {
    process.env.COJAM_FEATURE_ROOM_AUTH = 'true';
    const env = await parseBody(GET());
    expect(env.features).toEqual({ roomAuth: true });
  });

  it('emits false when a flag is explicitly off', async () => {
    process.env.COJAM_FEATURE_ROOM_AUTH = 'false';
    const env = await parseBody(GET());
    expect(env.features).toEqual({ roomAuth: false });
  });

  it('emits only the flags that are set', async () => {
    process.env.COJAM_FEATURE_SPOTIFY = 'true';
    process.env.COJAM_FEATURE_SYNC = 'false';
    const env = await parseBody(GET());
    expect(env.features).toEqual({ spotify: true, sync: false });
  });

  it('omits the features map when no COJAM_FEATURE_* var is set, so build-time flags apply', async () => {
    const env = await parseBody(GET());
    expect(env.features).toBeUndefined();
  });
});

describe('env.js route roomChat flag (F8)', () => {
  let saved: Record<string, string | undefined>;

  beforeEach(() => {
    saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
    for (const k of FEATURE_KEYS) delete process.env[k];
  });

  afterEach(() => {
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it('emits roomChat inside features when COJAM_FEATURE_ROOM_CHAT=true', async () => {
    process.env.COJAM_FEATURE_ROOM_CHAT = 'true';
    const env = await parseBody(GET());
    expect(env.features).toEqual({ roomChat: true });
  });

  it('emits roomChat false when explicitly off', async () => {
    process.env.COJAM_FEATURE_ROOM_CHAT = 'false';
    const env = await parseBody(GET());
    expect(env.features).toEqual({ roomChat: false });
  });

  it('omits roomChat when unset so the build-time flag applies', async () => {
    const env = await parseBody(GET());
    expect(env.features).toBeUndefined();
  });
});
