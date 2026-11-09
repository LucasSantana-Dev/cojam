import { useState, useEffect, useRef } from 'react';

// useCopyText returns { copied, copy } for clipboard interactions. The
// "copied" flash lasts `timeoutMs` ms (default 1600) and is cleared on
// unmount so a navigation before the timer fires cannot trigger a state
// update on an unmounted component.
//
// copy() tries the Clipboard API first. If that fails (insecure context or
// denied permission) it falls back to a hidden-textarea execCommand so the
// action works in development (http://localhost) and older browsers.
export function useCopyText(timeoutMs = 1600): {
  copied: boolean;
  copy: (text: string) => Promise<void>;
} {
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (timerRef.current !== null) clearTimeout(timerRef.current);
    };
  }, []);

  const copy = async (text: string) => {
    let ok = false;
    try {
      await navigator.clipboard.writeText(text);
      ok = true;
    } catch {
      try {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        ok = document.execCommand('copy');
        document.body.removeChild(ta);
      } catch {
        ok = false;
      }
    }
    if (ok) {
      if (timerRef.current !== null) clearTimeout(timerRef.current);
      setCopied(true);
      timerRef.current = setTimeout(() => setCopied(false), timeoutMs);
    }
  };

  return { copied, copy };
}
