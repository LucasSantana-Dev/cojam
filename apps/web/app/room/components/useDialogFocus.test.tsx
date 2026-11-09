import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useDialogFocus } from './useDialogFocus';

function makeContainer(count = 3): HTMLDivElement {
  const div = document.createElement('div');
  for (let i = 0; i < count; i++) {
    const btn = document.createElement('button');
    btn.textContent = `btn-${i + 1}`;
    div.appendChild(btn);
  }
  document.body.appendChild(div);
  return div;
}

function btns(container: HTMLElement): HTMLButtonElement[] {
  return Array.from(container.querySelectorAll<HTMLButtonElement>('button'));
}

function press(key: string, shiftKey = false) {
  document.dispatchEvent(new KeyboardEvent('keydown', { key, shiftKey, bubbles: true }));
}

describe('useDialogFocus', () => {
  let container: HTMLDivElement;
  let containerRef: { current: HTMLDivElement };

  beforeEach(() => {
    container = makeContainer(3);
    containerRef = { current: container };
  });

  afterEach(() => {
    container.remove();
  });

  it('focuses the first focusable element when opened', () => {
    const { rerender } = renderHook(
      ({ open }) => useDialogFocus(open, vi.fn(), containerRef),
      { initialProps: { open: false } },
    );

    act(() => {
      rerender({ open: true });
    });

    expect(document.activeElement).toBe(btns(container)[0]);
  });

  it('does not move focus when the dialog is still closed', () => {
    const outerBtn = document.createElement('button');
    document.body.appendChild(outerBtn);
    outerBtn.focus();

    renderHook(
      ({ open }) => useDialogFocus(open, vi.fn(), containerRef),
      { initialProps: { open: false } },
    );

    expect(document.activeElement).toBe(outerBtn);
    outerBtn.remove();
  });

  describe('Tab trapping (trap: true, the default)', () => {
    it('wraps Tab forward from the last focusable element to the first', () => {
      const { rerender } = renderHook(
        ({ open }) => useDialogFocus(open, vi.fn(), containerRef),
        { initialProps: { open: false } },
      );
      act(() => {
        rerender({ open: true });
      });

      const [first, , last] = btns(container);
      last.focus();

      press('Tab');

      expect(document.activeElement).toBe(first);
    });

    it('wraps Shift+Tab backward from the first focusable element to the last', () => {
      const { rerender } = renderHook(
        ({ open }) => useDialogFocus(open, vi.fn(), containerRef),
        { initialProps: { open: false } },
      );
      act(() => {
        rerender({ open: true });
      });

      const [first, , last] = btns(container);
      expect(document.activeElement).toBe(first);

      press('Tab', true);

      expect(document.activeElement).toBe(last);
    });

    it('does not move focus when Tab is pressed on a middle element', () => {
      const { rerender } = renderHook(
        ({ open }) => useDialogFocus(open, vi.fn(), containerRef),
        { initialProps: { open: false } },
      );
      act(() => {
        rerender({ open: true });
      });

      const [, mid] = btns(container);
      mid.focus();

      press('Tab');

      expect(document.activeElement).toBe(mid);
    });
  });

  describe('Tab not trapped (trap: false)', () => {
    it('does not wrap Tab forward from the last element', () => {
      const { rerender } = renderHook(
        ({ open }) => useDialogFocus(open, vi.fn(), containerRef, { trap: false }),
        { initialProps: { open: false } },
      );
      act(() => {
        rerender({ open: true });
      });

      const [, , last] = btns(container);
      last.focus();

      press('Tab');

      expect(document.activeElement).toBe(last);
    });

    it('does not wrap Shift+Tab backward from the first element', () => {
      const { rerender } = renderHook(
        ({ open }) => useDialogFocus(open, vi.fn(), containerRef, { trap: false }),
        { initialProps: { open: false } },
      );
      act(() => {
        rerender({ open: true });
      });

      const [first] = btns(container);
      expect(document.activeElement).toBe(first);

      press('Tab', true);

      expect(document.activeElement).toBe(first);
    });
  });

  describe('Esc key', () => {
    it('calls onClose when Escape is pressed', () => {
      const onClose = vi.fn();
      const { rerender } = renderHook(
        ({ open }) => useDialogFocus(open, onClose, containerRef),
        { initialProps: { open: false } },
      );
      act(() => {
        rerender({ open: true });
      });

      press('Escape');

      expect(onClose).toHaveBeenCalledTimes(1);
    });

    it('calls the latest onClose when the callback identity changes between renders', () => {
      const onClose1 = vi.fn();
      const onClose2 = vi.fn();
      const { rerender } = renderHook(
        ({ open, onClose }) => useDialogFocus(open, onClose, containerRef),
        { initialProps: { open: true, onClose: onClose1 } },
      );

      act(() => {
        rerender({ open: true, onClose: onClose2 });
      });

      press('Escape');

      expect(onClose2).toHaveBeenCalledTimes(1);
      expect(onClose1).not.toHaveBeenCalled();
    });
  });

  describe('focus restore on close', () => {
    it('returns focus to the element that was active before the dialog opened', () => {
      const trigger = document.createElement('button');
      document.body.appendChild(trigger);
      trigger.focus();

      const { rerender } = renderHook(
        ({ open }) => useDialogFocus(open, vi.fn(), containerRef),
        { initialProps: { open: false } },
      );

      act(() => {
        rerender({ open: true });
      });
      expect(document.activeElement).toBe(btns(container)[0]);

      act(() => {
        rerender({ open: false });
      });
      expect(document.activeElement).toBe(trigger);

      trigger.remove();
    });
  });
});
