import { avatarGradient } from '@/lib/avatar';
import { SpotifyIcon, YouTubeIcon, AppleMusicIcon } from '@/app/components/icons';

// A static, clearly illustrative live room for the landing hero: the room's own
// language (now-playing card with the violet glowing border, "Ouvindo agora"
// stage with service badges) built from example data. Presentational only: no
// room state, no sockets. The whole card is one labelled image for assistive tech.
type Service = 'Spotify' | 'YouTube' | 'Apple Music';
const BADGE: Record<Service, React.ComponentType<{ size?: number }>> = {
  Spotify: SpotifyIcon,
  YouTube: YouTubeIcon,
  'Apple Music': AppleMusicIcon,
};

const LISTENERS: Array<{ name: string; service: Service; tuned?: boolean }> = [
  { name: 'Bia', service: 'Spotify' },
  { name: 'Caio', service: 'YouTube' },
  { name: 'Dani', service: 'Apple Music', tuned: true },
  { name: 'Lucas', service: 'Spotify' },
  { name: 'Maju', service: 'YouTube' },
];

export function RoomPreview({ id = 'previa' }: { id?: string }) {
  return (
    <div
      id={id}
      className="r4s-preview"
      role="img"
      aria-label="Prévia ilustrativa de uma sala: Pétala, de Djavan, tocando para cinco pessoas em Spotify, YouTube e Apple Music"
    >
      <div className="r4s-np">
        <div className="r4s-np__cover" aria-hidden />
        <div className="r4s-np__body">
          <p className="r4s-np__kicker">Tocando agora</p>
          <p className="r4s-np__title">Pétala</p>
          <p className="r4s-np__artist">Djavan</p>
          <span className="r4s-chip">Bia pediu</span>
          <div className="r4s-np__bar" aria-hidden>
            <span style={{ width: '40%' }} />
          </div>
          <div className="r4s-np__times" aria-hidden>
            <span>1:24</span>
            <span>3:34</span>
          </div>
          <div className="r4s-np__ctrl" aria-hidden>
            <svg className="r4s-np__skip" width="22" height="22" viewBox="0 0 24 24" fill="currentColor"><path d="M6 5h2v14H6zM20 5v14L9 12z" /></svg>
            <span className="r4s-np__play">
              <i />
              <i />
            </span>
            <svg className="r4s-np__skip" width="22" height="22" viewBox="0 0 24 24" fill="currentColor"><path d="M16 5h2v14h-2zM4 5v14l11-7z" /></svg>
          </div>
        </div>
      </div>

      <div className="r4s-stage">
        <div className="r4s-stage__head">
          <p className="r4s-stage__title">
            Ouvindo agora <span>/ stage</span>
          </p>
          <span className="r4s-chip r4s-chip--flat">Prévia da sala</span>
        </div>
        <ul className="r4s-stage__row">
          {LISTENERS.map(({ name, service, tuned }) => {
            const Badge = BADGE[service];
            return (
              <li key={name} className="r4s-who" data-tuned={tuned ? '1' : undefined}>
                {tuned && <span className="r4s-who__tuned">em sintonia</span>}
                <span className="r4s-who__avatar" style={{ background: avatarGradient(name) }}>
                  {name.slice(0, 1)}
                  <span className="r4s-who__badge">
                    <Badge size={12} />
                  </span>
                </span>
                <span className="r4s-who__name">{name}</span>
                <span className="r4s-who__svc">{service}</span>
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}
