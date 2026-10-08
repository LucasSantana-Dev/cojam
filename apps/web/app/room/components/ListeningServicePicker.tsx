'use client';

// "Ouvir no": the segmented control that says which service plays the room for
// THIS person. Presentational: the room owns the preference, authorization and
// the connect flow. Violet marks the chosen segment only (DESIGN.md, round 4).
import type { Source, ServicePreference } from '@/lib/pickSource';
import { platformIcon } from '@/app/components/icons';

const NAME: Record<Source, string> = { spotify: 'Spotify', apple: 'Apple Music', youtube: 'YouTube' };

export interface ListeningServicePickerProps {
  preference: ServicePreference;
  onChange: (next: ServicePreference) => void;
  // Spotify / Apple Music appear only when their feature flag is on.
  spotifyEnabled: boolean;
  appleEnabled: boolean;
  spotifyConnected: boolean;
  appleConnected: boolean;
  // Spotify not connected: its segment offers to connect instead of selecting.
  onConnectSpotify: () => void;
  // Set when the chosen service cannot play the current track and another one is
  // playing instead.
  // reason: the account is not connected, or the track has no version there.
  fallback?: { wanted: Source; playing: Source | null; reason: 'not-connected' | 'no-version' } | null;
}

export function ListeningServicePicker({
  preference,
  onChange,
  spotifyEnabled,
  appleEnabled,
  spotifyConnected,
  appleConnected,
  onConnectSpotify,
  fallback,
}: ListeningServicePickerProps) {
  const options: Array<{ id: ServicePreference; label: string; source?: Source; connect?: boolean }> = [
    { id: 'auto', label: 'Automático' },
  ];
  if (spotifyEnabled) {
    options.push({ id: 'spotify', label: spotifyConnected ? 'Spotify' : 'Conectar Spotify', source: 'spotify', connect: !spotifyConnected });
  }
  // Apple Music has its own connect button in the player panel, so the segment
  // only appears once it is connected and can actually play.
  if (appleEnabled && appleConnected) options.push({ id: 'apple', label: 'Apple Music', source: 'apple' });
  options.push({ id: 'youtube', label: 'YouTube', source: 'youtube' });

  return (
    <div className="r4-service">
      <div className="r4-service__row">
        <span className="r4-service__label" id="r4-service-label">Ouvir no</span>
        <div className="r4-seg" role="group" aria-labelledby="r4-service-label">
          {options.map((o) => {
            const Icon = o.source ? platformIcon[o.source] : null;
            const pressed = !o.connect && preference === o.id;
            return (
              <button
                key={o.id}
                type="button"
                className="r4-seg__btn"
                // The connect action is not a toggle, so it carries no pressed state.
                aria-pressed={o.connect ? undefined : pressed}
                onClick={() => (o.connect ? onConnectSpotify() : onChange(o.id))}
              >
                {Icon && <Icon size={16} />}
                {o.label}
              </button>
            );
          })}
        </div>
      </div>
      {fallback && (
        <p className="r4-service__note" role="status">
          {fallback.reason === 'not-connected'
            ? `${NAME[fallback.wanted]} não conectado${fallback.playing ? `, tocando no ${NAME[fallback.playing]}` : ''}.`
            : `Esta faixa não tem versão no ${NAME[fallback.wanted]}${fallback.playing ? `, tocando no ${NAME[fallback.playing]}` : ''}.`}
        </p>
      )}
    </div>
  );
}
