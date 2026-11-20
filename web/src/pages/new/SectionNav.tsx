// Section index with scroll-spy (BUILD-SPEC-B §6.3, §6.4). Buttons, never `href="#…"` anchors: an anchor would change
// the hash route. A click scrolls the section into view and focuses its heading; an IntersectionObserver marks the
// section at the top of its scroll container. Sections that mount later (the settings panel) are picked up when they appear.
import { Fragment, useEffect, useState } from 'react';
import { STATUS_GLYPH, type StatusKind } from '../../components/ui';
import { reducedMotion } from '../../components/motion';
import './section-nav.css';

export interface NavItem { id: string; label: string; index?: string; group?: string; status?: StatusKind | null; statusWord?: string }

const STATUS_WORDS: Partial<Record<StatusKind, string>> = { ok: '已完成', err: '需要处理', idle: '未完成', child: '需注意', block: '有问题', run: '进行中' };

function scrollParent(element: HTMLElement): HTMLElement | null {
  for (let node = element.parentElement; node; node = node.parentElement) {
    const overflow = getComputedStyle(node).overflowY;
    if (overflow === 'auto' || overflow === 'scroll') return node;
  }
  return null;
}

/** The id of the first section whose box reaches the top third of its scroll container. */
export function useScrollSpy(ids: string[]): string | null {
  const [active, setActive] = useState<string | null>(ids[0] ?? null);
  const key = ids.join('|');
  useEffect(() => {
    if (typeof IntersectionObserver === 'undefined' || typeof document === 'undefined') return;
    const visible = new Map<string, boolean>();
    const observed = new Set<string>();
    let observer: IntersectionObserver | null = null;
    const pick = () => { const first = ids.find(id => visible.get(id)); if (first) setActive(first); };
    const attach = () => {
      for (const id of ids) {
        if (observed.has(id)) continue;
        const element = document.getElementById(id);
        if (!element) continue;
        observer ??= new IntersectionObserver(entries => { for (const entry of entries) visible.set(entry.target.id, entry.isIntersecting); pick(); }, { root: scrollParent(element), rootMargin: '0px 0px -66% 0px', threshold: 0 });
        observer.observe(element);
        observed.add(id);
      }
    };
    attach();
    // Late sections (settings load after the page) are observed once they exist; nothing polls.
    const mutations = new MutationObserver(() => { if (observed.size < ids.length) attach(); else mutations.disconnect(); });
    if (observed.size < ids.length) mutations.observe(document.body, { childList: true, subtree: true });
    return () => { observer?.disconnect(); mutations.disconnect(); };
  }, [key]);
  return active;
}

/** Scrolls a section to the top of its container and focuses its first heading (made focusable on demand). */
export function jumpToSection(id: string) {
  const section = document.getElementById(id);
  if (!section) return;
  section.scrollIntoView({ block: 'start', behavior: reducedMotion() ? 'auto' : 'smooth' });
  const heading = section.matches('h2,h3') ? section : section.querySelector<HTMLElement>('h2, h3, summary');
  const target = heading ?? section;
  if (!target.hasAttribute('tabindex') && target.tagName !== 'SUMMARY') target.tabIndex = -1;
  target.focus({ preventScroll: true });
}

export function SectionNav({ items, label, className = '' }: { items: NavItem[]; label: string; className?: string }) {
  const active = useScrollSpy(items.map(item => item.id));
  return <nav className={`section-nav ${className}`.trim()} aria-label={label}>
    {items.map(item => <Fragment key={item.id}>
      {item.group ? <h2 className="section-nav-group">{item.group}</h2> : null}
      <button type="button" className="btn-reset section-nav-item" aria-current={active === item.id ? 'location' : undefined} onClick={() => jumpToSection(item.id)}>
        {item.index ? <span className="section-nav-index mono">{item.index}</span> : null}
        <span className="section-nav-label">{item.label}</span>
        {item.status ? <span className={`st ${item.status} section-nav-st`}><i aria-hidden="true">{STATUS_GLYPH[item.status]}</i><span className="sr-only">，{item.statusWord ?? STATUS_WORDS[item.status] ?? ''}</span></span> : null}
      </button>
    </Fragment>)}
  </nav>;
}
