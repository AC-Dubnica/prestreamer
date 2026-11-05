/**
 * What PreStreamer remembers of how it was last left, so it opens the same way: where the window was, and which screens
 * were open. Pure functions, so the rules (never reopen something that would cover the controls) can be unit-tested.
 */
import type { DisplayInfo, ScreenConfig } from './types'

export interface Rect { x: number; y: number; width: number; height: number }

export interface Session {
  bounds: Rect | null
  maximized: boolean
  /** Ids of the screens that were open. */
  liveScreens: string[]
}

export const defaultSession = (): Session => ({ bounds: null, maximized: false, liveScreens: [] })

const MIN_W = 900
const MIN_H = 600

const int = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : null)

export function sanitizeSession(raw: unknown): Session {
  const r = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
  const b = r.bounds && typeof r.bounds === 'object' ? (r.bounds as Record<string, unknown>) : null
  const [x, y, w, h] = [int(b?.x), int(b?.y), int(b?.width), int(b?.height)]
  const bounds = x !== null && y !== null && w !== null && h !== null && w >= MIN_W && h >= MIN_H && w <= 20000 && h <= 20000 ? { x, y, width: w, height: h } : null
  const live = Array.isArray(r.liveScreens) ? r.liveScreens.filter((id): id is string => typeof id === 'string').slice(0, 50) : []
  return { bounds, maximized: r.maximized === true, liveScreens: live }
}

/** The saved window position, only if its middle is still on a connected display (a monitor may have been unplugged). */
export function fitBounds(b: Rect | null, workAreas: Rect[]): Rect | null {
  if (!b) return null
  const cx = b.x + b.width / 2
  const cy = b.y + b.height / 2
  return workAreas.some((a) => cx >= a.x && cx < a.x + a.width && cy >= a.y && cy < a.y + a.height) ? b : null
}

/**
 * Whether a screen that was open last time may open by itself now. A full-screen output on the main display would cover
 * the controls (the operator window lives there), so those are left for the operator to open on purpose.
 */
export function safeToRestore(cfg: ScreenConfig, displays: DisplayInfo[]): boolean {
  if (cfg.kind === 'virtual') return true
  if (cfg.displayId === null) return true // a plain window
  const bound = displays.find((d) => d.id === cfg.displayId)
  if (!bound) return true // not connected: it opens as a window
  return !bound.primary
}
