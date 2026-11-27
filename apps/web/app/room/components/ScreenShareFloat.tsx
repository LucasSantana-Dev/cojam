'use client';

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

// Floating windows for screen share (#310, spec 5.7, Go Live gaps 11 and 12).
// Document Picture in Picture (Chromium 116+) opens a small always-on-top
// window that can hold any markup, so the viewer keeps the video, its
// controls, the notice and the chat over other tabs, and the broadcaster
// keeps a mini control while showing another tab. Elsewhere it is absent and
// the panel keeps the plain video picture in picture.

type DocumentPip = {
  requestWindow(options?: { width?: number; height?: number }): Promise<Window>;
};

export function documentPip(): DocumentPip | null {
  if (typeof window === 'undefined') return null;
  return (window as unknown as { documentPictureInPicture?: DocumentPip }).documentPictureInPicture ?? null;
}

// The new window starts blank: copy the page's styles so the same classes
// render the same way.
export function copyStyles(from: Document, to: Document): void {
  for (const node of Array.from(from.querySelectorAll('link[rel="stylesheet"], style'))) {
    to.head.appendChild(node.cloneNode(true));
  }
  to.documentElement.className = from.documentElement.className;
  const theme = from.documentElement.getAttribute('data-theme');
  if (theme) to.documentElement.setAttribute('data-theme', theme);
}

export function useFloatWindow() {
  const [win, setWin] = useState<Window | null>(null);
  const winRef = useRef<Window | null>(null);

  const close = useCallback(() => {
    winRef.current?.close();
    winRef.current = null;
    setWin(null);
  }, []);

  // Must run inside the click: the browser only opens it on a user gesture.
  const open = useCallback(async (size: { width: number; height: number }, title: string): Promise<boolean> => {
    const pip = documentPip();
    if (!pip) return false;
    try {
      const w = await pip.requestWindow(size);
      copyStyles(document, w.document);
      w.document.title = title;
      w.document.body.classList.add('screen-share-float-body');
      // Closing the window by its own button ends the float.
      w.addEventListener('pagehide', () => {
        if (winRef.current === w) {
          winRef.current = null;
          setWin(null);
        }
      });
      winRef.current = w;
      setWin(w);
      return true;
    } catch {
      return false;
    }
  }, []);

  // Leaving the room closes it.
  useEffect(() => () => winRef.current?.close(), []);

  return { win, open, close, supported: documentPip() !== null };
}

export function FloatPortal({ win, children }: { win: Window; children: ReactNode }) {
  return createPortal(<div className="screen-share-float">{children}</div>, win.document.body);
}
