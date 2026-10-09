'use client';

import { useEffect } from 'react';

// Registers /sw.js after the page has loaded, in production only: in dev a
// worker would sit in front of HMR and hide changes. Rules live in public/sw.js.
export function registerServiceWorker(
  env: string | undefined = process.env.NODE_ENV,
  nav: Navigator | undefined = typeof navigator === 'undefined' ? undefined : navigator,
  win: Window | undefined = typeof window === 'undefined' ? undefined : window,
): void {
  if (env !== 'production' || !nav || !win || !('serviceWorker' in nav)) return;
  const register = () => {
    nav.serviceWorker.register('/sw.js', { scope: '/' }).catch(() => {
      // Installability is an enhancement; a failed registration changes nothing.
    });
  };
  if (win.document.readyState === 'complete') register();
  else win.addEventListener('load', register, { once: true });
}

export function ServiceWorkerRegister() {
  useEffect(() => {
    registerServiceWorker();
  }, []);
  return null;
}
