import { normToValue, snap, valueToNorm } from '../shared/curves'

type Range = readonly [number, number]

export interface KnobOptions {
  label: string
  value: number
  range: Range
  step: number
  unit: string
  /** Value a double-click returns to. */
  def: number
  log?: boolean
  onChange(v: number): void
}

export interface Knob { el: HTMLElement; set(v: number): void }

const SIZE = 46
const R = 18
const START = 225 // degrees clockwise from up: the dial sweeps 270° from the bottom-left to the bottom-right
const SWEEP = 270

const pt = (deg: number): [number, number] => {
  const a = ((deg - 90) * Math.PI) / 180
  return [SIZE / 2 + R * Math.cos(a), SIZE / 2 + R * Math.sin(a)]
}
const arc = (from: number, to: number): string => {
  const [x1, y1] = pt(from)
  const [x2, y2] = pt(to)
  return `M ${x1.toFixed(2)} ${y1.toFixed(2)} A ${R} ${R} 0 ${to - from > 180 ? 1 : 0} 1 ${x2.toFixed(2)} ${y2.toFixed(2)}`
}

export const formatValue = (v: number, step: number, unit: string): string => {
  const digits = Number.isInteger(step) ? 0 : step < 0.1 ? 2 : 1
  const big = unit === ' Hz' && v >= 1000 ? `${(v / 1000).toFixed(v >= 10000 ? 1 : 2)} k` : v.toFixed(digits)
  return `${big}${unit}`
}

/**
 * A rotary control: drag up/down (hold Shift for fine steps), mouse wheel, arrow keys, double-click to reset.
 * It draws an arc from the dial's start (or from the centre for ranges that cross zero) to the current value.
 */
export function knob(o: KnobOptions): Knob {
  const ns = 'http://www.w3.org/2000/svg'
  const svg = document.createElementNS(ns, 'svg')
  svg.setAttribute('viewBox', `0 0 ${SIZE} ${SIZE}`)
  svg.setAttribute('width', String(SIZE))
  svg.setAttribute('height', String(SIZE))
  const track = document.createElementNS(ns, 'path')
  track.setAttribute('class', 'ktrack')
  track.setAttribute('d', arc(START, START + SWEEP))
  const value = document.createElementNS(ns, 'path')
  value.setAttribute('class', 'kvalue')
  const needle = document.createElementNS(ns, 'line')
  needle.setAttribute('class', 'kneedle')
  svg.append(track, value, needle)

  const out = document.createElement('div')
  out.className = 'kval'
  const lab = document.createElement('div')
  lab.className = 'klbl'
  lab.textContent = o.label
  const el = document.createElement('div')
  el.className = 'knob'
  el.tabIndex = 0
  el.setAttribute('role', 'slider')
  el.setAttribute('aria-label', o.label)
  el.append(lab, svg, out)

  let current = o.value
  const crossesZero = o.range[0] < 0 && o.range[1] > 0 && !o.log
  const draw = () => {
    const norm = valueToNorm(current, o.range, o.log)
    const deg = START + SWEEP * norm
    const origin = crossesZero ? START + SWEEP * valueToNorm(0, o.range) : START
    const [a, b] = origin <= deg ? [origin, deg] : [deg, origin]
    value.setAttribute('d', b - a < 0.5 ? '' : arc(a, b))
    const [x, y] = pt(deg)
    needle.setAttribute('x1', String(SIZE / 2))
    needle.setAttribute('y1', String(SIZE / 2))
    needle.setAttribute('x2', x.toFixed(2))
    needle.setAttribute('y2', y.toFixed(2))
    out.textContent = formatValue(current, o.step, o.unit)
    el.setAttribute('aria-valuenow', String(current))
    el.setAttribute('aria-valuemin', String(o.range[0]))
    el.setAttribute('aria-valuemax', String(o.range[1]))
    el.setAttribute('aria-valuetext', out.textContent)
  }
  const clampSnap = (v: number): number => {
    const s = o.log ? v : snap(v, o.step)
    return Math.min(o.range[1], Math.max(o.range[0], Number(s.toFixed(4))))
  }
  const apply = (v: number) => {
    const next = clampSnap(v)
    if (next === current) return
    current = o.log ? Math.round(next) : next
    draw()
    o.onChange(current)
  }
  const byNorm = (delta: number) => apply(normToValue(valueToNorm(current, o.range, o.log) + delta, o.range, o.log))

  let dragY = 0
  let dragNorm = 0
  let dragging = false
  el.onpointerdown = (e) => {
    try { el.setPointerCapture(e.pointerId) } catch { /* a synthetic pointer cannot be captured; the drag still works */ }
    dragging = true
    dragY = e.clientY
    dragNorm = valueToNorm(current, o.range, o.log)
    el.classList.add('drag')
    e.preventDefault()
  }
  el.onpointermove = (e) => {
    if (!dragging) return
    const pixelsForFullTurn = e.shiftKey ? 800 : 160
    apply(normToValue(dragNorm + (dragY - e.clientY) / pixelsForFullTurn, o.range, o.log))
  }
  el.onpointerup = (e) => { dragging = false; try { el.releasePointerCapture(e.pointerId) } catch { /* not captured */ } el.classList.remove('drag') }
  el.ondblclick = () => apply(o.def)
  el.onwheel = (e) => { e.preventDefault(); byNorm((e.deltaY < 0 ? 1 : -1) * (e.shiftKey ? 0.005 : 0.025)) }
  el.onkeydown = (e) => {
    const dir = e.key === 'ArrowUp' || e.key === 'ArrowRight' ? 1 : e.key === 'ArrowDown' || e.key === 'ArrowLeft' ? -1 : 0
    if (!dir) return
    e.preventDefault()
    if (o.log) byNorm(dir * 0.01)
    else apply(current + dir * o.step * (e.shiftKey ? 10 : 1))
  }

  draw()
  return { el, set(v) { current = Math.min(o.range[1], Math.max(o.range[0], v)); draw() } }
}

