/**
 * Common player interface for adapting Spotify, Apple Music, and YouTube SDKs.
 * All methods return Promises for consistency; positions and durations are in milliseconds.
 */
export interface IPlayer {
  /**
   * Start playback.
   */
  play(): Promise<void>;

  /**
   * Pause playback.
   */
  pause(): Promise<void>;

  /**
   * Seek to a position in milliseconds.
   * Throws or silently fails on providers that forbid seek (e.g. Spotify free tier).
   */
  seekToMs(positionMs: number): Promise<void>;

  /**
   * Get current playback position in milliseconds.
   */
  getCurrentPositionMs(): Promise<number>;

  /**
   * Get track duration in milliseconds.
   */
  getDurationMs(): Promise<number>;

  /**
   * Return true if seeking is allowed on this provider for this account.
   * Spotify free tier forbids seek; Premium allows it. YouTube and Apple always allow seek.
   */
  canSeek(): boolean;

  /**
   * Register a callback fired when the current track ends.
   */
  onEnded(cb: () => void): void;

  /**
   * Register a callback fired when playback position changes.
   * Implementations may debounce or throttle these callbacks for efficiency.
   */
  onPositionChanged(cb: (positionMs: number) => void): void;
}
