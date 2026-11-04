/** A logical output, like a ProPresenter "screen". Independent of any physical display. */
export type ScreenKind = 'display' | 'virtual'

/**
 * Live video drawn behind the text. An ATEM Mini attached over USB shows up as an
 * ordinary camera device, so it is just a 'camera' source.
 */
export type VideoSource =
  | { type: 'none' }
  | { type: 'testpattern' }
  | { type: 'camera'; deviceId: string; label: string }

export interface ScreenConfig {
  id: string
  name: string
  kind: ScreenKind
  /** For kind 'display': Electron display id this screen is bound to (null = unassigned). */
  displayId: number | null
  /** For kind 'virtual': render size. Physical screens use the display's own size. */
  width: number
  height: number
  /** Per-screen look so each output can render the same slide differently. */
  look: Look
}

export interface Look {
  fontSize: number
  textColor: string
  /** CSS background (color, gradient or url(...)). */
  background: string
  /** Show only the slide text, or text plus section label (stage-style). */
  showLabel: boolean
  /** Draw slide backgrounds (images/video). Off for e.g. a plain chroma-key screen. */
  showMedia: boolean
  /** Play the sound of video cues from this screen's window (enable on exactly one screen). */
  videoAudio: boolean
  /** Output device id for that sound ('' = system default). Point it at the mixer's USB return. */
  audioOutput: string
  source: VideoSource
}

/** Backdrop behind the text. Media files live in the app's media folder, referenced by file name. */
export type Background =
  | { kind: 'css'; css: string }
  | { kind: 'image'; file: string }
  | { kind: 'video'; file: string }

export interface Slide {
  label: string
  text: string
  background?: Background | null
  /** Schedule item this slide belongs to (so identical text in two items stays distinguishable). */
  itemId?: string
  /** A video cue: shown full screen instead of text, driven by the shared PlaybackState. */
  video?: { file: string; title: string; durationSec: number }
}

/**
 * One authoritative clock for the video on screen. Every window derives its expected position from
 * (positionSec, atMs, playing), so all outputs show the same frame without messaging per frame.
 */
export interface PlaybackState {
  file: string | null
  playing: boolean
  /** Position at wall-clock time atMs (ms since epoch; all windows share this machine's clock). */
  positionSec: number
  atMs: number
  durationSec: number
}

export const idlePlayback: PlaybackState = { file: null, playing: false, positionSec: 0, atMs: 0, durationSec: 0 }

export type PlaybackCommand = { type: 'play' } | { type: 'pause' } | { type: 'stop' } | { type: 'seek'; sec: number }

export interface ImportedVideo {
  file: string
  title: string
  durationSec: number
}

/**
 * A song as edited by the user. `body` is plain text: a `[Label]` line starts a section and a
 * blank line starts a new slide (see parseSong).
 */
export interface Song {
  id: string
  title: string
  body: string
  background: Background | null
}

/** One entry in a service schedule. */
export type ServiceItem =
  | { id: string; kind: 'song'; songId: string }
  | { id: string; kind: 'video'; file: string; title: string; durationSec: number }

/** A Sunday service: an ordered run sheet of items. */
export interface Service {
  id: string
  name: string
  items: ServiceItem[]
}

export type MediaKind = 'image' | 'video'

export const MEDIA_SCHEME = 'media'
export const mediaUrl = (file: string): string => `${MEDIA_SCHEME}://local/${encodeURIComponent(file)}`

export interface DisplayInfo {
  id: number
  label: string
  width: number
  height: number
  primary: boolean
}

export interface ScreenState {
  screens: ScreenConfig[]
  displays: DisplayInfo[]
  /** Screen ids currently live (window open). */
  live: string[]
  slide: Slide | null
}

export type StreamMode = 'file' | 'youtube'

export interface StreamStartRequest {
  /** Must be a virtual screen: only those produce frames. */
  screenId: string
  mode: StreamMode
  /** YouTube stream key (never persisted or logged). */
  streamKey?: string
  /** Output path for mode 'file'. */
  filePath?: string
}

export interface StreamStatus {
  state: 'idle' | 'starting' | 'running' | 'error'
  message: string
  frames: number
  dropped: number
  startedAt: number | null
  /** Human-readable destination without secrets. */
  target: string
}

export const idleStream: StreamStatus = { state: 'idle', message: '', frames: 0, dropped: 0, startedAt: null, target: '' }

export const defaultLook: Look = {
  fontSize: 64,
  textColor: '#ffffff',
  background: 'linear-gradient(135deg,#1b2a49,#0b1020)',
  showLabel: false,
  showMedia: true,
  videoAudio: false,
  audioOutput: '',
  source: { type: 'none' },
}

/** IPC channel names shared by main, preload and renderers. */
export const IPC = {
  getState: 'state:get',
  stateChanged: 'state:changed',
  addVirtual: 'screen:add-virtual',
  updateScreen: 'screen:update',
  removeScreen: 'screen:remove',
  setLive: 'screen:set-live',
  showSlide: 'slide:show',
  outputInit: 'output:init',
  outputUpdate: 'output:update',
  streamStart: 'stream:start',
  streamStop: 'stream:stop',
  streamStatus: 'stream:status',
  streamGetStatus: 'stream:get-status',
  songsList: 'songs:list',
  songsSave: 'songs:save',
  songsDelete: 'songs:delete',
  servicesList: 'services:list',
  servicesSave: 'services:save',
  servicesDelete: 'services:delete',
  mediaImport: 'media:import',
  videoImport: 'video:import',
  videoProgress: 'video:progress',
  playbackCommand: 'playback:command',
  playbackState: 'playback:state',
  playbackReport: 'playback:report',
  playbackGet: 'playback:get',
  streamKeyState: 'streamkey:state',
  streamKeyForget: 'streamkey:forget',
} as const

export interface OutputPayload {
  screen: ScreenConfig
  slide: Slide | null
  playback: PlaybackState
}

/** Where stream audio comes from. A Behringer Wing's USB interface appears as a multichannel 'device'. */
export type AudioSource =
  | { type: 'silence' }
  | { type: 'test' } // stereo beep, pairs with the test pattern's flash for A/V sync checks
  | { type: 'multitest' } // four steady tones on four channels, for exercising the mixer without hardware
  | { type: 'device'; deviceId: string; label: string }

export interface AudioConfig {
  source: AudioSource
  /** Delay applied to audio so it lines up with video that has encoding/capture latency. */
  delayMs: number
}

export interface AudioStatus {
  state: 'idle' | 'running' | 'error'
  message: string
  /** Channels the browser actually delivered; far fewer than 48 means the device is not exposing them all. */
  channelCount: number
}

export const defaultAudio: AudioConfig = { source: { type: 'silence' }, delayMs: 0 }
export const idleAudio: AudioStatus = { state: 'idle', message: 'Silence', channelCount: 0 }

export const AUDIO_IPC = {
  configure: 'audio:configure',
  status: 'audio:status',
  getStatus: 'audio:get-status',
  apply: 'audio:apply',
  report: 'audio:report',
  pcm: 'audio:pcm',
  mixerGet: 'audio:mixer-get',
  mixerSet: 'audio:mixer-set',
  mixerPush: 'audio:mixer-push',
  metersIn: 'audio:meters-in',
  metersOut: 'audio:meters-out',
} as const

/** Level readings sent ~20×/s from the audio window to the console UI. */
export interface Meters {
  /** Per strip, in the same order as the mixer config: peak and RMS in dBFS, compressor gain reduction in dB (≤ 0). */
  strips: { peakDb: number; rmsDb: number; reductionDb: number }[]
  masterPeakDb: [number, number]
}
