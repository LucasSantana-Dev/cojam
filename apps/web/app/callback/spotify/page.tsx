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
      // Don't render the raw OAuth error param (attacker-controllable via the
      // redirect); log details, show a generic message.
      console.error('spotify_auth_error', authErr, params.get('error_description'));
      setError('Authentication failed. Please try again.');
      return;
    }
    if (!code) {
      setError('Authentication failed. Please try again.');
      return;
    }
    handleCallback(code)
      .then((returnPath) => router.replace(returnPath))
      .catch((e) => {
        console.error('spotify_callback_error', e);
        setError('Authentication failed. Please try again.');
      });
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
