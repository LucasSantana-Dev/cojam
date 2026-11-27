import { describe, it, expect, beforeEach } from 'vitest';
import { logPlayback, readPlaybackLog, formatPlaybackLog, installPlaybackLog, ytStateName, resetPlaybackLogForTests, PLAYBACK_LOG_MAX } from './playbackLog';

describe('playbackLog', () => {
  beforeEach(() => resetPlaybackLogForTests());

  it('records events with the page state and drops undefined fields', () => {
    logPlayback('yt_state', { state: 'paused', room: 'playing', extra: undefined });
    const [e] = readPlaybackLog();
    expect(e.ev).toBe('yt_state');
    expect(e.state).toBe('paused');
    expect(e.room).toBe('playing');
    expect('extra' in e).toBe(false);
    expect(typeof e.hidden).toBe('boolean');
  });

  it('keeps only the newest entries and persists them', () => {
    for (let i = 0; i < PLAYBACK_LOG_MAX + 5; i++) logPlayback('tick', { i });
    const all = readPlaybackLog();
    expect(all).toHaveLength(PLAYBACK_LOG_MAX);
    expect(all[0].i).toBe(5);
    expect(JSON.parse(localStorage.getItem('cojam.playbackLog') ?? '[]')).toHaveLength(PLAYBACK_LOG_MAX);
  });

  it('formats one line per entry and exposes the console reader once installed', () => {
    installPlaybackLog();
    document.dispatchEvent(new Event('visibilitychange'));
    const text = (window as unknown as { cojamPlaybackLog: () => string }).cojamPlaybackLog();
    expect(text.split('\n')[0]).toMatch(/^cojam playback log \(2\)/);
    expect(text).toContain(' page_open ');
    expect(text).toMatch(/ visibility .*state=visible/);
    expect(formatPlaybackLog([])).toMatch(/^cojam playback log \(0\)/);
  });

  it('names YouTube states', () => {
    expect([-1, 0, 1, 2, 3, 5, 9].map(ytStateName)).toEqual(['unstarted', 'ended', 'playing', 'paused', 'buffering', 'cued', '9']);
  });
});
