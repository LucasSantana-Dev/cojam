'use client';

import { useMemo } from 'react';
import { useStore } from '@/lib/realtime';
import { features } from '@/lib/features';
import { platformIcon } from '@/app/components/icons';

export function PresenceBar() {
  const members = useStore((s) => s.members);
  const currentName = useStore((s) => s.name);

  const deduped = useMemo(() => {
    const seen = new Set<string>();
    return members
      .filter((m) => {
        if (seen.has(m.name)) return false;
        seen.add(m.name);
        return true;
      })
      .slice(0, 6);
  }, [members]);

  const hiddenCount = Math.max(0, members.length - 6);

  // Don't render if presence is disabled
  if (!features.presence) {
    return null;
  }

  return (
    <div className="flex items-center gap-3">
      <div className="flex items-center flex-wrap gap-2">
        {deduped.map((member) => {
          const initial = member.name.charAt(0).toUpperCase();
          const Icon = member.platform ? platformIcon[member.platform] : null;
          return (
            <div
              key={member.clientId}
              className="avatar-chip animate-fade-in relative group"
              title={member.name}
            >
              {initial}
              {Icon && (
                <div
                  className="absolute -bottom-1 -right-1 p-1 rounded-full bg-white dark:bg-slate-900 flex items-center justify-center"
                  style={{
                    backgroundColor: 'var(--color-surface-0)',
                    border: '2px solid var(--color-surface-1)',
                  }}
                  title={member.platform}
                >
                  <Icon size={10} style={{ color: 'var(--color-text-secondary)' }} />
                </div>
              )}
            </div>
          );
        })}
        {hiddenCount > 0 && (
          <div
            className="avatar-chip animate-fade-in"
            style={{
              backgroundColor: 'var(--color-surface-2)',
              color: 'var(--color-text-secondary)',
              border: '2px solid var(--color-surface-1)',
            }}
          >
            +{hiddenCount}
          </div>
        )}
      </div>
      <div className="text-sm" style={{ color: 'var(--color-text-secondary)' }}>
        {members.length === 1
          ? '1 listening'
          : `${members.length} listening`}
      </div>
    </div>
  );
}
