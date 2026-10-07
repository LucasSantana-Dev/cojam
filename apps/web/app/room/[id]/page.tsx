import { redirect } from 'next/navigation';

import { RoomClient } from './client';

export default async function RoomPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  // Room ids are uppercase base36 (lib/roomId.ts) and the server rejects any
  // other form, so a lowercase link lands on its canonical uppercase URL.
  const canonical = id.toUpperCase();
  if (canonical !== id) {
    redirect(`/room/${encodeURIComponent(canonical)}`);
  }
  return <RoomClient roomId={id} />;
}
