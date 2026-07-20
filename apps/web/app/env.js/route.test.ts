import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { GET } from './route';

const KEYS = ['COJAM_SUPABASE_URL', 'COJAM_SUPABASE_ANON_KEY'] as const;

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
