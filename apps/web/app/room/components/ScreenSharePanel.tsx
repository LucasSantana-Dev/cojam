'use client';

import { useEffect, useRef, useState } from 'react';
import { useStore } from '@/lib/realtime';
import { MINIMUM_AGE, affirmAge, hasAffirmedAge } from '@/lib/ageGate';
import { useReportDialog } from '@/app/components/useReportDialog';
import { Stage } from './Stage';
import { canCaptureScreen, useScreenShare } from './useScreenShare';

// Screen share v1 (#310, spec 5.2, 5.3, 5.6). Rendered only when
// FEATURE_SCREENSHARE is on; the server stays authoritative on every rule
// (host only, private rooms, 5 viewers, lock, refusal).

const REPORT_WINDOW_MS = 10 * 60 * 1000;

function StreamVideo({ stream, muted, label }: { stream: MediaStream; muted: boolean; label: string }) {
  const ref = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.srcObject = stream;
    void el.play().catch(() => {
      /* autoplay refused: the video stays muted until "Tocar som" */
    });
    return () => {
      el.srcObject = null;
    };
  }, [stream]);
  return <video ref={ref} autoPlay playsInline muted={muted} aria-label={label} data-testid="screen-video" />;
}

export function ScreenSharePanel({
  roomId,
  canModerate,
  isPublic,
}: {
  roomId: string;
  canModerate: boolean;
  isPublic: boolean;
}) {
  const share = useScreenShare(roomId);
  const report = useReportDialog();
  const connections = useStore((s) => s.connections);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [ageChecked, setAgeChecked] = useState(false);
  const [soundOn, setSoundOn] = useState(false);
  const [now, setNow] = useState(() => Date.now());
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
    await share.start();
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
          Compartilhar a tela
        </h2>
        <p className="age-gate__body">
          Até 5 pessoas desta sala podem assistir, cada uma só depois de escolher assistir. A imagem vai direto do seu
          navegador para elas: o CoJam não vê nem grava nada. Quem assiste vê o seu endereço de rede, e você vê o delas.
          Compartilhe só o que você tem direito de mostrar.
        </p>
        {!hasAffirmedAge() && (
          <label className="age-gate__field screen-share__check">
            <input type="checkbox" checked={ageChecked} onChange={(e) => setAgeChecked(e.target.checked)} />
            <span>Tenho {MINIMUM_AGE} anos ou mais</span>
          </label>
        )}
        <div className="age-gate__actions">
          <button type="submit" className="age-gate__btn" disabled={!hasAffirmedAge() && !ageChecked}>
            Escolher o que compartilhar
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
    if (share.role === 'watching') {
      const failed = share.viewerState === 'failed';
      return (
        <section className="screen-share" data-testid="screen-share-watching">
          <Stage
            label="Tela compartilhada"
            overlay={
              <div className="screen-share__overlay">
                <p className="screen-share__notice" data-testid="screen-share-notice">
                  Transmissão não moderada. O CoJam não vê nem grava o que é compartilhado.
                </p>
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
            }
            caption={
              <div className="screen-share__actions">
                <span className="screen-share__who">Tela de {broadcasterName}</span>
                {share.remoteStream && !soundOn && (
                  <button type="button" className="screen-share__btn" onClick={() => setSoundOn(true)}>
                    Tocar som
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
            }
          >
            {share.remoteStream ? (
              <StreamVideo stream={share.remoteStream} muted={!soundOn} label={`Tela de ${broadcasterName}`} />
            ) : (
              <div className="screen-share__blank" />
            )}
          </Stage>
          {messages}
        </section>
      );
    }

    // Broadcasting: who is watching and the controls over admission.
    if (share.isBroadcaster && screen) {
      const noAudio = share.localStream ? share.localStream.getAudioTracks().length === 0 : false;
      return (
        <section className="screen-share screen-share--card" data-testid="screen-share-broadcasting">
          <div className="screen-share__head">
            <span className="screen-share__live" aria-hidden="true" />
            <strong>Você está compartilhando a tela</strong>
            <span className="screen-share__count" data-testid="screen-share-count">
              {screen.viewerCount} de {screen.maxViewers} assistindo
            </span>
          </div>
          {share.localStream && (
            <div className="screen-share__preview">
              <StreamVideo stream={share.localStream} muted label="Prévia do que você compartilha" />
            </div>
          )}
          {noAudio && <p className="screen-share__note">Este navegador não compartilha o som, só a imagem.</p>}
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
          </div>
          <div className="screen-share__actions">
            <button
              type="button"
              className="screen-share__btn screen-share__btn--primary"
              disabled={share.busy || screen.locked || full}
              onClick={() => void share.watch()}
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
              onClick={() => {
                setAgeChecked(false);
                setConfirmOpen(true);
              }}
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
