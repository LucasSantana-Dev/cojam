'use client';

import { useState } from 'react';
import { useStore, kickMember, rpcErrorMessage } from '@/lib/realtime';
import { useRuntimeFeatures } from '@/lib/useRuntimeFeatures';
import { memberLabel } from '@/lib/nameSuffix';
import { platformIcon } from '@/app/components/icons';
import { avatarGradient } from '@/lib/avatar';

interface PresenceBarProps {
  roomId: string;
  // Host moderation affordance (#181): the host sees a kick button per member
  // (never on themselves). The server re-checks host status; convenience only.
  canControl?: boolean;
}

export function PresenceBar({ roomId, canControl = false }: PresenceBarProps) {
  const f = useRuntimeFeatures();
  const members = useStore((s) => s.members);
  const nameSuffixes = useStore((s) => s.nameSuffixes);
  const myClientId = useStore((s) => s.clientId);

  // Presence entries are per connection (#165): no name dedupe — two listeners
  // that picked the same name are two people, disambiguated by the label suffix.
  // Host moderation (#181): the host can expand the list to reach every
  // member — the +N overflow otherwise hides kick targets.
  const [expanded, setExpanded] = useState(false);
  const visible = canControl && expanded ? members : members.slice(0, 6);
  const hiddenCount = Math.max(0, members.length - 6);

  // Don't render if presence is disabled
  if (!f.presence) {
    return null;
  }

  const handleKick = (member: { clientId: string; name: string }) => {
    kickMember(roomId, member.clientId).catch((err) => {
      console.warn('[moderation] kick failed:', rpcErrorMessage(err, 'unknown error'));
    });
  };

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
              {canControl && member.clientId !== myClientId && (
                <button
                  type="button"
                  onClick={() => handleKick(member)}
                  title={`Remove ${member.name} from the room`}
                  aria-label={`Remove ${member.name} from the room`}
                  className="absolute -top-1 -right-1 w-4 h-4 rounded-full text-[10px] leading-none flex items-center justify-center opacity-0 group-hover:opacity-100 focus:opacity-100 transition-all duration-150 focus:outline-none"
                  style={{
                    backgroundColor: 'var(--color-status-error)',
                    color: 'var(--color-surface-0)',
                  }}
                >
                  ×
                </button>
              )}
            </div>
          );
        })}
        {hiddenCount > 0 && canControl && (
          <button
            type="button"
            onClick={() => setExpanded((e) => !e)}
            className="avatar-chip animate-fade-in"
            style={{
              backgroundColor: 'var(--color-surface-2)',
              color: 'var(--color-text-secondary)',
              border: '2px solid var(--color-surface-1)',
            }}
            title={expanded ? 'Show fewer members' : 'Show all members (host)'}
            aria-expanded={expanded}
          >
            {expanded ? '−' : `+${hiddenCount}`}
          </button>
        )}
        {hiddenCount > 0 && !canControl && (
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
