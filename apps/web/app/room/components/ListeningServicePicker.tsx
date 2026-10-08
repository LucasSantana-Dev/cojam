'use client';

// "Ouvir no": which service plays the room for THIS person. Presentational: the
// room owns the preference, authorization and the connect flow. Two shapes of
// the same control: the icon row under the cover of the now-playing card
// (variant "icons", the mockup) and the labelled list inside the avatar menu
// ("list", which also offers Automático and the connect action).
import type { Source, ServicePreference } from '@/lib/pickSource';
import { platformIcon } from '@/app/components/icons';

const NAME: Record<Source, string> = { spotify: 'Spotify', apple: 'Apple Music', youtube: 'YouTube' };

export interface ServiceOption {
  id: ServicePreference;
  label: string;
  source?: Source;
  // Spotify not connected: the option offers to connect instead of selecting.
  connect?: boolean;
}

export interface ServiceOptionFlags {
  // Spotify / Apple Music appear only when their feature flag is on.
  spotifyEnabled: boolean;
  appleEnabled: boolean;
  spotifyConnected: boolean;
  appleConnected: boolean;
  // Automático is a menu choice, not an icon.
  withAuto?: boolean;
}

export function serviceOptions({ spotifyEnabled, appleEnabled, spotifyConnected, appleConnected, withAuto }: ServiceOptionFlags): ServiceOption[] {
  const options: ServiceOption[] = [];
  if (withAuto) options.push({ id: 'auto', label: 'Automático' });
  if (spotifyEnabled) {
    options.push({ id: 'spotify', label: spotifyConnected ? 'Spotify' : 'Conectar Spotify', source: 'spotify', connect: !spotifyConnected });
  }
  // Apple Music has its own connect button with the other players, so the option
  // only appears once it is connected and can actually play.
  if (appleEnabled && appleConnected) options.push({ id: 'apple', label: 'Apple Music', source: 'apple' });
  options.push({ id: 'youtube', label: 'YouTube', source: 'youtube' });
  return options;
}

export interface ListeningServicePickerProps extends Omit<ServiceOptionFlags, 'withAuto'> {
  preference: ServicePreference;
  onChange: (next: ServicePreference) => void;
  // Spotify not connected: its option offers to connect instead of selecting.
  onConnectSpotify: () => void;
  // The service actually playing for this person; highlighted while the
  // preference is Automático.
  effective?: Source | null;
  variant?: 'icons' | 'list';
}

export function ListeningServicePicker({
  preference,
  onChange,
  spotifyEnabled,
  appleEnabled,
  spotifyConnected,
  appleConnected,
  onConnectSpotify,
  effective = null,
  variant = 'icons',
}: ListeningServicePickerProps) {
  const list = variant === 'list';
  const options = serviceOptions({ spotifyEnabled, appleEnabled, spotifyConnected, appleConnected, withAuto: list });
  const chosen: ServicePreference = preference === 'auto' && !list && effective ? effective : preference;

  return (
    <div className={list ? 'r4-svclist' : 'r4-svc'} role="group" aria-label="Ouvir no">
      {options.map((o) => {
        const Icon = o.source ? platformIcon[o.source] : null;
        const pressed = !o.connect && chosen === o.id;
        return (
          <button
            key={o.id}
            type="button"
            className={list ? 'r4-svclist__btn' : 'r4-svc__btn'}
            aria-label={o.label}
            title={o.connect ? 'Conectar o Spotify para ouvir por ele' : `Ouvir no ${o.source ? NAME[o.source] : 'modo automático'}`}
            // The connect action is not a toggle, so it carries no pressed state.
            aria-pressed={o.connect ? undefined : pressed}
            onClick={() => (o.connect ? onConnectSpotify() : onChange(o.id))}
          >
            {Icon && <Icon size={list ? 18 : 22} />}
            {list && <span>{o.label}</span>}
          </button>
        );
      })}
    </div>
  );
}

// The "chosen service cannot play this" note, kept as its own element so the
// card can place it without disturbing the icon row.
export function ServiceFallbackNote({ fallback }: { fallback: { wanted: Source; playing: Source | null; reason: 'not-connected' | 'no-version' } }) {
  return (
    <p className="r4-service__note" role="status">
      {fallback.reason === 'not-connected'
        ? `${NAME[fallback.wanted]} não conectado${fallback.playing ? `, tocando no ${NAME[fallback.playing]}` : ''}.`
        : `Esta faixa não tem versão no ${NAME[fallback.wanted]}${fallback.playing ? `, tocando no ${NAME[fallback.playing]}` : ''}.`}
    </p>
  );
}
