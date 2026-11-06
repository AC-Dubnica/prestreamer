import { defaultLook, type MediaBackground, type Look, type ScreenConfig, type VideoSource } from './types'

export const SCREEN_LIMITS = { width: [320, 7680], height: [240, 4320], fontSize: [16, 200], videoVolumeDb: [-60, 0] } as const

/** The look a stage monitor starts with: current slide, next slide and clock on black, no slide media. */
export const STAGE_LOOK: Partial<Look> = { layout: 'stage', background: '#000', showMedia: false, showLabel: true, fontSize: 80 }

/** What a display screen shows: slides in its own look, the stage view, or whatever another screen shows. */
export type ScreenRole = { kind: 'own' } | { kind: 'stage' } | { kind: 'mirror'; of: string }

export function roleOf(sc: ScreenConfig): ScreenRole {
  if (sc.mirrorOf) return { kind: 'mirror', of: sc.mirrorOf }
  return sc.look.layout === 'stage' ? { kind: 'stage' } : { kind: 'own' }
}

/** The patch for `ScreenManager.update` that gives a screen a role. Leaving the stage view puts back the plain slide look. */
export function rolePatch(role: ScreenRole, cur: ScreenConfig): { mirrorOf: string; look?: Look } {
  if (role.kind === 'mirror') return { mirrorOf: role.of }
  if (role.kind === 'stage') return { mirrorOf: '', look: { ...cur.look, ...STAGE_LOOK } as Look }
  if (cur.look.layout !== 'stage') return { mirrorOf: '' }
  const d = defaultLook
  return { mirrorOf: '', look: { ...cur.look, layout: d.layout, background: d.background, showMedia: d.showMedia, showLabel: d.showLabel, fontSize: d.fontSize } }
}

/** A size the screen (and the encoder) can take: within the limits, and even (yuv420p needs even width and height). */
export function clampSize(width: number, height: number): { width: number; height: number } {
  const fit = (v: number, [lo, hi]: readonly [number, number], fallback: number) => {
    const n = Number.isFinite(v) ? Math.round(v) : fallback
    return Math.min(hi, Math.max(lo, n)) & ~1
  }
  return { width: fit(width, SCREEN_LIMITS.width, 1920), height: fit(height, SCREEN_LIMITS.height, 1080) }
}

/** Whether a screen was cleared on its own (a mirror is also empty when the screen it follows is). */
export function isBlank(screens: readonly ScreenConfig[], blank: readonly string[], id: string): boolean {
  if (blank.includes(id)) return true
  const source = screens.find((s) => s.id === id)?.mirrorOf
  return !!source && blank.includes(source)
}

/** Common output sizes offered when creating or resizing a virtual screen. */
export const SIZE_PRESETS: { label: string; width: number; height: number }[] = [
  { label: '1080p · 1920×1080', width: 1920, height: 1080 },
  { label: '720p · 1280×720', width: 1280, height: 720 },
  { label: '4K · 3840×2160', width: 3840, height: 2160 },
  { label: 'Vertical 1080×1920', width: 1080, height: 1920 },
]

/** A copy of the list with the item `delta` places up (-1) or down (+1), or null if it is unknown or already at that end. */
export function moveById<T extends { id: string }>(list: T[], id: string, delta: -1 | 1): T[] | null {
  const from = list.findIndex((x) => x.id === id)
  const to = from + delta
  if (from < 0 || to < 0 || to >= list.length) return null
  const next = [...list]
  ;[next[from], next[to]] = [next[to], next[from]]
  return next
}

/** The two screens a new installation starts with: one for the audience, one virtual screen that feeds the stream. */
export function defaultScreens(): ScreenConfig[] {
  return [
    { id: 'audience', name: 'Audience', kind: 'display', displayId: null, width: 1920, height: 1080, look: { ...defaultLook, videoAudio: true } },
    { id: 'stream', name: 'Stream', kind: 'virtual', displayId: null, width: 1920, height: 1080, look: { ...defaultLook } },
  ]
}

const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' ? (v as Record<string, unknown>) : {})
const str = (v: unknown, fallback: string, max: number): string => (typeof v === 'string' ? v.slice(0, max) : fallback)
const bool = (v: unknown, fallback: boolean): boolean => (typeof v === 'boolean' ? v : fallback)
const int = (v: unknown, fallback: number, [lo, hi]: readonly [number, number]): number =>
  typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, Math.round(v))) : fallback

