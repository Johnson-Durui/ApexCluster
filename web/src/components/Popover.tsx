// Popover (BUILD-SPEC-B §3.6): a button-anchored, non-modal glass panel. It replaces every <details> popover.
// The button carries aria-haspopup=dialog + aria-expanded; the panel is role=dialog with an aria-label.
// Esc or an outside pointer press closes it; Esc returns focus to the button (and does not reach page handlers).
import { useEffect, useId, useRef, useState, type ReactNode } from 'react';

export interface PopoverProps {
  /** Accessible name of the panel (role=dialog). */
  label: string;
  /** Content of the trigger button. */
  button: ReactNode;
  placement?: 'up' | 'down';
  /** Horizontal alignment of the panel against the button. */
  align?: 'start' | 'end';
  children: ReactNode | ((close: () => void) => ReactNode);
  /** Accessible name for the trigger when its content is not enough (e.g. an icon). */
  buttonLabel?: string;
  buttonClassName?: string;
  buttonTitle?: string;
  className?: string;
  panelClassName?: string;
  disabled?: boolean;
  onOpenChange?(open: boolean): void;
}

const FOCUSABLE = 'a[href],button:not([disabled]),input:not([disabled]):not([type=hidden]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';

export default function Popover({ label, button, placement = 'down', align = 'start', children, buttonLabel, buttonClassName = 'btn ghost', buttonTitle, className = '', panelClassName = '', disabled = false, onOpenChange }: PopoverProps) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLSpanElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const id = useId();
  const change = (next: boolean) => { setOpen(next); onOpenChange?.(next); };
  const close = (returnFocus = true) => {
    change(false);
    if (returnFocus) trigger.current?.focus({ preventScroll: true });
  };

  useEffect(() => {
    if (!open) return;
    const first = panel.current?.querySelector<HTMLElement>(FOCUSABLE);
    (first ?? panel.current)?.focus({ preventScroll: true });
    const onPointer = (event: Event) => {
      if (root.current?.contains(event.target as Node)) return;
      const focusInside = root.current?.contains(document.activeElement);
      change(false);
      // Return focus only when it would otherwise be lost; a press on another control keeps that control focused.
      if (focusInside) window.setTimeout(() => { if (document.activeElement === document.body) trigger.current?.focus({ preventScroll: true }); }, 0);
    };
    document.addEventListener('pointerdown', onPointer, true);
    return () => document.removeEventListener('pointerdown', onPointer, true);
  }, [open]);

  return <span ref={root} className={`popover ${className}`.trim()} onKeyDown={event => {
    if (!open || event.key !== 'Escape' || event.nativeEvent.isComposing) return;
    event.preventDefault();
    event.stopPropagation();
    close(true);
  }}>
    <button ref={trigger} type="button" className={buttonClassName} aria-haspopup="dialog" aria-expanded={open} aria-controls={open ? id : undefined}
      aria-label={buttonLabel} title={buttonTitle} disabled={disabled} onClick={() => change(!open)}>{button}</button>
    {open ? <div ref={panel} id={id} role="dialog" aria-label={label} tabIndex={-1} data-placement={placement} data-align={align}
      className={`popover-panel glass ${panelClassName}`.trim()}>
      {typeof children === 'function' ? children(() => close(true)) : children}
    </div> : null}
  </span>;
}
