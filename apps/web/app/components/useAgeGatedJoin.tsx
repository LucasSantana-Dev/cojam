'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { MINIMUM_AGE, hasAffirmedAge, affirmAge } from '@/lib/ageGate';

export type AgeGateCopy = {
  title: string;
  body: string;
  confirm: string;
  cancel: string;
};

export const AGE_GATE_COPY_EN: AgeGateCopy = {
  title: 'Before you join',
  body: `Public rooms are open to people you have not met. You need to be ${MINIMUM_AGE} or over to join one.`,
  confirm: `I am ${MINIMUM_AGE} or over`,
  cancel: 'Cancel',
};

export const AGE_GATE_COPY_PT: AgeGateCopy = {
  title: 'Antes de entrar',
  body: `Salas públicas são abertas a pessoas que você não conhece. Você precisa ter ${MINIMUM_AGE} anos ou mais para entrar em uma.`,
  confirm: `Tenho ${MINIMUM_AGE} anos ou mais`,
  cancel: 'Cancelar',
};

// Directory joins are gated (#259); invite-link joins are untouched. Shared by
// the landing strip and the /rooms page so both ask the same question once.
// `onCardClick` goes on the card link; `gate` is the modal to render once.
export function useAgeGatedJoin(copy: AgeGateCopy = AGE_GATE_COPY_EN) {
  const router = useRouter();
  // Set to the room a visitor is trying to reach while the gate is open.
  const [pendingRoomId, setPendingRoomId] = useState<string | null>(null);
  const dialogRef = useRef<HTMLDialogElement>(null);

  // showModal() is what makes it actually modal: it moves focus in, contains
  // Tab, makes the background inert and wires Escape. Hand-rolling a focus
  // trap to match would be strictly worse.
  useEffect(() => {
    const el = dialogRef.current;
    if (!el) return;
    if (pendingRoomId && !el.open) el.showModal();
    if (!pendingRoomId && el.open) el.close();
  }, [pendingRoomId]);

  const onCardClick = (event: React.MouseEvent, roomId: string) => {
    if (hasAffirmedAge()) return; // let the Link navigate normally
    event.preventDefault();
    setPendingRoomId(roomId);
  };

  const confirmAge = () => {
    affirmAge();
    const roomId = pendingRoomId;
    setPendingRoomId(null);
    if (roomId) router.push(`/room/${roomId}`);
  };

  // Rendered unconditionally so the ref exists before showModal(). The native
  // element handles focus placement, containment and restoration to the card;
  // onCancel covers Escape and the backdrop.
  const gate = (
    <dialog
      ref={dialogRef}
      className="age-gate"
      aria-labelledby="age-gate-title"
      onCancel={(e) => {
        e.preventDefault();
        setPendingRoomId(null);
      }}
      onClose={() => setPendingRoomId(null)}
    >
      <div className="age-gate__panel">
        <h2 id="age-gate-title" className="age-gate__title">{copy.title}</h2>
        <p className="age-gate__body">{copy.body}</p>
        <div className="age-gate__actions">
          <button type="button" className="btn-primary" onClick={confirmAge}>
            {copy.confirm}
          </button>
          <button type="button" className="btn-ghost" onClick={() => setPendingRoomId(null)}>
            {copy.cancel}
          </button>
        </div>
      </div>
    </dialog>
  );

  return { onCardClick, gate };
}
