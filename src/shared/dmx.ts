/** DMX lighting through a USB interface (Enttec Open DMX USB or another FTDI one). Pure model, no I/O. */

/** Slots in one DMX universe. */
export const DMX_CHANNELS = 512

/** What a fixture is: how many channels it takes and what they are called. `raw` has as many channels as it is given. */
export type FixtureKind = 'dimmer' | 'rgb' | 'rgbw' | 'raw'

export const FIXTURE_KINDS: { kind: FixtureKind; label: string; channels: number | null }[] = [
  { kind: 'dimmer', label: 'Dimmer (1 channel)', channels: 1 },
  { kind: 'rgb', label: 'RGB light (3 channels: red, green, blue)', channels: 3 },
  { kind: 'rgbw', label: 'RGBW light (4 channels: red, green, blue, white)', channels: 4 },
  { kind: 'raw', label: 'Other (you choose the number of channels)', channels: null },
]

export const MAX_RAW_CHANNELS = 32
export const MAX_FIXTURES = 128
export const MAX_SCENES = 64

export interface Fixture {
  id: string
  name: string
  kind: FixtureKind
  /** First DMX address, 1..512. */
  address: number
  /** Channels taken from `address` on (fixed by the kind, except for `raw`). */
  channels: number
}

/** Level of every channel of every fixture, 0..255, by fixture id. */
export type Levels = Record<string, number[]>

export interface Scene {
  id: string
  name: string
  /** Seconds to fade to it; null = the default fade time. */
  fadeSec: number | null
  values: Levels
}

export interface DmxSettings {
  /** Off by default: nothing is shown and no port is touched until it is switched on. */
  enabled: boolean
  /** Device path of the interface; empty = the first one found. */
  port: string
  /** Default fade time of a scene, seconds. */
  fadeSec: number
  /** Send darkness when the app closes. Otherwise the output just stops and the fixtures do what they do without a signal. */
  blackoutOnQuit: boolean
  /** A scene recalled when the app starts; empty = the lights are left alone until the first action. */
  startScene: string
  fixtures: Fixture[]
  scenes: Scene[]
}

export const defaultDmxSettings: DmxSettings = { enabled: false, port: '', fadeSec: 1.5, blackoutOnQuit: false, startScene: '', fixtures: [], scenes: [] }

export const MAX_FADE_SEC = 60

/**
 * idle: on, but nothing sent yet (the lights are left alone until the first action). starting/sending: the helper opens the
 * interface / frames are going out. error: no interface or it failed; the next action tries again.
 */
export type DmxLinkState = 'off' | 'idle' | 'starting' | 'sending' | 'error'

export interface DmxStatus {
  state: DmxLinkState
  /** One line for the operator. */
  message: string
  /** The interface in use (or the one that would be used). */
  port: string
  /** Interfaces found on this computer. */
  ports: string[]
  settings: DmxSettings
  /** The levels being set (a fade is already counted as done). */
  levels: Levels
  /** The scene recalled last and not changed since; empty after a fader was moved. */
  scene: string
  /** Grand master, 0..100 %. */
  master: number
  blackout: boolean
}

export const idleDmx: DmxStatus = { state: 'off', message: 'DMX lighting is switched off', port: '', ports: [], settings: defaultDmxSettings, levels: {}, scene: '', master: 100, blackout: false }

export type DmxCommand =
  | { type: 'scene'; id: string }
  | { type: 'level'; fixture: string; channel: number; value: number }
  | { type: 'master'; value: number }
  | { type: 'blackout'; on: boolean }
  | { type: 'rescan' }

export const clampByte = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? Math.min(255, Math.max(0, Math.round(v))) : 0)

export function kindChannels(kind: FixtureKind, raw = 1): number {
  const k = FIXTURE_KINDS.find((f) => f.kind === kind)
  return k?.channels ?? Math.min(MAX_RAW_CHANNELS, Math.max(1, Math.round(raw)))
}

