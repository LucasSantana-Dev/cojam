'use client';

import { useStore } from '@/lib/realtime';
import { useRuntimeFeatures } from '@/lib/useRuntimeFeatures';
import { memberLabel } from '@/lib/nameSuffix';
import { platformIcon } from '@/app/components/icons';
import { avatarGradient } from '@/lib/avatar';

export function PresenceBar() {
  const f = useRuntimeFeatures();
  const members = useStore((s) => s.members);
  const nameSuffixes = useStore((s) => s.nameSuffixes);

  // Presence entries are per connection (#165): no name dedupe — two listeners
  // that picked the same name are two people, disambiguated by the label suffix.
  const visible = members.slice(0, 6);
  const hiddenCount = Math.max(0, members.length - 6);

  // Don't render if presence is disabled
  if (!f.presence) {
    return null;
  }

  return (
    <div className="flex items-center gap-3">
      <div className="flex items-center flex-wrap gap-2">
        {visible.map((member) => {
          const label = memberLabel(member, nameSuffixes);
          const initial = member.name.charAt(0).toUpperCase();
          const Icon = member.platform ? platformIcon[member.platform] : null;
          return (
            <div
              key={member.clientId}
              className="avatar-chip animate-fade-in relative group"
              style={{ background: avatarGradient(member.clientId || member.name) }}
              title={label}
            >
              {initial}
              {Icon && (
                <div
                  className="absolute -bottom-1 -right-1 p-1 rounded-full bg-white dark:bg-slate-900 flex items-center justify-center"
                  style={{
                    backgroundColor: 'var(--color-surface-0)',
                    border: '2px solid var(--color-surface-1)',
                    color: 'var(--color-text-secondary)',
                  }}
                  title={member.platform}
                >
                  <Icon size={10} />
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
