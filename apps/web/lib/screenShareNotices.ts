// Notices around a screen share (#310, spec 5.7): who joined or left, why a
// share ended, and the short audio tip after the first share. Pure, so the
// wording has its own tests.

export type NameOf = (clientId: string) => string;

// One line for the broadcaster when the viewer list changes. Several
// changes at once read as one count, so a burst does not flash names.
export function viewerChangeNotice(prev: readonly string[], next: readonly string[], nameOf: NameOf): string {
  const joined = next.filter((id) => !prev.includes(id));
  const left = prev.filter((id) => !next.includes(id));
  if (joined.length + left.length === 0) return '';
  if (joined.length + left.length > 1) {
    const parts: string[] = [];
    if (joined.length) parts.push(`${joined.length} ${joined.length === 1 ? 'entrou' : 'entraram'}`);
    if (left.length) parts.push(`${left.length} ${left.length === 1 ? 'saiu' : 'saíram'}`);
    return `Na sua transmissão: ${parts.join(' e ')}.`;
  }
  return joined.length ? `${nameOf(joined[0])} começou a assistir.` : `${nameOf(left[0])} parou de assistir.`;
}

// The viewer's line when a share ends. Leaving the room ends a share on the
// server too; saying so tells the viewer nobody stopped it on purpose.
export function endedNotice(broadcasterName: string, broadcasterInRoom: boolean): string {
  return broadcasterInRoom ? 'A transmissão terminou.' : `${broadcasterName} saiu da sala e a transmissão terminou.`;
}

const SHARED_KEY = 'cojam.screenShared';

export function markShared(): void {
  try {
    localStorage.setItem(SHARED_KEY, '1');
  } catch {
    /* storage unavailable: the long tip keeps showing */
  }
}

// After one share the audio tip folds to one line.
export function hasSharedBefore(): boolean {
  try {
    return localStorage.getItem(SHARED_KEY) === '1';
  } catch {
    return false;
  }
}