/** Names of the channels of a fixture, as the faders show them. */
export function channelLabels(f: Pick<Fixture, 'kind' | 'channels'>): string[] {
  if (f.kind === 'dimmer') return ['Level']
  if (f.kind === 'rgb') return ['Red', 'Green', 'Blue']
  if (f.kind === 'rgbw') return ['Red', 'Green', 'Blue', 'White']
  return Array.from({ length: f.channels }, (_, i) => `Ch ${i + 1}`)
}

const cleanId = (v: unknown, fallback: string): string => (typeof v === 'string' && /^[\w-]{1,40}$/.test(v) ? v : fallback)
const cleanName = (v: unknown, fallback: string): string => (typeof v === 'string' && v.trim() ? v.trim().slice(0, 60) : fallback)

export function sanitizeFixtures(raw: unknown): Fixture[] {
  if (!Array.isArray(raw)) return []
  const seen = new Set<string>()
  const out: Fixture[] = []
  for (const item of raw.slice(0, MAX_FIXTURES)) {
    const r = item && typeof item === 'object' ? (item as Record<string, unknown>) : {}
    const kind: FixtureKind = r.kind === 'dimmer' || r.kind === 'rgb' || r.kind === 'rgbw' || r.kind === 'raw' ? r.kind : 'dimmer'
    const channels = kindChannels(kind, typeof r.channels === 'number' ? r.channels : 1)
    const address = typeof r.address === 'number' && Number.isInteger(r.address) ? Math.min(DMX_CHANNELS, Math.max(1, r.address)) : 1
    let id = cleanId(r.id, `fx${out.length + 1}`)
    while (seen.has(id)) id = `${id}x`
    seen.add(id)
    out.push({ id, name: cleanName(r.name, `Light ${out.length + 1}`), kind, address, channels })
  }
  return out
}

/** `values` reduced to the fixtures that exist, each as long as the fixture's channels (missing ones are dark). */
export function fitLevels(fixtures: readonly Fixture[], values: unknown): Levels {
  const src = values && typeof values === 'object' ? (values as Record<string, unknown>) : {}
  const out: Levels = {}
  for (const f of fixtures) {
    const row = Array.isArray(src[f.id]) ? (src[f.id] as unknown[]) : []
    out[f.id] = Array.from({ length: f.channels }, (_, i) => clampByte(row[i]))
  }
  return out
}

export function sanitizeFade(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? Math.min(MAX_FADE_SEC, Math.max(0, Math.round(v * 10) / 10)) : fallback
}

export function sanitizeScenes(raw: unknown, fixtures: readonly Fixture[]): Scene[] {
  if (!Array.isArray(raw)) return []
  const seen = new Set<string>()
  const out: Scene[] = []
  for (const item of raw.slice(0, MAX_SCENES)) {
    const r = item && typeof item === 'object' ? (item as Record<string, unknown>) : {}
    let id = cleanId(r.id, `scene${out.length + 1}`)
    while (seen.has(id)) id = `${id}x`
    seen.add(id)
    out.push({ id, name: cleanName(r.name, `Scene ${out.length + 1}`), fadeSec: r.fadeSec === null || r.fadeSec === undefined ? null : sanitizeFade(r.fadeSec, 0), values: fitLevels(fixtures, r.values) })
  }
  return out
}

export function sanitizeDmxSettings(raw: unknown): DmxSettings {
  const r = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
  const fixtures = sanitizeFixtures(r.fixtures)
  const scenes = sanitizeScenes(r.scenes, fixtures)
  const startScene = typeof r.startScene === 'string' && scenes.some((s) => s.id === r.startScene) ? r.startScene : ''
  return {
    enabled: r.enabled === true,
    port: typeof r.port === 'string' && /^[\w./:-]{0,200}$/.test(r.port) ? r.port : '',
    fadeSec: sanitizeFade(r.fadeSec, defaultDmxSettings.fadeSec),
    blackoutOnQuit: r.blackoutOnQuit === true,
    startScene,
    fixtures,
    scenes,
  }
}

