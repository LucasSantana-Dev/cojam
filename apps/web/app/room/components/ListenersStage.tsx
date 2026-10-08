'use client';

// "Ouvindo agora": the listener row of the room (#325, round 4). Big initials
// avatars (guests have no photos), each with its coloured service badge (the one
// place a brand colour is allowed), the name and the service under it.
// Violet sound-wave arcs above every avatar and a small wave glyph between
// neighbours breathe on the shared beat clock (lib/beatClock, the same clock as
// ListenersWave) while the room plays. Paused, alone or under reduced motion
// they are static. This is the one thing that moves at rest in the room.
//
// Host moderation lives here too (it used to be the header presence bar): any
// member can report another member, the host can remove one. The server
// re-checks both.
import { useEffect, useRef, useState } from 'react';
import { useStore, useMyUserId, claimHost, kickMember, setRoomAdmin, transferHost, rpcErrorMessage, getClockOffsetMs } from '@/lib/realtime';
import { useDialogFocus } from './useDialogFocus';
import { useRuntimeFeatures } from '@/lib/useRuntimeFeatures';
import { memberLabel } from '@/lib/nameSuffix';
import { ServiceBadge } from '@/app/components/ServiceBadge';
import { avatarGradient } from '@/lib/avatar';
import { memberCharacter } from '@/lib/characters';
import { CharacterAvatar } from './CharacterAvatar';
import { useReportDialog } from '@/app/components/useReportDialog';
import { beatAt } from '@/lib/beatClock';
import { useMotion } from '@/lib/motionFlags';

const VISIBLE = 6;
const ARCS = 3;
const ARC_LAG_MS = 70; // each outer arc lags the inner one: a ripple, not a blink

const PLATFORM_LABEL = { spotify: 'Spotify', youtube: 'YouTube' } as const;

interface ListenersStageProps {
  roomId: string;
  // Host moderation affordance (#181): the host or owner sees a remove control
  // per member (never on themselves) and the role menu. Admins do not.
  canModerate?: boolean;
  // Server-stamped admin ids and room owner; admins get a chip by the name.
  admins?: readonly string[];
  ownerUserId?: string;
  // Transport is playing: the arcs breathe.
  running: boolean;
  // Server-stamped host id (room auth); the host gets a crown by the name.
  hostUserId?: string;
  // Pre-join preview: the row only, no report or remove controls.
  readOnly?: boolean;
}

// One arc of a radio wave above an avatar, in a 160x70 box whose centre
// (80, 66) sits on the avatar's centre. The CSS scales the box with the avatar.
function arcPath(r: number): string {
  const a = (52 * Math.PI) / 180;
  const x = Math.sin(a) * r;
  const y = Math.cos(a) * r;
  return `M${(80 - x).toFixed(1)} ${(66 - y).toFixed(1)} A${r} ${r} 0 0 1 ${(80 + x).toFixed(1)} ${(66 - y).toFixed(1)}`;
}
const ARC_RADII = [46, 56, 66];

function Crown() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" focusable="false">
      <path d="M3 8l4.5 4L12 5l4.5 7L21 8l-2 11H5L3 8z" />
    </svg>
  );
}

function WaveGlyph() {
  return (
    <svg className="r4-ls__glyph" width="30" height="14" viewBox="0 0 30 14" fill="none" aria-hidden="true" focusable="false">
      <path d="M1 7c3-8 5-8 7 0s4 8 7 0 4-8 7 0 4 8 7 0" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  );
}

type RoleMember = { userId?: string; name: string };

