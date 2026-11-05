/**
 * Live announcements: urgent text laid over whatever is on the screens (lyrics, video, camera) without touching it.
 * The pure parts live here so they can be tested: validating a request, deciding which screens show it, sizing the text.
 */

export type AnnounceStyle = 'banner-bottom' | 'banner-top' | 'fullscreen'
export type AnnounceTone = 'alert' | 'notice' | 'info'

/** What the operator asks for. */
export interface AnnounceRequest {
  text: string
  style: AnnounceStyle
  tone: AnnounceTone
  /** Screen ids that show it; null = every screen. */
  screens: string[] | null
  /** Hide itself after this many seconds; null = stays until cleared. */
  autoHideSec: number | null
}

/** An announcement that is on air. */
export interface Announcement extends AnnounceRequest {
  id: string
}

/** A saved message that can be put on air with one click. */
export interface QuickMessage {
  id: string
  text: string
  style: AnnounceStyle
  tone: AnnounceTone
}

export const TONE_COLORS: Record<AnnounceTone, string> = { alert: '#b91c1c', notice: '#b45309', info: '#1d4ed8' }
export const MAX_ANNOUNCE_CHARS = 400

const STYLES: AnnounceStyle[] = ['banner-bottom', 'banner-top', 'fullscreen']
const TONES: AnnounceTone[] = ['alert', 'notice', 'info']

/** Validates a request from the interface. Returns null when there is nothing to show (empty text). */
export function sanitizeAnnounceRequest(raw: unknown): AnnounceRequest | null {
  const r = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
  const text = typeof r.text === 'string' ? r.text.trim().slice(0, MAX_ANNOUNCE_CHARS) : ''
  if (!text) return null
  const screens = Array.isArray(r.screens) ? r.screens.filter((s): s is string => typeof s === 'string').slice(0, 50).map((s) => s.slice(0, 80)) : null
  const sec = typeof r.autoHideSec === 'number' && Number.isFinite(r.autoHideSec) ? Math.round(r.autoHideSec) : 0
  return {
    text,
    style: STYLES.includes(r.style as AnnounceStyle) ? (r.style as AnnounceStyle) : 'banner-bottom',
    tone: TONES.includes(r.tone as AnnounceTone) ? (r.tone as AnnounceTone) : 'alert',
    screens,
    autoHideSec: sec >= 1 ? Math.min(sec, 3600) : null,
  }
}

export function sanitizeQuickMessage(raw: unknown): QuickMessage | null {
  const req = sanitizeAnnounceRequest(raw)
  const id = raw && typeof raw === 'object' ? (raw as { id?: unknown }).id : undefined
  return req && typeof id === 'string' && id ? { id: id.slice(0, 80), text: req.text, style: req.style, tone: req.tone } : null
}

/** Does this screen show the announcement? */
export const appliesTo = (a: Announcement | null | undefined, screenId: string): a is Announcement => !!a && (a.screens === null || a.screens.includes(screenId))

/** Text size in pixels for a screen of the given height: shorter messages are bigger, long ones still fit. */
export function announceFontPx(text: string, style: AnnounceStyle, screenHeight: number): number {
  const n = text.length
  const share =
    style === 'fullscreen'
      ? n <= 40 ? 0.12 : n <= 90 ? 0.09 : n <= 180 ? 0.07 : n <= 300 ? 0.055 : 0.045
      : n <= 60 ? 0.06 : n <= 120 ? 0.05 : n <= 220 ? 0.04 : 0.033
  return Math.round(screenHeight * share)
}

export const SEED_QUICK_MESSAGES: QuickMessage[] = [
  { id: 'q-phones', text: 'Please silence your mobile phones.', style: 'banner-bottom', tone: 'notice' },
  { id: 'q-start', text: 'The service will begin shortly. Please take your seats.', style: 'fullscreen', tone: 'info' },
  { id: 'q-car', text: 'Urgent: a vehicle has its lights on or is blocking the exit. Please check your car.', style: 'banner-top', tone: 'alert' },
]
