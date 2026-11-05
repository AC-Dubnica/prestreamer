import type { Announcement } from './announce'
import type { StreamStats } from './stream-stats'

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
  /** Name of the bound display, so the binding survives a display id change (re-plugging, reboot). */
  displayLabel?: string
  /** For kind 'virtual': render size. Physical screens use the display's own size. */
  width: number
  height: number
  /** Per-screen look so each output can render the same slide differently. */
  look: Look
  /** A display screen that shows exactly what another screen shows (e.g. the stream's picture, on a monitor for the stage). */
  mirrorOf?: string
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
  /** Where the text sits: centred on the screen, or in a caption bar along the bottom (for text over live video). */
  /** 'stage' is the monitor for the people on stage: current slide, the next one, and the clock. */
  layout: 'full' | 'lower-third' | 'stage'
  /** Opacity (0-1) of a dark box behind the text; 0 = none. Makes text readable over camera video. */
  textBoxOpacity: number
  /** Output device id for that sound ('' = system default). Point it at the mixer's USB return. */
  audioOutput: string
  /** A picture or looping video behind the text of this screen, for slides that bring no picture or video of their own. */
  backgroundMedia: MediaBackground | null
  /** Show a "LIVE" badge on this screen while the stream is running, so the room knows the service is being broadcast. */
  liveBadge: boolean
  source: VideoSource
}

/** One picture or video in the media library (a possible background). */
export interface MediaEntry { file: string; kind: MediaKind; name: string }

/** A picture or video from the media library. */
export type MediaBackground = { kind: 'image' | 'video'; file: string }

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
  /** A presentation slide: one picture shown whole, over everything but the announcement (never cropped). */
  picture?: { file: string }
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
  /** Behind the text of every slide of the song (unless a slide has its own, below). */
  background: Background | null
  /** A picture or video for one slide only, by position in the song; null or missing = the song's own background. */
  slideBackgrounds?: (Background | null)[]
}

/** One entry in a service schedule. */
export type ServiceItem =
  | { id: string; kind: 'song'; songId: string }
  | { id: string; kind: 'video'; file: string; title: string; durationSec: number }
  /** A reading: a snapshot of the slides at the time it was added, so it does not depend on the Bible still being installed. */
  | { id: string; kind: 'scripture'; title: string; slides: { label: string; text: string }[]; background?: Background | null; slideBackgrounds?: (Background | null)[] }
  /** A PowerPoint / Keynote / PDF deck, kept as one picture (a file in the media folder) per slide. */
  | { id: string; kind: 'presentation'; title: string; slides: string[] }

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
  /** Top-left corner in the desktop's coordinate space. */
  x: number
  y: number
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
  /** The live announcement, if one is on air. Independent of the slide and the video. */
  announcement: Announcement | null
  /** The stream's screens show only the live camera: no text, slide media, video cues or announcements. */
  cameraOnly: boolean
  /** The slide after the current one, as the operator's list has it (for the stage monitor). */
  next: Slide | null
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
  /** What the stream's sound is: the mixer's master (default), or silence. */
  audio?: 'mixer' | 'none'
}

export interface StreamStatus {
  state: 'idle' | 'starting' | 'running' | 'error'
  message: string
  frames: number
  dropped: number
  startedAt: number | null
  /** Human-readable destination without secrets. */
  target: string
  /** Live health numbers while streaming (bitrate, frames, speed...). */
  stats?: StreamStats
}

export const idleStream: StreamStatus = { state: 'idle', message: '', frames: 0, dropped: 0, startedAt: null, target: '' }

export const defaultLook: Look = {
  fontSize: 64,
  textColor: '#ffffff',
  background: 'linear-gradient(135deg,#1b2a49,#0b1020)',
  showLabel: false,
  showMedia: true,
  videoAudio: false,
  layout: 'full',
  textBoxOpacity: 0,
  audioOutput: '',
  backgroundMedia: null,
  liveBadge: false,
  source: { type: 'none' },
}

/** IPC channel names shared by main, preload and renderers. */
export const IPC = {
  getState: 'state:get',
  stateChanged: 'state:changed',
  addVirtual: 'screen:add-virtual',
  addDisplayScreen: 'screen:add-display',
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
  mediaList: 'media:list',
  mediaRemove: 'media:remove',
  picturesImport: 'pictures:import',
  videoImport: 'video:import',
  videoProgress: 'video:progress',
  presentationImport: 'presentation:import',
  presentationStatus: 'presentation:status',
  playbackCommand: 'playback:command',
  playbackState: 'playback:state',
  playbackReport: 'playback:report',
  playbackGet: 'playback:get',
  streamKeyState: 'streamkey:state',
  streamKeyForget: 'streamkey:forget',
  streamSettingsGet: 'streamsettings:get',
  streamSettingsSet: 'streamsettings:set',
  identifyDisplays: 'screens:identify',
  moveScreen: 'screen:move',
  announceShow: 'announce:show',
  announceClear: 'announce:clear',
  setCameraOnly: 'stream:camera-only',
  setNextSlide: 'slide:next',
  announceState: 'announce:state',
  announceQuickList: 'announce:quick-list',
  announceQuickSave: 'announce:quick-save',
  announceQuickDelete: 'announce:quick-delete',
  bibleList: 'bible:list',
  bibleChapter: 'bible:chapter',
  bibleImportDialog: 'bible:import-dialog',
  bibleImportQuelea: 'bible:import-quelea',
  bibleImportPaths: 'bible:import-paths',
  bibleRemove: 'bible:remove',
} as const

export interface OutputPayload {
  screen: ScreenConfig
  slide: Slide | null
  playback: PlaybackState
  announcement: Announcement | null
  /** The stream is on air (drives the LIVE badge). */
  streamLive: boolean
  /** True on a virtual (stream) screen while camera-only is on. */
  cameraOnly: boolean
  next: Slide | null
}

/** Where stream audio comes from. A Behringer Wing's USB interface appears as a multichannel 'device'. */
export type AudioSource =
  | { type: 'silence' }
  | { type: 'test' } // stereo beep, pairs with the test pattern's flash for A/V sync checks
  | { type: 'multitest' } // four steady tones on four channels, for exercising the mixer without hardware
  | { type: 'device'; deviceId: string; label: string }

export interface AudioConfig {
  /** The default source: strips that name no device of their own read from it. */
  source: AudioSource
  /** Also run the devices that individual strips name. Set by the mixer's Start button. */
  mixerSources?: boolean
}

export interface AudioStatus {
  state: 'idle' | 'running' | 'error'
  message: string
  /** Channels of the default source the browser actually delivered; far fewer than 48 means the device is not exposing them all. */
  channelCount: number
  /** Every input that is open, with the channels it delivered, or why it could not be opened. */
  devices?: { id: string; label: string; channels: number; error?: string }[]
}

export const defaultAudio: AudioConfig = { source: { type: 'silence' } }
export const idleAudio: AudioStatus = { state: 'idle', message: 'Silence', channelCount: 0 }

export const AUDIO_IPC = {
  configure: 'audio:configure',
  status: 'audio:status',
  getStatus: 'audio:get-status',
  apply: 'audio:apply',
  report: 'audio:report',
  pcm: 'audio:pcm',
  playback: 'audio:playback',
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