// Confirm dialog for handing the host role to someone else. The owner (or the
// new host) can take it back, so the copy says it is recoverable.
function TransferDialog({ target, onCancel, onConfirm, busy }: { target: RoleMember; onCancel: () => void; onConfirm: () => void; busy: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  useDialogFocus(true, onCancel, ref);
  return (
    <div className="r4-ls__scrim">
      <div ref={ref} role="dialog" aria-modal="true" aria-labelledby="r4-transfer-h" className="r4-ls__dialog">
        <h3 id="r4-transfer-h" className="r4-h2">Passar o anfitrião para {target.name}?</h3>
        <p className="r4-ls__dialog-text">
          {target.name} passa a ser o anfitrião da sala. O dono da sala pode retomar o posto a qualquer momento.
        </p>
        <div className="r4-ls__dialog-actions">
          <button type="button" className="r4-ghost r4-ls__dialog-btn" onClick={onCancel}>
            Cancelar
          </button>
          <button type="button" className="btn-primary r4-ls__dialog-btn" onClick={onConfirm} disabled={busy}>
            Passar anfitrião
          </button>
        </div>
      </div>
    </div>
  );
}

export function ListenersStage({ roomId, canModerate = false, running, hostUserId, admins, ownerUserId, readOnly = false }: ListenersStageProps) {
  const canControl = canModerate;
  const myUserId = useMyUserId();
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const [transferTo, setTransferTo] = useState<RoleMember | null>(null);
  const [busy, setBusy] = useState(false);
  const [roleError, setRoleError] = useState<string | null>(null);
  const f = useRuntimeFeatures();
  const report = useReportDialog();
  const members = useStore((s) => s.members);
  const nameSuffixes = useStore((s) => s.nameSuffixes);
  const myClientId = useStore((s) => s.clientId);
  const motion = useMotion();
  const boxRef = useRef<HTMLDivElement>(null);

  // Presence entries are per connection (#165): no name dedupe. The host can
  // expand the list to reach every member; the +N overflow otherwise hides
  // remove targets.
  const [expanded, setExpanded] = useState(false);
  const visible = canControl && expanded ? members : members.slice(0, VISIBLE);
  const hiddenCount = Math.max(0, members.length - VISIBLE);
  const alone = members.length < 2;

  // The beat: one rAF loop that writes --b0..--b2 on the row, only while
  // playing, on screen and with the tab visible. Not started under reduced
  // motion: the CSS fallback is a still frame.
  // `rendered` is a dependency: the row only exists once presence is on and the
  // first member is in, which can be after the first run. Without it the effect
  // found no box on mount and never started the beat (the arcs stayed still).
  const rendered = f.presence && members.length > 0;
  useEffect(() => {
    const box = boxRef.current;
    if (!box || !rendered || !running || !motion.ground || typeof IntersectionObserver === 'undefined') return;
    let raf = 0;
    let on = false;
    let seen = true;
    const draw = () => {
      const t = Date.now() + getClockOffsetMs();
      for (let i = 0; i < ARCS; i++) box.style.setProperty(`--b${i}`, beatAt(t - i * ARC_LAG_MS).pulse.toFixed(3));
      box.style.setProperty('--beat', beatAt(t).pulse.toFixed(3));
    };
    const frame = () => {
      raf = requestAnimationFrame(frame);
      draw();
    };
    const sync = () => {
      const should = seen && !document.hidden;
      if (should && !on) {
        on = true;
        raf = requestAnimationFrame(frame);
      } else if (!should && on) {
        on = false;
        cancelAnimationFrame(raf);
      }
    };
    const io = new IntersectionObserver(([e]) => {
      seen = e.isIntersecting;
      sync();
    });
    io.observe(box);
    document.addEventListener('visibilitychange', sync);
    sync();
    return () => {
      cancelAnimationFrame(raf);
      io.disconnect();
      document.removeEventListener('visibilitychange', sync);
      for (let i = 0; i < ARCS; i++) box.style.removeProperty(`--b${i}`);
      box.style.removeProperty('--beat');
    };
  }, [running, motion.ground, rendered]);

  // Nothing to show when presence is disabled or nobody is connected
  if (!f.presence || members.length === 0) return null;

  const handleKick = (member: { clientId: string; clientIds?: string[]; name: string }) => {
    // One person can hold several connections; room.kick takes one clientId.
    // A ghost connection answers "not in this room": warn only if every call failed.
    Promise.allSettled((member.clientIds ?? [member.clientId]).map((id) => kickMember(roomId, id))).then((results) => {
      const failed = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
      if (failed.length === results.length) {
        console.warn('[moderation] kick failed:', rpcErrorMessage(failed[0].reason, 'unknown error'));
      }
    });
  };

  const runRole = async (fn: () => Promise<void>) => {
    setBusy(true);
    setRoleError(null);
    try {
      await fn();
      setMenuFor(null);
      setTransferTo(null);
    } catch (e) {
      setRoleError(rpcErrorMessage(e, 'Não foi possível mudar o papel.'));
    } finally {
      setBusy(false);
    }
  };

  const tuned = running && !alone;
  // "em sintonia" sits over this client's own avatar: drift correction is what
  // keeps this client in step with the room (no per-member sync data exists).
  const meIdx = visible.findIndex((v) => (v.clientIds ?? [v.clientId]).includes(myClientId));
  const tunedIdx = meIdx >= 0 ? meIdx : 0;

  return (
    <section className="r4-card r4-listeners" aria-labelledby="r4-listeners-h">
      <header className="r4-listeners__head">
        <h2 id="r4-listeners-h" className="r4-h2">Ouvindo agora</h2>
        {Boolean(myUserId && ownerUserId === myUserId && hostUserId && hostUserId !== myUserId) && (
          <button
            type="button"
            className="r4-ghost r4-ls__claim"
            disabled={busy}
            onClick={() => runRole(() => claimHost(roomId))}
          >
            Retomar anfitrião
          </button>
        )}
        <span className="r4-listeners__count" aria-hidden="true">
          / palco
        </span>
        <span className="sr-only">{members.length === 1 ? '1 ouvindo' : `${members.length} ouvindo`}</span>
      </header>

      <div ref={boxRef} data-count={visible.length} className={`r4-ls${running ? ' is-running' : ''}${tuned ? ' is-tuned' : ''}`} role="group" aria-label="Quem está ouvindo">
        {visible.map((member, i) => {
          const label = memberLabel(member, nameSuffixes);
          const isHost = Boolean(hostUserId && member.userId && member.userId === hostUserId);
          const mine = (member.clientIds ?? [member.clientId]).includes(myClientId);
          const isAdmin = Boolean(member.userId && admins?.includes(member.userId));
          const isOwner = Boolean(ownerUserId && member.userId === ownerUserId);
          const manageable = !readOnly && canControl && !mine && Boolean(member.userId) && !isOwner && member.userId !== myUserId;
          const menuKey = member.userId ?? member.clientId;
          return (
            <div key={member.userId ?? member.clientId} className="r4-ls__item">
              {i > 0 && (
                <span className="r4-ls__between" aria-hidden="true">
                  <WaveGlyph />
                </span>
              )}
              <div className="r4-ls__member">
                <div className="r4-ls__av-wrap">
                  {tuned && i === tunedIdx && (
                    <span className="r4-ls__tuned" aria-hidden="true">
                      em sintonia
                    </span>
                  )}
                  <svg className="r4-arcs" viewBox="0 0 160 70" aria-hidden="true" focusable="false">
                    {ARC_RADII.map((r, k) => (
                      <path key={r} className={`r4-arcs__a r4-arcs__a${k}`} d={arcPath(r)} fill="none" strokeWidth="2.6" strokeLinecap="round" />
                    ))}
                  </svg>
                  <div className="r4-ls__av" style={{ background: avatarGradient(member.userId ?? member.clientId ?? member.name) }}>
                    <CharacterAvatar characterId={memberCharacter(member)} initial={member.name.charAt(0).toUpperCase()} />
                    {member.platform && (
                      <span className="r4-ls__badge">
                        <ServiceBadge source={member.platform} size="md" />
                      </span>
                    )}
                  </div>
                </div>
                <div className="r4-ls__name">
                  {isHost && (
                    <span className="r4-ls__crown" role="img" aria-label="Anfitrião">
                      <Crown />
                    </span>
                  )}
                  <span className="r4-ls__name-text" title={label} tabIndex={0}>{label}</span>
                  <span className="r4-ls__full" aria-hidden="true">{label}</span>
                </div>
                {isAdmin && <span className="r4-chip r4-ls__chip">admin</span>}
                {manageable && (
                  <div className="r4-ls__roles">
                    <button
                      type="button"
                      className="r4-ghost r4-ls__roles-btn"
                      aria-expanded={menuFor === menuKey}
                      aria-label={`Papéis de ${label}`}
                      onClick={() => {
                        setRoleError(null);
                        setMenuFor((cur) => (cur === menuKey ? null : menuKey));
                      }}
                    >
                      Papéis
                    </button>
                    {menuFor === menuKey && (
                      <div className="r4-ls__menu" role="group" aria-label={`Ações para ${label}`}>
                        <button
                          type="button"
                          className="r4-ghost r4-ls__menu-btn"
                          disabled={busy}
                          onClick={() => runRole(() => setRoomAdmin(roomId, member.userId!, !isAdmin))}
                        >
                          {isAdmin ? 'Remover admin' : 'Tornar admin'}
                        </button>
                        <button
                          type="button"
                          className="r4-ghost r4-ls__menu-btn"
                          disabled={busy || member.userId === hostUserId}
                          onClick={() => setTransferTo({ userId: member.userId, name: label })}
                        >
                          Passar anfitrião
                        </button>
                        {roleError && (
                          <p role="alert" className="r4-ls__menu-err">
                            {roleError}
                          </p>
                        )}
                      </div>
                    )}
                  </div>
                )}
                {member.platform && <div className="r4-ls__svc">({PLATFORM_LABEL[member.platform]})</div>}
                <span className="r4-ls__tools">
                  {!readOnly && !mine && (
                    <button
                      type="button"
                      onClick={() =>
                        report.open({ roomId, kind: 'member', subjectId: member.clientId, subjectLabel: label })
                      }
                      aria-label={`Denunciar ${label}`}
                      className="report-user-btn"
                    >
                      <span aria-hidden="true">⚑</span>
                    </button>
                  )}
                  {!readOnly && canControl && !mine && !isOwner && (
                    <button
                      type="button"
                      onClick={() => handleKick(member)}
                      title={`Remover ${label} da sala`}
                      aria-label={`Remover ${label} da sala`}
                      className="r4-ls__kick"
                    >
                      <span aria-hidden="true">×</span>
                    </button>
                  )}
                </span>
              </div>
            </div>
          );
        })}
        {hiddenCount > 0 && (
          <div className="r4-ls__item">
            {canControl ? (
              <button
                type="button"
                onClick={() => setExpanded((e) => !e)}
                className="r4-ls__more"
                title={expanded ? 'Mostrar menos membros' : 'Mostrar todos os membros (anfitrião)'}
                aria-expanded={expanded}
              >
                {expanded ? '−' : `+${hiddenCount}`}
              </button>
            ) : (
              <div className="r4-ls__more">+{hiddenCount}</div>
            )}
          </div>
        )}
      </div>
      {report.dialog}
      {transferTo && (
        <TransferDialog
          target={transferTo}
          busy={busy}
          onCancel={() => setTransferTo(null)}
          onConfirm={() => runRole(() => transferHost(roomId, transferTo.userId!))}
        />
      )}
    </section>
  );
}
