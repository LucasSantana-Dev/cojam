import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

// RTL only auto-cleans when test globals are on; this suite imports explicitly.
afterEach(() => cleanup());

// jsdom does not implement HTMLDialogElement.showModal/close. Minimal shims so
// components using the native modal are testable; they mirror the parts the
// tests observe (the `open` attribute and the cancel/close events), not the
// focus containment the real element provides.
if (typeof HTMLDialogElement !== 'undefined' && !HTMLDialogElement.prototype.showModal) {
  HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement) {
    this.open = true;
  };
  HTMLDialogElement.prototype.close = function close(this: HTMLDialogElement) {
    this.open = false;
    this.dispatchEvent(new Event('close'));
  };
}
