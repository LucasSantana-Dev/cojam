'use client';

import { useReportDialog } from '@/app/components/useReportDialog';

// Report this room (#259). Visible to everyone in the room, guests included.
export function ReportRoomButton({ roomId }: { roomId: string }) {
  const report = useReportDialog();
  return (
    <>
      <button
        type="button"
        onClick={() => report.open({ roomId, kind: 'room' })}
        aria-label="Denunciar sala"
        title="Denunciar sala"
        className="report-room-btn inline-flex items-center justify-center text-sm md:underline"
        style={{ color: 'var(--color-text-secondary)' }}
      >
        {/* Phone: icon only, so the sticky header stays one short band. The
            44px target comes from the .room-header rule in globals.css. */}
        <span aria-hidden className="md:hidden">⚑</span>
        <span className="hidden md:inline">Denunciar sala</span>
      </button>
      {report.dialog}
    </>
  );
}
