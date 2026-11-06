/** ATEM switcher control over Ethernet (the Mini's USB port is only a webcam output, it cannot carry control). Pure model, no I/O. */

/** What an ATEM answers on out of the box; tried when no address was saved. */
export const DEFAULT_ATEM_ADDRESS = '192.168.10.240'

export interface AtemInput {
  id: number
  /** Short label as set on the switcher ("CAM 1"). */
  name: string
  /** Long label ("Front camera"). */
  longName: string
}

/** searching: looking for / waiting for the switcher. connected: answering. */
export type AtemLinkState = 'searching' | 'connected'

/** Which switching controls the panels show (the operator may want only program buttons and a Cut). */
export interface AtemButtons { preview: boolean; cut: boolean; auto: boolean }
export const defaultAtemButtons: AtemButtons = { preview: true, cut: true, auto: true }

export interface AtemStatus {
  /** Which controls to show. */
  buttons: AtemButtons
  state: AtemLinkState
  /** The address being tried or connected to. */
  address: string
  /** Switcher model, e.g. "ATEM Mini Pro" (only once connected). */
  model: string
  inputs: AtemInput[]
  program: number
  preview: number
  /** An automatic transition is running. */
  inTransition: boolean
  /** One line for the operator ("No ATEM found at 192.168.10.240", ...). */
  message: string
}

export const idleAtem: AtemStatus = {
  buttons: defaultAtemButtons,
  state: 'searching',
  address: DEFAULT_ATEM_ADDRESS,
  model: '',
  inputs: [],
  program: 0,
  preview: 0,
  inTransition: false,
  message: 'Looking for an ATEM…',
}

export type AtemCommand =
  | { type: 'program'; input: number }
  | { type: 'preview'; input: number }
  | { type: 'cut' }
  | { type: 'auto' }

export interface AtemSettings {
  /** Empty = the factory address. */
  address: string
  buttons: AtemButtons
}
export const defaultAtemSettings: AtemSettings = { address: '', buttons: defaultAtemButtons }

const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/
const HOSTNAME = /^(?=.{1,253}$)[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$/

/** An IPv4 address or a host name; everything else (URLs, ports, spaces) is rejected. */
export function isValidAtemAddress(raw: unknown): raw is string {
  if (typeof raw !== 'string') return false
  const a = raw.trim()
  const ip = IPV4.exec(a)
  if (ip) return ip.slice(1).every((part) => Number(part) <= 255)
  // Something made only of digits and dots is a malformed address, not a host name.
  return !/^[\d.]+$/.test(a) && HOSTNAME.test(a)
}

export function sanitizeAtemButtons(raw: unknown): AtemButtons {
  const r = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
  const flag = (v: unknown, d: boolean) => (typeof v === 'boolean' ? v : d)
  return { preview: flag(r.preview, true), cut: flag(r.cut, true), auto: flag(r.auto, true) }
}

export function sanitizeAtemSettings(raw: unknown): AtemSettings {
  const r = raw as { address?: unknown; buttons?: unknown } | null
  return { address: isValidAtemAddress(r?.address) ? r.address.trim() : '', buttons: sanitizeAtemButtons(r?.buttons) }
}

export const atemAddress = (s: AtemSettings): string => s.address || DEFAULT_ATEM_ADDRESS

/** Port types of inputs that can be cut to (an ATEM also lists its own outputs and clean feeds, which are not sources). */
interface RawInput { inputId: number; shortName: string; longName: string; meAvailability: number }
const ME1 = 1
/** Ids from 10000 up are the switcher's own outputs (program, preview, clean feeds, auxes). */
const LAST_SOURCE_ID = 9999

/** The inputs the operator can put on air on the first mix effect, in the switcher's own order. */
export function switchableInputs(raw: readonly RawInput[]): AtemInput[] {
  return raw
    .filter((i) => i.inputId <= LAST_SOURCE_ID && (i.meAvailability & ME1) !== 0)
    .sort((a, b) => a.inputId - b.inputId)
    .map((i) => ({ id: i.inputId, name: i.shortName || String(i.inputId), longName: i.longName || i.shortName || String(i.inputId) }))
}

/** True when the command makes sense for the status: the controls stay disabled otherwise. */
export function canSend(status: AtemStatus, cmd: AtemCommand): boolean {
  if (status.state !== 'connected') return false
  if (cmd.type === 'cut' || cmd.type === 'auto') return !status.inTransition
  return Number.isInteger(cmd.input) && status.inputs.some((i) => i.id === cmd.input)
}
