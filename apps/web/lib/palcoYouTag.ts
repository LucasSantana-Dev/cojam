// The lime tag over the picked sprite on the join floor: "Você" plus the nickname being typed.
export const YOU_TAG_MAX = 16;

/** "Você" alone when the name is empty, else "Você · <name>" (trimmed, capped with an ellipsis). */
export function youTagLabel(name: string): string {
  const chars = Array.from(name.trim());
  if (chars.length === 0) return 'Você';
  const shown = chars.length > YOU_TAG_MAX ? `${chars.slice(0, YOU_TAG_MAX - 1).join('').trimEnd()}…` : chars.join('');
  return `Você · ${shown}`;
}
