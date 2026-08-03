'use client';

import { useStore } from '@/lib/realtime';
import { useRuntimeFeatures } from '@/lib/useRuntimeFeatures';
import { memberLabel } from '@/lib/nameSuffix';
import { avatarGradient } from '@/lib/avatar';

// PresenceMeta is the fused now-playing chip's presence fragment: avatar stack,
// listener count, and the trailing separator dot. Membership is per connection
// (#165) — no name dedupe; colliding names carry the shared suffix (#170).
export function PresenceMeta() {
  const f = useRuntimeFeatures();
  const members = useStore((s) => s.members);
  const nameSuffixes = useStore((s) => s.nameSuffixes);

  if (!f.presence || members.length === 0) {
    return null;
  }

  return (
    <>
      <span className="presence-stack presence-stack--sm" aria-hidden>
        {members.slice(0, 4).map((m) => (
          <span
            key={m.clientId}
            className="avatar-chip"
            style={{ background: avatarGradient(m.clientId || m.name) }}
            title={memberLabel(m, nameSuffixes)}
          >
            {m.name.charAt(0).toUpperCase()}
          </span>
        ))}
      </span>
      <span>{members.length === 1 ? '1 listening' : `${members.length} listening`}</span>
      <span aria-hidden className="np-meta__dot">·</span>
    </>
  );
}
