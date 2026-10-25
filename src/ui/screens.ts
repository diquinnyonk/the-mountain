export type ScreenId = 'title' | 'help' | 'plan' | 'loading' | 'pause' | 'camp' | 'dialog' | 'end';

export const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

/** Show one overlay screen (or none). */
export function showScreen(id: ScreenId | null) {
  for (const el of document.querySelectorAll<HTMLElement>('.screen')) el.hidden = el.id !== `screen-${id}`;
}

export function setLoading(title: string, text = '') {
  $('loading-title').textContent = title;
  $('loading-text').textContent = text;
  showScreen('loading');
}

/** Wire a segmented control; returns a getter for its value. */
export function segmented(id: string, onChange?: (v: string) => void): () => string {
  const el = $(id);
  el.addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest('button');
    if (!b) return;
    for (const x of el.querySelectorAll('button')) x.classList.toggle('on', x === b);
    onChange?.(b.dataset.v!);
  });
  return () => el.querySelector<HTMLButtonElement>('button.on')!.dataset.v!;
}

export const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
