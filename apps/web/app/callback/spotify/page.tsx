'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { handleCallback } from '@/lib/spotifyAuth';

export default function SpotifyCallback() {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const code = params.get('code');
    const authErr = params.get('error');
    if (authErr) {
      setError(authErr);
      return;
    }
    if (!code) {
      setError('no authorization code returned');
      return;
    }
    handleCallback(code)
      .then((returnPath) => router.replace(returnPath))
      .catch((e) => setError(e.message));
  }, [router]);

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-950 text-sm">
      {error ? (
        <div className="text-red-400">Spotify auth failed: {error}</div>
      ) : (
        <div className="text-gray-400">Connecting Spotify…</div>
      )}
    </div>
  );
}
