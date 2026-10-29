/** Dev builds only: a 1x / 2x / 5x / 10x game speed control. Returns a setter that keeps the buttons in sync. */
export function mountDevSpeed(parent: HTMLElement, onChange: (v: number) => void): (v: number) => void {
  const box = document.createElement('div');
  box.id = 'dev-speed';
  box.innerHTML = '<span>Dev speed</span>' + [1, 2, 5, 10].map((v) => `<button data-v="${v}" class="${v === 1 ? 'on' : ''}">${v}×</button>`).join('');
  const set = (v: number) => {
    for (const b of box.querySelectorAll<HTMLButtonElement>('button')) b.classList.toggle('on', Number(b.dataset.v) === v);
    onChange(v);
  };
  box.addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest('button');
    if (b) set(Number(b.dataset.v));
  });
  parent.appendChild(box);
  return set;
}
