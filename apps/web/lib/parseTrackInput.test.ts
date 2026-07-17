import { describe, it, expect } from 'vitest';
import { parseYouTube, parseSpotify } from './parseTrackInput';

describe('parseYouTube', () => {
  const ID = 'jNQXAC9IVRw';
  it('extracts id from a watch URL', () => {
    expect(parseYouTube(`https://www.youtube.com/watch?v=${ID}`)).toBe(ID);
  });
  it('extracts id from a watch URL with extra params', () => {
    expect(parseYouTube(`https://youtube.com/watch?v=${ID}&t=42s&list=abc`)).toBe(ID);
  });
  it('extracts id from a youtu.be short link', () => {
    expect(parseYouTube(`https://youtu.be/${ID}?si=xyz`)).toBe(ID);
  });
  it('extracts id from a shorts URL', () => {
    expect(parseYouTube(`https://www.youtube.com/shorts/${ID}`)).toBe(ID);
  });
  it('extracts id from an embed URL', () => {
    expect(parseYouTube(`https://www.youtube.com/embed/${ID}`)).toBe(ID);
  });
  it('accepts a bare 11-char id', () => {
    expect(parseYouTube(ID)).toBe(ID);
  });
  it('trims surrounding whitespace', () => {
    expect(parseYouTube(`  ${ID}  `)).toBe(ID);
  });
  it('returns null for empty or junk input', () => {
    expect(parseYouTube('')).toBeNull();
    expect(parseYouTube('not a link')).toBeNull();
  });
});

describe('parseSpotify', () => {
  const ID = '6rqhFgbbKwnb9MLmUQDhG6';
  it('passes through a spotify:track URI', () => {
    expect(parseSpotify(`spotify:track:${ID}`)).toBe(`spotify:track:${ID}`);
  });
  it('converts an open.spotify.com track URL to a URI', () => {
    expect(parseSpotify(`https://open.spotify.com/track/${ID}?si=abc`)).toBe(`spotify:track:${ID}`);
  });
  it('accepts a bare 22-char base62 id', () => {
    expect(parseSpotify(ID)).toBe(`spotify:track:${ID}`);
  });
  it('returns null for junk or a non-track spotify url', () => {
    expect(parseSpotify('')).toBeNull();
    expect(parseSpotify('https://open.spotify.com/playlist/abc')).toBeNull();
  });
});
