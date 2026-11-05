/** Small stroke icon set (24×24 viewBox, currentColor) so buttons can be icon-only with a tooltip. */
const PATHS = {
  music: '<path d="M9 18V5l11-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="17" cy="16" r="3"/>',
  image: '<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="10" r="1.8"/><path d="M21 16l-5-5-8 8"/>',
  presentation: '<rect x="3" y="4" width="18" height="12" rx="1.5"/><path d="M12 16v4M8 20h8"/>',
  film: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M7 4v16M17 4v16M3 9h4M3 15h4M17 9h4M17 15h4"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  trash: '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>',
  up: '<path d="M12 19V5M5 12l7-7 7 7"/>',
  down: '<path d="M12 5v14M5 12l7 7 7-7"/>',
  camera: '<path d="M3 8a2 2 0 0 1 2-2h2l1.5-2h7L17 6h2a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><circle cx="12" cy="13" r="3.5"/>',
  chevronUp: '<path d="M6 15l6-6 6 6"/>',
  chevronDown: '<path d="M6 9l6 6 6-6"/>',
  x: '<path d="M6 6l12 12M18 6L6 18"/>',
  play: '<path d="M7 4l13 8-13 8z" fill="currentColor"/>',
  pause: '<path d="M8 5v14M16 5v14" stroke-width="3"/>',
  stop: '<rect x="6" y="6" width="12" height="12" rx="1" fill="currentColor"/>',
  pencil: '<path d="M4 20l1-5L16 4l4 4L9 19z"/><path d="M14 6l4 4"/>',
  save: '<path d="M5 4h12l3 3v13H5z"/><path d="M8 4v6h8V4M8 20v-6h8v6"/>',
  undo: '<path d="M9 14L4 9l5-5"/><path d="M4 9h10a6 6 0 010 12h-3"/>',
  present: '<rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 21l4-5 4 5"/>',
  songs: '<path d="M4 6h16M4 12h16M4 18h10"/>',
  sliders: '<path d="M5 4v6M5 14v6M12 4v2M12 10v10M19 4v10M19 18v2"/><path d="M3 10h4M10 6h4M17 14h4"/>',
  search: '<circle cx="11" cy="11" r="6"/><path d="M20 20l-4.5-4.5"/>',
  copy: '<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V6a2 2 0 012-2h9"/>',
  book: '<path d="M4 5a2 2 0 012-2h13v16H6a2 2 0 00-2 2V5z"/><path d="M4 19a2 2 0 012-2h13M9 8h6"/>',
  bell: '<path d="M6 16v-5a6 6 0 0112 0v5l2 2H4z"/><path d="M10 21a2 2 0 004 0"/>',
  gear: '<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M4.9 19.1L7 17M17 7l2.1-2.1"/>',
  screen: '<rect x="3" y="5" width="18" height="12" rx="2"/><path d="M9 21h6M12 17v4"/>',
} as const

export type IconName = keyof typeof PATHS

/** Optional "+" badge in the corner turns an icon into an "add …" icon. */
export function iconSvg(name: IconName, size = 16, badge = false): string {
  const plus = badge ? '<circle cx="18" cy="18" r="5.5" fill="var(--panel, #171a22)" stroke="none"/><path d="M18 15v6M15 18h6" stroke-width="2.2"/>' : ''
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${PATHS[name]}${plus}</svg>`
}

export interface IconButtonOptions {
  badge?: boolean
  size?: number
  label?: string
  className?: string
  disabled?: boolean
}

/** Icon button with tooltip (and accessible label); `label` adds visible text next to the icon. */
export function iconButton(name: IconName, title: string, onclick: (e: MouseEvent) => void, opts: IconButtonOptions = {}): HTMLButtonElement {
  const b = document.createElement('button')
  b.type = 'button'
  b.title = title
  b.setAttribute('aria-label', title)
  b.className = `ib ${opts.className ?? ''}`.trim()
  b.disabled = opts.disabled ?? false
  b.innerHTML = iconSvg(name, opts.size ?? 16, opts.badge)
  if (opts.label) b.append(Object.assign(document.createElement('span'), { textContent: opts.label }))
  b.onclick = onclick
  return b
}
