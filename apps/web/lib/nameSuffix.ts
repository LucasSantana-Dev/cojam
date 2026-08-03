// Duplicate display-name disambiguation (#170). Suffixes are a pure function of
// the identity-keyed member list: group by name, sort each colliding group by
// clientId, first gets no suffix, then " (2)", " (3)". Deterministic — every
// client computes identical labels from the same member list; labels may
// renumber when membership changes (accepted per docs/specs/170).

type Named = { clientId: string; name: string };

export function computeNameSuffixes(members: Named[]): Record<string, string> {
  const byName = new Map<string, string[]>();
  for (const m of members) {
    const ids = byName.get(m.name);
    if (ids) ids.push(m.clientId);
    else byName.set(m.name, [m.clientId]);
  }
  const suffixes: Record<string, string> = {};
  for (const ids of byName.values()) {
    if (ids.length === 1) {
      suffixes[ids[0]] = '';
      continue;
    }
    ids.sort();
    ids.forEach((id, i) => {
      suffixes[id] = i === 0 ? '' : ` (${i + 1})`;
    });
  }
  return suffixes;
}

export function applyNameSuffix(name: string, suffix: string): string {
  return suffix ? name + suffix : name;
}

// memberLabel composes the display label one member carries on every presence
// surface (PresenceBar, fused chip) for the life of the session.
export function memberLabel(member: Named, suffixes: Record<string, string>): string {
  return applyNameSuffix(member.name, suffixes[member.clientId] ?? '');
}
