import type { Metadata } from 'next';
import { RoomsDirectory } from './RoomsDirectory';

export const metadata: Metadata = {
  title: 'Salas ao vivo',
  description: 'Salas abertas do CoJam tocando agora. Escolha uma e ouça junto.',
  alternates: { canonical: '/rooms' },
};

// Server shell so the route can export metadata; the directory itself is live
// client state (see RoomsDirectory).
export default function RoomsPage() {
  return <RoomsDirectory />;
}
