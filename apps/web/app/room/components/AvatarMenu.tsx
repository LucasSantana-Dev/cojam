'use client';

// The avatar menu of the room's top bar (approved mockup, "r4-coer-9"): the
// person's avatar with its service dot opens a card with the name, the service
// they listen through, "Trocar nome", "Trocar serviço", "Seus dados" (the code
// and the way to ask for deletion) and "Sair da sala". It also holds what used
// to crowd the top bar: report the room, the host's public toggle, the legal
// links and the Spotify connect button.
//
// The panel stays mounted while closed (hidden): the connect players inside it
// own the SDK lifecycle and must never unmount with the menu.
import { useEffect, useRef, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { avatarGradient } from '@/lib/avatar';
import { saveGuestName, NAME_KEY } from '@/lib/guestName';
import { ChevronDownIcon, ChevronRightIcon, LogoutIcon, PencilIcon, SwapIcon, CheckIcon, UserCircleIcon } from '@/app/components/icons';
import { CharacterAvatar } from './CharacterAvatar';
import { CharacterPicker } from './CharacterPicker';
import { ServiceBadge } from '@/app/components/ServiceBadge';
import { YourDataId } from '@/app/components/YourDataId';
import type { Source } from '@/lib/pickSource';
import { ListeningServicePicker, type ListeningServicePickerProps } from './ListeningServicePicker';

const SERVICE_NAME: Record<Source, string> = { spotify: 'Spotify', youtube: 'YouTube' };

interface AvatarMenuProps {
  roomId: string;
  name: string;
  // Seed of the avatar colour (the same one the listener stage uses).
  seed: string;
  // The character this person is shown with, and the change handler.
  characterId: number;
  onCharacterChange: (id: number) => void;
  // The service this person listens through, track-independent.
  platform: Source | null;
  // That service has a connected account (Spotify).
  serviceConnected: boolean;
  // A guest, not signed in (accounts deployed): shows the Convidado chip.
  guest: boolean;
  // Accounts deployed: link to /account.
  accountsEnabled: boolean;
  picker: Omit<ListeningServicePickerProps, 'variant' | 'effective'> & { effective: Source | null };
  // Items about the room (report, host's public toggle).
  roomItems: ReactNode;
  // The Spotify connect player: mounted always, shown with "Trocar serviço".
  connectors: ReactNode;
}

export function AvatarMenu({ roomId, name, seed, characterId, onCharacterChange, platform, serviceConnected, guest, accountsEnabled, picker, roomItems, connectors }: AvatarMenuProps) {
  const [open, setOpen] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [services, setServices] = useState(false);
  const [chars, setChars] = useState(false);
  const [draft, setDraft] = useState(name);
  const wrapRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const initial = name.charAt(0).toUpperCase();

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      setOpen(false);
      triggerRef.current?.focus();
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  // Renaming rejoins: the room page auto-rejoins with the saved name, so save
  // it and reload (the same path a full-page Spotify connect takes).
  const rename = (e: React.FormEvent) => {
    e.preventDefault();
    const next = draft.trim();
    if (!next || next === name) {
      setRenaming(false);
      return;
    }
    saveGuestName(next);
    window.location.reload();
  };

  const leave = () => {
    try {
      sessionStorage.removeItem(NAME_KEY);
    } catch {
      // Storage blocked: the room's own form asks for the name again anyway.
    }
    // A full navigation closes the room connection, which the room does not do on unmount.
    window.location.assign(`${window.location.origin}/`);
  };

  return (
    <div className="r4-menu-wrap" ref={wrapRef}>
      <button
        ref={triggerRef}
        type="button"
        className="r4-me"
        aria-label={`Menu de ${name}`}
        aria-haspopup="true"
        aria-expanded={open}
        aria-controls={`r4-avatar-menu-${roomId}`}
        onClick={() => setOpen((o) => !o)}
        style={{ background: avatarGradient(seed) }}
      >
        <CharacterAvatar characterId={characterId} initial={initial} half />
        {platform && (
          <span className="r4-me__dot" aria-hidden="true">
            <ServiceBadge source={platform} size="sm" />
          </span>
        )}
      </button>

      <div id={`r4-avatar-menu-${roomId}`} className="r4-menu r4-menu--end r4-menu--user" hidden={!open}>
        <div className="r4-menu__head">
          <span className="r4-menu__av" style={{ background: avatarGradient(seed) }} aria-hidden="true">
            <CharacterAvatar characterId={characterId} initial={initial} />
            {platform && (
              <span className="r4-menu__avdot">
                <ServiceBadge source={platform} size="md" />
              </span>
            )}
          </span>
          <div className="r4-menu__who">
            <p className="r4-menu__name" data-testid="room-me">
              <span className="truncate">{name}</span>
              {guest && <span className="guest-chip">Convidado</span>}
            </p>
            {platform && <p className="r4-menu__sub">Ouvindo no {SERVICE_NAME[platform]}</p>}
            {platform && serviceConnected && (
              <span className="r4-menu__chip">
                <CheckIcon size={12} />
                conectado
              </span>
            )}
          </div>
        </div>

        <div className="r4-menu__sec">
          <button type="button" className="r4-menu__item" aria-expanded={renaming} onClick={() => { setRenaming((r) => !r); setDraft(name); }}>
            <PencilIcon size={18} />
            <span>Trocar nome</span>
          </button>
          {renaming && (
            <form className="r4-menu__rename" onSubmit={rename}>
              <input
                type="text"
                aria-label="Novo nome"
                value={draft}
                maxLength={30}
                onChange={(e) => setDraft(e.target.value)}
                className="r4-menu__input"
                autoFocus
              />
              <button type="submit" className="r4-menu__save" disabled={!draft.trim()}>
                Salvar
              </button>
            </form>
          )}

          <button type="button" className="r4-menu__item" aria-expanded={chars} onClick={() => setChars((v) => !v)}>
            <UserCircleIcon size={18} />
            <span>Trocar personagem</span>
            <span className="r4-menu__chev" aria-hidden="true">
              {chars ? <ChevronDownIcon size={18} /> : <ChevronRightIcon size={18} />}
            </span>
          </button>
          <div className="r4-menu__chars" hidden={!chars}>
            <CharacterPicker value={characterId} onChange={onCharacterChange} idPrefix="menu-char" as="h3" />
          </div>

          <button type="button" className="r4-menu__item" aria-expanded={services} onClick={() => setServices((v) => !v)}>
            <SwapIcon size={18} />
            <span>Trocar serviço</span>
            <span className="r4-menu__chev" aria-hidden="true">
              {services ? <ChevronDownIcon size={18} /> : <ChevronRightIcon size={18} />}
            </span>
          </button>
          {/* The connect players stay mounted with the panel closed or this list collapsed. */}
          <div className="r4-menu__services" hidden={!services}>
            <ListeningServicePicker {...picker} variant="list" />
            <div className="r4-menu__connect">{connectors}</div>
          </div>

          <YourDataId menu />
        </div>

        <div className="r4-menu__sec">
          {accountsEnabled && (
            <Link href="/account" className="r4-menu__item">
              <span>Minha conta</span>
            </Link>
          )}
          {roomItems}
          <p className="r4-menu__legal">
            <Link href="/privacidade">Privacidade</Link>
            {' · '}
            <Link href="/termos">Termos</Link>
          </p>
        </div>

        <div className="r4-menu__sec">
          <button type="button" className="r4-menu__item r4-menu__item--danger" onClick={leave}>
            <LogoutIcon size={18} />
            <span>Sair da sala</span>
          </button>
        </div>
      </div>
    </div>
  );
}

