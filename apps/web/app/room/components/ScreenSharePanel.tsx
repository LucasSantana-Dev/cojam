'use client';

import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useStore } from '@/lib/realtime';
import { MINIMUM_AGE, affirmAge, hasAffirmedAge } from '@/lib/ageGate';
import { useReportDialog } from '@/app/components/useReportDialog';
import { Stage } from './Stage';
import { canCaptureScreen, useScreenShare } from './useScreenShare';
import { SCREEN_QUALITIES, uploadMbps, type ScreenQualityId } from '@/lib/screenShare';

// Screen share v1 (#310, spec 5.2, 5.3, 5.6). Rendered only when
// FEATURE_SCREENSHARE is on; the server stays authoritative on every rule
// (host only, private rooms, 5 viewers, lock, refusal).

const REPORT_WINDOW_MS = 10 * 60 * 1000;

const VOLUME_KEY = 'cojam.screenVolume';

function savedVolume(): number {
  try {
    const v = Number(localStorage.getItem(VOLUME_KEY));
    return v > 0 && v <= 1 ? v : 1;
  } catch {
    return 1;
  }
}

// "Ao vivo há 12 min" from the server's start time. Clocks can differ a
// little, so a negative span reads as just started.
export function liveFor(startedAtMs: number, nowMs: number): string {
  const min = Math.max(0, Math.floor((nowMs - startedAtMs) / 60_000));
  if (min < 1) return 'Ao vivo agora';
  if (min < 60) return `Ao vivo há ${min} min`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m ? `Ao vivo há ${h} h ${m} min` : `Ao vivo há ${h} h`;
}

function canPictureInPicture(): boolean {
  return typeof document !== 'undefined' && Boolean(document.pictureInPictureEnabled);
}

// The quality picker, before sharing and while live. The note tells how much
// upload each viewer takes, since the mesh sends one copy per viewer.
function QualityPicker({ share }: { share: ScreenShare }) {
  return (
    <div className="screen-share__quality">
      <label>
        <span>Qualidade</span>
        <select
          value={share.quality.id}
          aria-label="Qualidade da transmissão"
          onChange={(e) => void share.setQuality(e.target.value as ScreenQualityId)}
        >
          {SCREEN_QUALITIES.map((q) => (
            <option key={q.id} value={q.id}>
              {q.label} ({q.detail})
            </option>
          ))}
        </select>
      </label>
      <span className="screen-share__note" data-testid="screen-share-upload">
        Cada pessoa assistindo usa até {uploadMbps(share.quality, 1).toLocaleString('pt-BR')} Mbps do seu upload.
      </span>
    </div>
  );
}

// The broadcaster's optional line about what is on screen, shown on the card
// before anyone chooses to watch (spec 5.7). A text hint, never a picture.
function LabelField({ share }: { share: ScreenShare }) {
  const current = share.screen?.label ?? '';
  const [draft, setDraft] = useState(current);
  const [saved, setSaved] = useState(current);
  if (current !== saved) {
    setSaved(current);
    setDraft(current);
  }
  const save = async (e?: React.FormEvent) => {
    e?.preventDefault();
    if (draft.trim() === current) return;
    await share.setLabel(draft);
  };
  return (
    <form className="screen-share__label" onSubmit={save}>
      <label>
        <span>O que você está mostrando (opcional)</span>
        <input
          type="text"
          value={draft}
          maxLength={60}
          placeholder="Ex.: revisão do projeto"
          onChange={(e) => setDraft(e.target.value)}
          onBlur={() => void save()}
        />
      </label>
    </form>
  );
}

function StreamVideo({
  stream,
  muted,
  volume = 1,
  label,
  onRatio,
  videoRef,
}: {
  stream: MediaStream;
  muted: boolean;
  volume?: number;
  label: string;
  onRatio?: (ratio: number) => void;
  videoRef?: React.RefObject<HTMLVideoElement | null>;
}) {
  const ownRef = useRef<HTMLVideoElement>(null);
  const ref = videoRef ?? ownRef;
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.srcObject = stream;
    void el.play()?.catch(() => {
      /* autoplay refused: the video stays muted until "Tocar som" */
    });
    return () => {
      el.srcObject = null;
    };
  }, [stream, ref]);
  // Set the property directly: the attribute alone does not unmute a playing
  // element in every browser, and play() again in case autoplay held it.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.muted = muted;
    if (!muted) void el.play()?.catch(() => {});
  }, [muted, ref]);
  useEffect(() => {
    if (ref.current) ref.current.volume = volume;
  }, [volume, ref]);
  const reportRatio = () => {
    const el = ref.current;
    if (el && el.videoWidth > 0 && el.videoHeight > 0) onRatio?.(el.videoWidth / el.videoHeight);
  };
  return (
    <video
      ref={ref}
      autoPlay
      playsInline
      muted={muted}
      aria-label={label}
      data-testid="screen-video"
      onLoadedMetadata={reportRatio}
      onResize={reportRatio}
    />
  );
}

