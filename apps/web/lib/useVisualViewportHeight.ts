// iOS Safari does not shrink the layout viewport when the keyboard opens (it
// ignores `interactive-widget=resizes-content`): `100dvh` stays full height and
// the composer ends up under the keys. The visual viewport does shrink, so
// publish its height as --app-h and let the phone chat rules size against it.
// Where the layout viewport already resizes (Chrome Android) both agree.
import { useEffect } from 'react';

export function useVisualViewportHeight() {
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    const root = document.documentElement;
    const write = () => root.style.setProperty('--app-h', `${Math.round(vv.height)}px`);
    write();
    vv.addEventListener('resize', write);
    return () => {
      vv.removeEventListener('resize', write);
      root.style.removeProperty('--app-h');
    };
  }, []);
}
