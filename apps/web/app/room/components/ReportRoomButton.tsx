'use client';

import { useReportDialog } from '@/app/components/useReportDialog';

// Report this room (#259). Visible to everyone in the room, guests included.
// Two presentations of the same action: an icon-only button beside the title
// on phones (the sticky header must stay one short band, and the .room-header
// rule in globals.css gives it a 44px target), and a text button in the
// controls row from md up. Each owns its dialog; only one is ever displayed.
export function ReportRoomButton({
  roomId,
  variant,
}: {
  roomId: string;
  variant: 'icon' | 'text';
}) {
  const report = useReportDialog();
  const icon = variant === 'icon';
  return (
    <>
      <button
        type="button"
        onClick={() => report.open({ roomId, kind: 'room' })}
        aria-label="Denunciar sala"
        title="Denunciar sala"
        className={
          icon
            ? 'report-room-btn md:hidden inline-flex items-center justify-center text-sm'
            : 'report-room-btn hidden md:inline-flex items-center text-sm underline'
        }
        style={{ color: 'var(--color-text-secondary)' }}
      >
        {icon ? <span aria-hidden>⚑</span> : 'Denunciar sala'}
      </button>
      {report.dialog}
    </>
  );
}