type PanelProps = {
  roomId: string;
  canModerate: boolean;
  isPublic: boolean;
};

export type ScreenShare = ReturnType<typeof useScreenShare>;

// Owns the share state itself. The room does not use this: it keeps one
// useScreenShare for the whole visit, so switching to or from Modo palco
// (which remounts the panel in another place) never ends a share.
export function ScreenSharePanel(props: PanelProps) {
  const share = useScreenShare(props.roomId);
  return <ScreenSharePanelView {...props} share={share} />;
}

export function ScreenSharePanelView({ roomId, canModerate, isPublic, share }: PanelProps & { share: ScreenShare }) {
  const report = useReportDialog();
  const connections = useStore((s) => s.connections);
  const [confirmOpen, setConfirmOpen] = useState(false);
  // The same 16+ affirmation gates sharing and, since 2026-11-27 (owner
  // decision Q1 in the spec), watching too.
  const [confirmMode, setConfirmMode] = useState<'share' | 'watch'>('share');
  const [ageChecked, setAgeChecked] = useState(false);
  const [soundOn, setSoundOn] = useState(false);
  // Watching opens large (theater) by default: the room column is too narrow
  // for a shared screen. "Reduzir" puts it back in the column.
  const [theater, setTheater] = useState(true);
  const [ratio, setRatio] = useState(16 / 9);
  const sectionRef = useRef<HTMLElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const [volume, setVolume] = useState(savedVolume);
  const [pip, setPip] = useState(false);
  // The viewer peer hands over a new stream whenever a track is added, so
  // counting at render time stays current.
  const audioTracks = share.remoteStream?.getAudioTracks?.().length ?? 0;
  const watching = share.role === 'watching';

  // Each new watch starts large, muted until "Tocar som", with the default ratio.
  const [wasWatching, setWasWatching] = useState(false);
  if (watching !== wasWatching) {
    setWasWatching(watching);
    if (watching) {
      setTheater(true);
      setSoundOn(false);
      setRatio(16 / 9);
    }
  }

  // Theater covers the page: Esc goes back to the room and the page under it
  // does not scroll.
  useEffect(() => {
    if (!watching || !theater) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !document.fullscreenElement) setTheater(false);
    };
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    window.addEventListener('keydown', onKey);
    return () => {
      document.body.style.overflow = prev;
      window.removeEventListener('keydown', onKey);
    };
  }, [watching, theater]);

  const toggleFullscreen = () => {
    const el = sectionRef.current;
    if (!el) return;
    if (document.fullscreenElement) void document.exitFullscreen?.().catch(() => {});
    else void el.requestFullscreen?.().catch(() => {});
  };
  const [now, setNow] = useState(() => Date.now());
  // The live time on the share moves on its own.
  const live = Boolean(share.screen);
  useEffect(() => {
    if (!live) return;
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, [live]);

  const changeVolume = (v: number) => {
    setVolume(v);
    // Moving the slider means the person wants to hear it.
    if (v > 0 && !soundOn) setSoundOn(true);
    try {
      localStorage.setItem(VOLUME_KEY, String(v));
    } catch {
      /* storage unavailable: the volume lasts for this visit */
    }
  };

  // Picture in picture keeps the share in a small window over other tabs.
  const togglePip = async () => {
    const el = videoRef.current;
    if (!el) return;
    try {
      if (document.pictureInPictureElement) await document.exitPictureInPicture();
      else await el.requestPictureInPicture();
    } catch {
      /* refused by the browser: nothing to undo */
    }
  };
  useEffect(() => {
    const el = videoRef.current;
    if (!el || !watching) return;
    const on = () => setPip(true);
    const off = () => setPip(false);
    el.addEventListener('enterpictureinpicture', on);
    el.addEventListener('leavepictureinpicture', off);
    return () => {
      el.removeEventListener('enterpictureinpicture', on);
      el.removeEventListener('leavepictureinpicture', off);
    };
  }, [watching, theater, share.remoteStream]);
  const dialogRef = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const el = dialogRef.current;
    if (!el) return;
    if (confirmOpen && !el.open) el.showModal();
    if (!confirmOpen && el.open) el.close();
  }, [confirmOpen]);

  // The post-watch report window closes on its own.
  useEffect(() => {
    if (!share.lastWatchedAt) return;
    const t = setTimeout(() => setNow(Date.now()), REPORT_WINDOW_MS + 1000);
    return () => clearTimeout(t);
  }, [share.lastWatchedAt]);

  const nameOf = (clientId: string) => connections.find((m) => m.clientId === clientId)?.name || 'Alguém';
  const { screen } = share;
  const broadcasterName = screen?.broadcasterName || 'Alguém';
  const openReport = () => report.open({ roomId, kind: 'broadcast' });

  const messages = (
    <>
      {share.error && (
        <p role="alert" className="screen-share__error">
          {share.error}
        </p>
      )}
      {share.notice && !share.error && (
        <p role="status" className="screen-share__note">
          {share.notice}
        </p>
      )}
    </>
  );

  const confirmStart = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!hasAffirmedAge() && !ageChecked) return;
    affirmAge();
    setConfirmOpen(false);
    if (confirmMode === 'watch') await share.watch();
    else await share.start();
  };

  const askToConfirm = (mode: 'share' | 'watch') => {
    setAgeChecked(false);
    setConfirmMode(mode);
    setConfirmOpen(true);
  };

  const onWatch = () => {
    if (hasAffirmedAge()) void share.watch();
    else askToConfirm('watch');
  };

  const confirmDialog = (
    <dialog
      ref={dialogRef}
      className="age-gate"
      aria-labelledby="screen-share-confirm-title"
      onCancel={(e) => {
        e.preventDefault();
        setConfirmOpen(false);
      }}
      onClose={() => setConfirmOpen(false)}
    >
      <form className="age-gate__panel" onSubmit={confirmStart}>
        <h2 id="screen-share-confirm-title" className="age-gate__title">
          {confirmMode === 'watch' ? 'Assistir à tela compartilhada' : 'Compartilhar a tela'}
        </h2>
        {confirmMode === 'watch' ? (
          <p className="age-gate__body">
            Esta transmissão não é moderada: o CoJam não vê nem grava o que é compartilhado. Assistir conecta você
            diretamente a {broadcasterName}, e vocês verão o endereço de rede um do outro.
          </p>
        ) : (
          <p className="age-gate__body">
            Até 5 pessoas desta sala podem assistir, cada uma só depois de escolher assistir. A imagem vai direto do seu
            navegador para elas: o CoJam não vê nem grava nada. Quem assiste vê o seu endereço de rede, e você vê o
            delas. Compartilhe só o que você tem direito de mostrar (veja os <a href="/termos">Termos de Uso</a>).
          </p>
        )}
        {confirmMode === 'share' && (
          <p className="age-gate__body screen-share__tip">
            Para levar o som, escolha uma <strong>aba do navegador</strong> e deixe ligado{' '}
            <strong>Compartilhar áudio da aba</strong>. No Mac, janela e tela inteira vão sem som.
          </p>
        )}
        {confirmOpen && confirmMode === 'share' && <QualityPicker share={share} />}
        {!hasAffirmedAge() && (
          <label className="age-gate__field screen-share__check">
            <input type="checkbox" checked={ageChecked} onChange={(e) => setAgeChecked(e.target.checked)} />
            <span>Tenho {MINIMUM_AGE} anos ou mais</span>
          </label>
        )}
        <div className="age-gate__actions">
          <button type="submit" className="age-gate__btn" disabled={!hasAffirmedAge() && !ageChecked}>
            {confirmMode === 'watch' ? 'Assistir' : 'Escolher o que compartilhar'}
          </button>
          <button type="button" className="age-gate__btn age-gate__btn--quiet" onClick={() => setConfirmOpen(false)}>
            Cancelar
          </button>
        </div>
      </form>
    </dialog>
  );

  return (
    <>
      {body()}
      {confirmDialog}
      {report.dialog}
    </>
  );

  function body() {
    // Watching: the video on the stage, with the notice that cannot be closed.
    if (watching) {
      const failed = share.viewerState === 'failed';
      const noSound = Boolean(share.remoteStream) && audioTracks === 0;
      const view = (
        <section
          ref={sectionRef}
          className={`screen-share screen-share--watching${theater ? ' screen-share--theater' : ''}`}
          data-testid="screen-share-watching"
          aria-label={`Tela de ${broadcasterName}`}
          style={{ ['--screen-ratio' as string]: String(ratio) }}
        >
          <Stage
            label="Tela compartilhada"
            overlay={
              share.viewerState === 'connecting' || failed ? (
                <div className="screen-share__overlay">
                  {share.viewerState === 'connecting' && (
                    <p className="screen-share__note" role="status">
                      Conectando a {broadcasterName}...
                    </p>
                  )}
                  {failed && (
                    <p className="screen-share__error" role="alert">
                      Não foi possível conectar. Sua rede ou a de {broadcasterName} bloqueia conexões diretas, e o CoJam
                      ainda não tem um servidor de retransmissão.
                    </p>
                  )}
                </div>
              ) : undefined
            }
            caption={
              <div className="screen-share__bar">
                <p className="screen-share__notice" data-testid="screen-share-notice">
                  Transmissão não moderada. O CoJam não vê nem grava o que é compartilhado.
                </p>
                <div className="screen-share__actions">
                  <span className="screen-share__who">Tela de {broadcasterName}</span>
                  {screen && (
                    <span className="screen-share__meta" data-testid="screen-share-live-info">
                      {liveFor(screen.startedAtMs, now)} · {screen.viewerCount} assistindo
                    </span>
                  )}
                  {share.remoteStream && audioTracks > 0 && (
                    <button
                      type="button"
                      className="screen-share__btn screen-share__btn--primary"
                      aria-pressed={soundOn}
                      onClick={() => setSoundOn(!soundOn)}
                    >
                      {soundOn ? 'Tirar som' : 'Tocar som'}
                    </button>
                  )}
                  {share.remoteStream && audioTracks > 0 && (
                    <input
                      type="range"
                      className="screen-share__volume"
                      min={0}
                      max={1}
                      step={0.05}
                      value={soundOn ? volume : 0}
                      aria-label="Volume da transmissão"
                      onChange={(e) => changeVolume(Number(e.target.value))}
                    />
                  )}
                  {noSound && (
                    <span className="screen-share__note" data-testid="screen-share-no-sound">
                      Sem som: {broadcasterName} não compartilhou o áudio.
                    </span>
                  )}
                  <button type="button" className="screen-share__btn" onClick={() => setTheater(!theater)}>
                    {theater ? 'Reduzir' : 'Ampliar'}
                  </button>
                  <button type="button" className="screen-share__btn" onClick={toggleFullscreen}>
                    Tela cheia
                  </button>
                  {share.remoteStream && canPictureInPicture() && (
                    <button
                      type="button"
                      className="screen-share__btn"
                      aria-pressed={pip}
                      onClick={() => void togglePip()}
                    >
                      {pip ? 'Voltar para a sala' : 'Janela flutuante'}
                    </button>
                  )}
                  {failed && (
                    <button type="button" className="screen-share__btn" onClick={() => void share.retryWatch()}>
                      Tentar de novo
                    </button>
                  )}
                  <button type="button" className="screen-share__btn" onClick={() => void share.unwatch()}>
                    Parar de assistir
                  </button>
                  <button type="button" className="screen-share__btn screen-share__btn--quiet" onClick={openReport}>
                    Denunciar transmissão
                  </button>
                </div>
              </div>
            }
          >
            {share.remoteStream ? (
              <StreamVideo
                stream={share.remoteStream}
                muted={!soundOn}
                volume={volume}
                label={`Tela de ${broadcasterName}`}
                onRatio={setRatio}
                videoRef={videoRef}
              />
            ) : (
              <div className="screen-share__blank" />
            )}
          </Stage>
          {messages}
        </section>
      );
      // Large view goes to the body: a transformed ancestor (the room's entry
      // animation, the palco layout) would trap position: fixed in its box.
      return theater && typeof document !== 'undefined' ? createPortal(view, document.body) : view;
    }

    // Broadcasting: who is watching and the controls over admission.
    if (share.isBroadcaster && screen) {
      const noAudio = share.localStream ? share.localStream.getAudioTracks().length === 0 : false;
      return (
        <section className="screen-share screen-share--card" data-testid="screen-share-broadcasting">
          <div className="screen-share__head">
            <span className="screen-share__live" aria-hidden="true" />
            <strong>Você está compartilhando a tela</strong>
            <span className="screen-share__meta">{liveFor(screen.startedAtMs, now)}</span>
            <span className="screen-share__count" data-testid="screen-share-count">
              {screen.viewerCount} de {screen.maxViewers} assistindo
            </span>
          </div>
          {share.localStream && (
            <div className="screen-share__preview">
              <StreamVideo stream={share.localStream} muted label="Prévia do que você compartilha" />
            </div>
          )}
          <QualityPicker share={share} />
          <LabelField share={share} />
          {share.limitation && (
            <p className="screen-share__note" role="status" data-testid="screen-share-limited">
              {share.limitation === 'bandwidth'
                ? 'Sua conexão está no limite: a imagem pode perder qualidade. Uma qualidade menor ou menos espectadores ajudam.'
                : 'Seu computador está no limite: a imagem pode perder qualidade. Uma qualidade menor ajuda.'}
            </p>
          )}
          {noAudio && (
            <p className="screen-share__note" data-testid="screen-share-broadcast-no-sound">
              Sem som: quem assiste só vê a imagem. Para levar o som, use <strong>Trocar o que compartilho</strong>,
              escolha uma aba do navegador e deixe ligado <strong>Compartilhar áudio da aba</strong>.
            </p>
          )}
          {share.viewerIds.length > 0 && (
            <ul className="screen-share__viewers" aria-label="Quem está assistindo">
              {share.viewerIds.map((id) => (
                <li key={id}>
                  <span>{nameOf(id)}</span>
                  <button
                    type="button"
                    className="screen-share__btn screen-share__btn--quiet"
                    onClick={() => void share.refuse(id)}
                  >
                    Remover desta transmissão
                  </button>
                </li>
              ))}
            </ul>
          )}
          <div className="screen-share__actions">
            <button
              type="button"
              className="screen-share__btn"
              aria-pressed={screen.locked}
              onClick={() => void share.lock(!screen.locked)}
            >
              {screen.locked ? 'Abrir entrada' : 'Fechar entrada'}
            </button>
            <button type="button" className="screen-share__btn" onClick={() => void share.changeSource()}>
              Trocar o que compartilho
            </button>
            <button
              type="button"
              className="screen-share__btn screen-share__btn--stop"
              disabled={share.busy}
              onClick={() => void share.stop()}
            >
              Parar de compartilhar
            </button>
          </div>
          {messages}
        </section>
      );
    }

    // Someone else is sharing: an explicit choice to watch, never automatic.
    if (screen) {
      const full = screen.viewerCount >= screen.maxViewers;
      return (
        <section className="screen-share screen-share--card" data-testid="screen-share-available">
          <div className="screen-share__head">
            <span className="screen-share__live" aria-hidden="true" />
            <strong>{broadcasterName} está compartilhando a tela</strong>
            <span className="screen-share__meta" data-testid="screen-share-card-info">
              {liveFor(screen.startedAtMs, now)} · {screen.viewerCount} de {screen.maxViewers} assistindo
            </span>
          </div>
          {screen.label && (
            <p className="screen-share__showing" data-testid="screen-share-label">
              Mostrando: {screen.label}
            </p>
          )}
          <div className="screen-share__actions">
            <button
              type="button"
              className="screen-share__btn screen-share__btn--primary"
              disabled={share.busy || screen.locked || full}
              onClick={onWatch}
            >
              Assistir
            </button>
            {canModerate && (
              <button type="button" className="screen-share__btn" onClick={() => void share.stop()}>
                Encerrar compartilhamento
              </button>
            )}
            {canModerate && (
              <button
                type="button"
                className="screen-share__btn"
                aria-pressed={screen.locked}
                onClick={() => void share.lock(!screen.locked)}
              >
                {screen.locked ? 'Abrir entrada' : 'Fechar entrada'}
              </button>
            )}
          </div>
          {screen.locked ? (
            <p className="screen-share__note">A entrada desta transmissão está fechada.</p>
          ) : full ? (
            <p className="screen-share__note">
              A transmissão está cheia ({screen.viewerCount} de {screen.maxViewers}). Tente quando alguém sair.
            </p>
          ) : (
            <p className="screen-share__note">
              Assistir conecta você diretamente a {broadcasterName}; vocês verão o endereço de rede um do outro.
            </p>
          )}
          {messages}
        </section>
      );
    }

    // Nothing live.
    const canStart = canModerate && !isPublic && canCaptureScreen();
    const canReport = share.lastWatchedAt !== null && now - share.lastWatchedAt < REPORT_WINDOW_MS;
    if (!canStart && !canReport && !share.error && !share.notice) return null;
    return (
      <section className="screen-share screen-share--quiet" data-testid="screen-share-idle">
        <div className="screen-share__actions">
          {canStart && (
            <button
              type="button"
              className="screen-share__btn"
              disabled={share.busy}
              onClick={() => askToConfirm('share')}
            >
              Compartilhar tela
            </button>
          )}
          {canReport && (
            <button type="button" className="screen-share__btn screen-share__btn--quiet" onClick={openReport}>
              Denunciar transmissão
            </button>
          )}
        </div>
        {messages}
      </section>
    );
  }
}
