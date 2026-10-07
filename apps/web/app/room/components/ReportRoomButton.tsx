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
        className="text-sm underline"
        style={{ color: 'var(--color-text-secondary)' }}
      >
        Denunciar sala
      </button>
      {report.dialog}
    </>
  );
}