/** Problems with the patch, one line each: a fixture reaching past channel 512, or two sharing a channel. */
export function patchProblems(fixtures: readonly Fixture[]): string[] {
  const problems: string[] = []
  const owner = new Map<number, Fixture>()
  const reported = new Set<string>()
  for (const f of fixtures) {
    if (f.address + f.channels - 1 > DMX_CHANNELS) problems.push(`${f.name} needs channels ${f.address}–${f.address + f.channels - 1}, but a universe ends at ${DMX_CHANNELS}`)
    for (let c = f.address; c < f.address + f.channels && c <= DMX_CHANNELS; c++) {
      const other = owner.get(c)
      if (other) {
        const key = `${other.id}|${f.id}`
        if (!reported.has(key)) { reported.add(key); problems.push(`${f.name} and ${other.name} share channel ${c}`) }
      } else owner.set(c, f)
    }
  }
  return problems
}

/** The first address where `channels` free channels fit after the existing fixtures, or null when the universe is full. */
export function nextFreeAddress(fixtures: readonly Fixture[], channels: number): number | null {
  const taken = new Set<number>()
  for (const f of fixtures) for (let c = f.address; c < f.address + f.channels; c++) taken.add(c)
  for (let start = 1; start + channels - 1 <= DMX_CHANNELS; start++) {
    let free = true
    for (let c = start; c < start + channels; c++) if (taken.has(c)) { free = false; start = c; break }
    if (free) return start
  }
  return null
}

/** What goes on the wire: the 512 slots (without the start code), levels scaled by the grand master (0..100); all dark while `blackout`. */
export function renderUniverse(fixtures: readonly Fixture[], levels: Levels, master = 100, blackout = false): Uint8Array {
  const out = new Uint8Array(DMX_CHANNELS)
  if (blackout) return out
  const k = Math.min(100, Math.max(0, master)) / 100
  for (const f of fixtures) {
    const row = levels[f.id]
    if (!row) continue
    for (let i = 0; i < f.channels; i++) {
      const slot = f.address - 1 + i
      if (slot < DMX_CHANNELS) out[slot] = clampByte((row[i] ?? 0) * k)
    }
  }
  return out
}

/** Levels `t` (0..1) of the way from one set to another. */
export function blendLevels(from: Levels, to: Levels, t: number): Levels {
  const u = Math.min(1, Math.max(0, t))
  const out: Levels = {}
  for (const [id, row] of Object.entries(to)) {
    const was = from[id] ?? []
    out[id] = row.map((v, i) => (was[i] ?? 0) + (v - (was[i] ?? 0)) * u)
  }
  return out
}

/** Seconds a scene takes to arrive. */
export const sceneFade = (s: DmxSettings, scene: Scene): number => scene.fadeSec ?? s.fadeSec

/** A new id that no scene or fixture of the list has. */
export function newId(prefix: string, taken: readonly { id: string }[]): string {
  const used = new Set(taken.map((t) => t.id))
  for (let n = 1; ; n++) if (!used.has(`${prefix}${n}`)) return `${prefix}${n}`
}

// --- Finding the interface -------------------------------------------------------------------------------------------------

/** Which entries of /dev (macOS, Linux) can be a USB serial adapter. Windows needs FTDI's own driver and is not supported yet. */
export function dmxPortCandidates(devNames: readonly string[], platform: string): string[] {
  const pattern = platform === 'darwin' ? /^cu\.usbserial/ : platform === 'linux' ? /^ttyUSB\d+$/ : null
  if (!pattern) return []
  return devNames.filter((n) => pattern.test(n)).sort().map((n) => `/dev/${n}`)
}

/** Only the names this module would offer can be opened by the helper: nothing else from a settings file reaches it. */
export function isDmxPort(path: string, platform: string): boolean {
  const m = /^\/dev\/([^/]+)$/.exec(path)
  return !!m && dmxPortCandidates([m[1]], platform).length === 1
}

export const DMX_UNSUPPORTED = 'DMX output through the Open DMX USB works on macOS and Linux for now (Windows needs FTDI\'s driver library).'
export const DMX_NO_INTERFACE = 'No DMX interface found. Plug in the USB cable and press Rescan.'
