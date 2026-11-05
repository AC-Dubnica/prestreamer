import { compOutDb, eqResponseDb, gateOutDb, normToValue, snap, valueToNorm } from '../shared/curves'
import { RANGES, clamp, type CompConfig, type EqConfig, type GateConfig } from '../shared/mixer'

const W = 300
const H = 120
const F_RANGE = [20, 20000] as const
const DB = 18

const css = (name: string, fallback: string): string => getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback

function canvas(): { c: HTMLCanvasElement; g: CanvasRenderingContext2D } {
  const c = document.createElement('canvas')
  const dpr = window.devicePixelRatio || 1
  c.width = W * dpr
  c.height = H * dpr
  c.style.width = '100%'
  c.style.aspectRatio = `${W} / ${H}`
  c.className = 'mxgraph'
  const g = c.getContext('2d')!
  g.scale(dpr, dpr)
  return { c, g }
}

function grid(g: CanvasRenderingContext2D, vLines: number[], hLines: number[]): void {
  g.strokeStyle = css('--line', '#333')
  g.lineWidth = 1
  g.beginPath()
  for (const x of vLines) { g.moveTo(Math.round(x) + 0.5, 0); g.lineTo(Math.round(x) + 0.5, H) }
  for (const y of hLines) { g.moveTo(0, Math.round(y) + 0.5); g.lineTo(W, Math.round(y) + 0.5) }
  g.stroke()
}

export interface EqGraph { el: HTMLElement; redraw(): void }

/**
 * Frequency-response plot of the 3-band EQ. Each band has a handle: drag sideways for frequency, up/down for gain,
 * scroll over the mid handle for its Q. `onEdit` is told which fields changed so the knobs can follow.
 */
export function eqGraph(eq: EqConfig, onEdit: () => void): EqGraph {
  const { c, g } = canvas()
  const xOf = (f: number) => valueToNorm(f, F_RANGE, true) * W
  const yOf = (db: number) => H / 2 - (db / DB) * (H / 2)
  const bands = [
    { name: 'low', freq: 'lowFreq', gain: 'lowGainDb' },
    { name: 'mid', freq: 'midFreq', gain: 'midGainDb' },
    { name: 'high', freq: 'highFreq', gain: 'highGainDb' },
  ] as const

  const redraw = () => {
    g.clearRect(0, 0, W, H)
    grid(g, [100, 1000, 10000].map(xOf), [yOf(-12), yOf(-6), yOf(0), yOf(6), yOf(12)])
    g.strokeStyle = css('--accent', '#4da3ff')
    g.lineWidth = 2
    g.globalAlpha = eq.on ? 1 : 0.35
    g.beginPath()
    for (let x = 0; x <= W; x += 2) {
      const f = normToValue(x / W, F_RANGE, true)
      const y = yOf(Math.max(-DB, Math.min(DB, eqResponseDb({ ...eq, on: true }, f))))
      x === 0 ? g.moveTo(x, y) : g.lineTo(x, y)
    }
    g.stroke()
    for (const b of bands) {
      g.fillStyle = css('--accent', '#4da3ff')
      g.beginPath()
      g.arc(xOf(eq[b.freq]), yOf(eq[b.gain]), 5, 0, Math.PI * 2)
      g.fill()
    }
    g.globalAlpha = 1
  }

  let drag: (typeof bands)[number] | null = null
  const pos = (e: PointerEvent | WheelEvent) => { const r = c.getBoundingClientRect(); return { x: ((e.clientX - r.left) / r.width) * W, y: ((e.clientY - r.top) / r.height) * H } }
  const nearest = (x: number, y: number) => {
    let best: (typeof bands)[number] | null = null
    let bestD = 14
    for (const b of bands) {
      const d = Math.hypot(xOf(eq[b.freq]) - x, yOf(eq[b.gain]) - y)
      if (d < bestD) { best = b; bestD = d }
    }
    return best
  }
  c.onpointerdown = (e) => {
    const p = pos(e)
    drag = nearest(p.x, p.y)
    if (!drag) return
    try { c.setPointerCapture(e.pointerId) } catch { /* synthetic pointer */ }
    c.style.cursor = 'grabbing'
  }
  c.onpointermove = (e) => {
    const p = pos(e)
    if (!drag) { c.style.cursor = nearest(p.x, p.y) ? 'grab' : 'default'; return }
    const b = drag
    eq[b.freq] = Math.round(clamp(normToValue(p.x / W, F_RANGE, true), RANGES.eqFreq))
    eq[b.gain] = clamp(snap(((H / 2 - p.y) / (H / 2)) * DB, 0.5), RANGES.eqGainDb)
    redraw()
    onEdit()
  }
  c.onpointerup = (e) => { drag = null; c.style.cursor = 'default'; try { c.releasePointerCapture(e.pointerId) } catch { /* not captured */ } }
  c.onwheel = (e) => {
    const p = pos(e)
    if (nearest(p.x, p.y)?.name !== 'mid') return
    e.preventDefault()
    eq.midQ = clamp(Number((eq.midQ * (e.deltaY < 0 ? 1.1 : 1 / 1.1)).toFixed(2)), RANGES.eqQ)
    redraw()
    onEdit()
  }
  c.title = 'Drag a dot to change its frequency and gain. Scroll over the middle dot to change its width (Q).'
  redraw()
  return { el: c, redraw }
}

export interface CurveGraph { el: HTMLElement; redraw(): void }

const DB_MIN = -60

/** Input-vs-output plot for the compressor or gate (or any level curve), with the unity diagonal for reference. */
export function transferGraph(fn: () => (inDb: number) => number, thresholdDb: () => number): CurveGraph {
  const { c, g } = canvas()
  const xOf = (db: number) => ((db - DB_MIN) / -DB_MIN) * W
  const yOf = (db: number) => H - ((Math.max(DB_MIN, Math.min(0, db)) - DB_MIN) / -DB_MIN) * H
  const redraw = () => {
    g.clearRect(0, 0, W, H)
    grid(g, [-48, -36, -24, -12].map(xOf), [-48, -36, -24, -12].map(yOf))
    g.strokeStyle = css('--dim', '#777')
    g.setLineDash([3, 3])
    g.beginPath(); g.moveTo(0, H); g.lineTo(W, 0); g.stroke()
    g.setLineDash([])
    const t = xOf(thresholdDb())
    g.strokeStyle = css('--line', '#444')
    g.beginPath(); g.moveTo(t + 0.5, 0); g.lineTo(t + 0.5, H); g.stroke()
    g.strokeStyle = css('--accent', '#4da3ff')
    g.lineWidth = 2
    g.beginPath()
    const f = fn()
    for (let x = 0; x <= W; x += 2) {
      const y = yOf(f(DB_MIN + (x / W) * -DB_MIN))
      x === 0 ? g.moveTo(x, y) : g.lineTo(x, y)
    }
    g.stroke()
  }
  c.title = 'Horizontal: level going in. Vertical: level coming out. The dashed line is "no change".'
  redraw()
  return { el: c, redraw }
}

export const compCurve = (comp: CompConfig) => transferGraph(() => (db) => compOutDb(comp, db), () => comp.thresholdDb)
export const gateCurve = (gate: GateConfig) => transferGraph(() => (db) => gateOutDb(gate, db), () => gate.thresholdDb)
