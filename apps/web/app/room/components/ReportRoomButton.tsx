'use client';

import { useReportDialog } from '@/app/components/useReportDialog';
import { FlagIcon } from '@/app/components/icons';

// Report this room (#259). Visible to everyone in the room, guests included.
// Lives in the avatar menu as one of its items; it owns its dialog.
export function ReportRoomButton({ roomId }: { roomId: string }) {
  const report = useReportDialog();
  return (
    <>
      <button
        type="button"
        onClick={() => report.open({ roomId, kind: 'room' })}
        aria-label="Denunciar sala"
        title="Denunciar sala"
        className="report-room-btn r4-menu__item"
      >
        <FlagIcon size={18} />
        <span>Denunciar sala</span>
      </button>
      {report.dialog}
    </>
  );
}
