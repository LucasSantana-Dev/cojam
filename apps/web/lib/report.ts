// Filing member reports (#259). Design: docs/specs/259-eca-minor-safety.md.
import { resolveConnectionToken } from './realtime';

// 'broadcast' (#310): a screen share. The server resolves who was sharing and
// ignores subjectId and content, so the client sends neither.
export type ReportKind = 'message' | 'member' | 'room' | 'broadcast';

// Closed set mirrored by report.NormalizeCategory on the server; anything else
// is stored as "other".
export type ReportCategory =
  | 'minor_at_risk'
  | 'sexual_content'
  | 'harassment'
  | 'spam'
  | 'other';

// The content is sent from the client because the server cannot fetch it:
// chat is ephemeral and the line may already be gone.
export async function fileReport(input: {
  roomId: string;
  kind: ReportKind;
  subjectId?: string;
  content?: string;
  reason?: string;
  category?: ReportCategory;
}): Promise<boolean> {
  // Identity is optional; a guest report still counts.
  const connToken = await resolveConnectionToken().catch(() => '');

  try {
    const res = await fetch('/api/report', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...input, connToken }),
    });
    return res.ok;
  } catch {
    return false;
  }
}
