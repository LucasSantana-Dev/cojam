'use client';

import { useState } from 'react';
import { useStore, kickMember, rpcErrorMessage } from '@/lib/realtime';
import { useRuntimeFeatures } from '@/lib/useRuntimeFeatures';
import { memberLabel } from '@/lib/nameSuffix';
import { platformIcon } from '@/app/components/icons';
import { avatarGradient } from '@/lib/avatar';
import { useReportDialog } from '@/app/components/useReportDialog';
import { ListenerBand } from '@/app/components/ListenerBand';
import { useAxis } from '@/lib/brandAxes';

interface PresenceBarProps {
  roomId: string;
  // Host moderation affordance (#181): the host sees a kick button per member
  // (never on themselves). The server re-checks host status; convenience only.
  canControl?: boolean;
}

export function PresenceBar({ roomId, canControl = false }: PresenceBarProps) {
  const f = useRuntimeFeatures();
  const report = useReportDialog();
  const members = useStore((s) => s.members);
  const nameSuffixes = useStore((s) => s.nameSuffixes);
  const myClientId = useStore((s) => s.clientId);
  const presenceAxis = useAxis('presence');

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
      {presenceAxis === 'all' && members.length > 0 && (
        <span className="presence-band" aria-hidden>
          <ListenerBand
            listeners={members.slice(0, 6).map((m) => ({ name: m.name }))}
            size={30}
          />
        </span>
      )}
      <div className="presence-bar__avatars flex items-center flex-wrap gap-2">
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
              {member.clientId !== myClientId && (
                <button
                  type="button"
                  onClick={() =>
                    report.open({
                      roomId,
                      kind: 'member',
                      subjectId: member.clientId,
                      subjectLabel: member.name,
                    })
                  }
                  aria-label={`Denunciar ${member.name}`}
                  className="report-user-btn absolute -top-1 -left-1 w-4 h-4 rounded-full text-[10px] leading-none flex items-center justify-center opacity-0 group-hover:opacity-100 focus:opacity-100 transition-all duration-150 focus:outline-none"
                  style={{
                    backgroundColor: 'var(--color-surface-2)',
                    color: 'var(--color-text-secondary)',
                    border: '1px solid var(--color-surface-3)',
                  }}
                >
                  ⚑
                </button>
              )}
              {canControl && member.clientId !== myClientId && (
                <button
                  type="button"
                  onClick={() => handleKick(member)}
                  title={`Remover ${member.name} da sala`}
                  aria-label={`Remover ${member.name} da sala`}
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
            title={expanded ? 'Mostrar menos membros' : 'Mostrar todos os membros (anfitrião)'}
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
      {report.dialog}
      <div className="text-sm" style={{ color: 'var(--color-text-secondary)' }}>
        {members.length === 1
          ? '1 ouvindo'
          : `${members.length} ouvindo`}
      </div>
    </div>
  );
}
