// Dialog plumbing: focus trap, inert background, Escape to close and a
// confirm dialog. Undo is preferred; confirm only where undo is impossible.
import { h, button } from './ui.js';

const FOCUSABLE = 'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

// Keeps Tab inside `container`, marks everything else inert and puts focus
// back where it was on release. Returns the release function.
export function trapFocus(container, onEscape) {
  const before = document.activeElement;
  const others = [...document.body.children].filter((el) => el !== container && !el.contains(container) && !el.inert);
  for (const el of others) el.inert = true;

  const items = () => [...container.querySelectorAll(FOCUSABLE)].filter((el) => el.offsetParent !== null);
  const onKey = (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      onEscape?.();
    } else if (e.key === 'Tab') {
      const list = items();
      if (!list.length) return;
      const first = list[0];
      const last = list[list.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }
  };
  container.addEventListener('keydown', onKey);
  // Prefer the primary button; else the first control.
  requestAnimationFrame(() => (container.querySelector('.btn-primary') || items()[0])?.focus());

  return () => {
    container.removeEventListener('keydown', onKey);
    for (const el of others) el.inert = false;
    if (before?.isConnected) before.focus();
  };
}

/**
 * A modal confirm. Resolves true when confirmed.
 * @param {{ title: string, body?: string | Node, confirm: string, cancel?: string, danger?: boolean }} opts
 */
export function confirmDialog({ title, body, confirm, cancel = 'Cancel', danger = false }) {
  return new Promise((resolve) => {
    const done = (ok) => {
      release();
      overlay.remove();
      resolve(ok);
    };
    const confirmBtn = button(confirm, { variant: danger ? 'danger' : 'primary', onclick: () => done(true) });
    const cancelBtn = button(cancel, { variant: danger ? 'primary' : 'secondary', onclick: () => done(false) });
    const overlay = h('div', { class: 'modal-backdrop' },
      h('div', { class: 'modal', role: 'alertdialog', 'aria-modal': 'true', 'aria-labelledby': 'confirm-title' },
        h('div', { class: 'modal-head' }, h('div', { class: 'modal-title', id: 'confirm-title' }, title)),
        body ? h('div', { class: 'modal-body' }, typeof body === 'string' ? h('p', null, body) : body) : null,
        // A destructive confirm keeps the safe choice as the primary, focused button.
        h('div', { class: 'modal-actions' }, danger ? [confirmBtn, cancelBtn] : [cancelBtn, confirmBtn])));
    document.body.append(overlay);
    const release = trapFocus(overlay, () => done(false));
  });
}
