/**
 * A drag handle between two columns of a grid. Dragging sets a CSS variable (the width of the panel it resizes) on the grid's
 * element; the width is remembered per handle, double-click goes back to the usual width, and the arrow keys nudge it.
 */
export interface SplitterOptions {
  /** The element that owns the grid and the variable. */
  host: HTMLElement
  /** CSS variable holding the panel's width, e.g. `--pl`. */
  variable: string
  /** Which panel the handle resizes: the one to its left or to its right. */
  side: 'left' | 'right'
  min: number
  max: number
  initial: number
  /** localStorage key that remembers the width. */
  key: string
  /** The panel being resized (its width is read when a drag starts). */
  panel: () => HTMLElement
}

export function makeSplitter(handle: HTMLElement, o: SplitterOptions): void {
  handle.classList.add('splitter')
  handle.setAttribute('role', 'separator')
  handle.setAttribute('aria-orientation', 'vertical')
  handle.tabIndex = 0
  handle.title = 'Drag to resize, double-click to reset'

  // Never let a panel take more than half of the view, whatever the saved width says.
  const limit = (w: number) => Math.round(Math.max(o.min, Math.min(o.max, o.host.clientWidth ? o.host.clientWidth * 0.5 : o.max, w)))
  const set = (w: number) => o.host.style.setProperty(o.variable, `${limit(w)}px`)
  const remember = () => { try { localStorage.setItem(o.key, String(parseInt(o.host.style.getPropertyValue(o.variable), 10))) } catch { /* only a convenience */ } }

  let saved = NaN
  try { saved = Number(localStorage.getItem(o.key)) } catch { /* no storage */ }
  set(Number.isFinite(saved) && saved > 0 ? saved : o.initial)

  handle.onpointerdown = (e) => {
    e.preventDefault()
    const startX = e.clientX
    const startW = o.panel().getBoundingClientRect().width
    handle.setPointerCapture(e.pointerId)
    handle.classList.add('dragging')
    document.body.style.userSelect = 'none'
    handle.onpointermove = (m) => set(startW + (o.side === 'left' ? m.clientX - startX : startX - m.clientX))
    handle.onpointerup = handle.onpointercancel = () => {
      handle.onpointermove = handle.onpointerup = handle.onpointercancel = null
      handle.classList.remove('dragging')
      document.body.style.userSelect = ''
      remember()
    }
  }
  handle.ondblclick = () => { set(o.initial); remember() }
  handle.onkeydown = (e) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return
    e.preventDefault()
    const dir = (e.key === 'ArrowRight' ? 1 : -1) * (o.side === 'left' ? 1 : -1)
    set(o.panel().getBoundingClientRect().width + dir * (e.shiftKey ? 64 : 16))
    remember()
  }
}