function sanitizeSource(raw: unknown): VideoSource {
  const r = obj(raw)
  if (r.type === 'testpattern') return { type: 'testpattern' }
  if (r.type === 'camera' && typeof r.deviceId === 'string' && r.deviceId) return { type: 'camera', deviceId: r.deviceId.slice(0, 300), label: str(r.label, '', 120) }
  return { type: 'none' }
}

/** Validates a look read from disk or IPC; anything unusable falls back to the default value for that field. */
/** A picture or video background: only a plain file name in the media folder, never a path. */
export function sanitizeBackgroundMedia(raw: unknown): MediaBackground | null {
  const r = obj(raw)
  if ((r.kind !== 'image' && r.kind !== 'video') || typeof r.file !== 'string') return null
  const file = r.file
  return file && file.length <= 120 && !/[\\/]/.test(file) && file !== '.' && file !== '..' ? { kind: r.kind, file } : null
}

export function sanitizeLook(raw: unknown): Look {
  const r = obj(raw)
  const d = defaultLook
  const opacity = typeof r.textBoxOpacity === 'number' && Number.isFinite(r.textBoxOpacity) ? Math.min(1, Math.max(0, r.textBoxOpacity)) : d.textBoxOpacity
  return {
    fontSize: int(r.fontSize, d.fontSize, SCREEN_LIMITS.fontSize),
    textColor: str(r.textColor, d.textColor, 40),
    background: str(r.background, d.background, 500),
    showLabel: bool(r.showLabel, d.showLabel),
    showMedia: bool(r.showMedia, d.showMedia),
    videoAudio: bool(r.videoAudio, d.videoAudio),
    layout: r.layout === 'lower-third' || r.layout === 'stage' ? r.layout : 'full',
    textBoxOpacity: opacity,
    audioOutput: str(r.audioOutput, d.audioOutput, 300),
    videoVolumeDb: typeof r.videoVolumeDb === 'number' && Number.isFinite(r.videoVolumeDb) ? Math.min(SCREEN_LIMITS.videoVolumeDb[1], Math.max(SCREEN_LIMITS.videoVolumeDb[0], r.videoVolumeDb)) : d.videoVolumeDb,
    videoMuted: bool(r.videoMuted, d.videoMuted),
    backgroundMedia: sanitizeBackgroundMedia(r.backgroundMedia),
    liveBadge: bool(r.liveBadge, d.liveBadge),
    source: sanitizeSource(r.source),
  }
}

/** Validates the saved screens. Invalid entries are dropped; if nothing usable is left the defaults are returned. */
export function sanitizeScreens(raw: unknown): ScreenConfig[] {
  if (!Array.isArray(raw)) return defaultScreens()
  const seen = new Set<string>()
  const out: ScreenConfig[] = []
  for (const item of raw) {
    const r = obj(item)
    if (typeof r.id !== 'string' || !r.id || seen.has(r.id)) continue
    if (r.kind !== 'display' && r.kind !== 'virtual') continue
    seen.add(r.id)
    const name = typeof r.name === 'string' && r.name.trim() ? r.name.trim().slice(0, 40) : 'Screen'
    const displayId = r.kind === 'display' && typeof r.displayId === 'number' && Number.isInteger(r.displayId) ? r.displayId : null
    const screen: ScreenConfig = {
      id: r.id.slice(0, 80),
      name,
      kind: r.kind,
      displayId,
      width: int(r.width, 1920, SCREEN_LIMITS.width),
      height: int(r.height, 1080, SCREEN_LIMITS.height),
      look: sanitizeLook(r.look),
    }
    if (r.kind === 'display' && typeof r.mirrorOf === 'string' && r.mirrorOf) screen.mirrorOf = r.mirrorOf.slice(0, 80)
    if (displayId !== null && typeof r.displayLabel === 'string' && r.displayLabel) screen.displayLabel = r.displayLabel.slice(0, 120)
    out.push(screen)
  }
  // A mirror must follow a screen that exists and is not itself a mirror; otherwise it becomes an ordinary screen.
  const byId = new Map(out.map((s) => [s.id, s]))
  for (const s of out) {
    const target = s.mirrorOf ? byId.get(s.mirrorOf) : undefined
    if (s.mirrorOf && (s.kind !== 'display' || !target || target.id === s.id || target.mirrorOf)) delete s.mirrorOf
  }
  return out.length ? out : defaultScreens()
}
