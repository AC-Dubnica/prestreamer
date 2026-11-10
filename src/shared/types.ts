import type { Announcement } from './announce'
import type { StreamStats } from './stream-stats'
import { t } from './i18n'

/**
 * A logical output, like a ProPresenter "screen". Independent of any physical display.
 * 'display' is a window on a monitor; 'virtual' is drawn offscreen and feeds the stream; 'ndi' is drawn offscreen and sent
 * over the network as an NDI source (a display somewhere else, fed through an NDI decoder), and takes the same roles as a display.
 */
export type ScreenKind = 'display' | 'virtual' | 'ndi'

/**
 * Live video drawn behind the text. An ATEM Mini attached over USB shows up as an
 * ordinary camera device, so it is just a 'camera' source.
 */
export type VideoSource =
  | { type: 'none' }
  | { type: 'testpattern' }
  | { type: 'camera'; deviceId: string; label: string }

/** The sound of an NDI screen: none, the mixer's stream mix, or only the sound of the service's video cues (before the mixer's strips and master). */
export type NdiSound = 'none' | 'stream' | 'video'

export interface ScreenConfig {
  id: string
  name: string
  kind: ScreenKind
  /** For kind 'display': Electron display id this screen is bound to (null = unassigned). */
  displayId: number | null
  /** Name of the bound display, so the binding survives a display id change (re-plugging, reboot). */
  displayLabel?: string
  /** For kind 'virtual' and 'ndi': render size. Physical screens use the display's own size. */
  width: number
  height: number
  /** Per-screen look so each output can render the same slide differently. */
  look: Look
  /** A display screen that shows exactly what another screen shows (e.g. the stream's picture, on a monitor for the stage). */
  mirrorOf?: string
  /** For kind 'ndi': which sound goes out with the picture (the stream mix by default). */
  ndiSound?: NdiSound
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
  /** How loud that sound is, in dB below full level (0 = full, down to -60); it can only be turned down. */
  videoVolumeDb: number
  /** That sound switched off without losing the level. */
  videoMuted: boolean
  /** A picture or looping video behind the text of this screen, for slides that bring no picture or video of their own. */
  backgroundMedia: MediaBackground | null
  /** Show a "LIVE" badge on this screen while the stream is running, so the room knows the service is being broadcast. */
  liveBadge: boolean
  /** Show the chords above the lyrics (for songs whose text has chord lines), e.g. on the band's monitor. */
  showChords: boolean
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
  /** The same slide with its chord lines (chord names above the lyrics), when the song has any; shown by screens that have `showChords` on. */
  chords?: string
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

/** What an import of songs did: how many were added, how many skipped because the library had them, which files had no lyrics. */
export interface SongImportResult {
  added: number
  skipped: number
  unreadable: string[]
}

/** Where an export of the library went and how many songs it holds. */
export interface SongExportResult {
  count: number
  path: string
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
  /**
   * Details Quelea keeps with a song, so a song imported from Quelea loses nothing. The song's own structure matches Quelea's:
   * a Quelea section (title + lines, optionally its own theme) is one slide here (`[Title]` + lines), its theme's picture or
   * video is that slide's entry in `slideBackgrounds`, and the song's theme is `background`.
   */
  /** The number in a songbook ("053"); searchable, and written in front of the title when songs are exported to Quelea. */
  number?: string
  author?: string
  copyright?: string
  ccli?: string
  year?: string
  publisher?: string
  key?: string
  capo?: string
  notes?: string
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

/** How the NDI output of a live 'ndi' screen is doing. */
export interface NdiStatus {
  state: 'starting' | 'sending' | 'error'
  /** What the operator should read: the NDI source's name while sending, or why it is not. */
  message: string
}

export interface ScreenState {
  screens: ScreenConfig[]
  /** The NDI output of each live 'ndi' screen, by screen id. */
  ndi: Record<string, NdiStatus>
  displays: DisplayInfo[]
  /** Screen ids currently live (window open). */
  live: string[]
  slide: Slide | null
  /** Screens that were cleared on their own: they show nothing until the next slide is shown. */
  blank: string[]
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
  videoVolumeDb: 0,
  videoMuted: false,
  backgroundMedia: null,
  liveBadge: false,
  showChords: false,
  source: { type: 'none' },
}

/** IPC channel names shared by main, preload and renderers. */
export const IPC = {
  getState: 'state:get',
  stateChanged: 'state:changed',
  addVirtual: 'screen:add-virtual',
  addDisplayScreen: 'screen:add-display',
  addNdiScreen: 'screen:add-ndi',
  updateScreen: 'screen:update',
  removeScreen: 'screen:remove',
  setLive: 'screen:set-live',
  showSlide: 'slide:show',
  clearScreen: 'slide:clear-screen',
  outputInit: 'output:init',
  outputUpdate: 'output:update',
  streamStart: 'stream:start',
  streamStop: 'stream:stop',
  streamStatus: 'stream:status',
  streamGetStatus: 'stream:get-status',
  songsList: 'songs:list',
  songsSave: 'songs:save',
  songsDelete: 'songs:delete',
  songsImport: 'songs:import',
  songsExport: 'songs:export',
  songsClear: 'songs:clear',
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
  streamKeySet: 'streamkey:set',
  streamSettingsGet: 'streamsettings:get',
  streamSettingsSet: 'streamsettings:set',
  identifyDisplays: 'screens:identify',
  moveScreen: 'screen:move',
  reorderScreen: 'screen:reorder',
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
  appearanceGet: 'appearance:get',
  appearanceSet: 'appearance:set',
  appearanceChanged: 'appearance:changed',
  atemGet: 'atem:get',
  atemState: 'atem:state',
  atemSetAddress: 'atem:set-address',
  atemSend: 'atem:send',
  atemSetButtons: 'atem:set-buttons',
  languageGet: 'language:get',
  languageSync: 'language:sync',
  languageSet: 'language:set',
  dmxGet: 'dmx:get',
  dmxState: 'dmx:state',
  dmxSetSettings: 'dmx:set-settings',
  dmxCommand: 'dmx:command',
  youtubeGet: 'youtube:get',
  youtubeState: 'youtube:state',
  youtubeSetClient: 'youtube:set-client',
  youtubeCommand: 'youtube:command',
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
  /** Why the monitor output could not be used (the device is gone, say); absent while it works or is off. */
  monitorError?: string
}

export const defaultAudio: AudioConfig = { source: { type: 'silence' } }
export const idleAudio: AudioStatus = { state: 'idle', get message() { return t('shared.audio.silence') }, channelCount: 0 }

export const AUDIO_IPC = {
  configure: 'audio:configure',
  status: 'audio:status',
  getStatus: 'audio:get-status',
  apply: 'audio:apply',
  report: 'audio:report',
  pcm: 'audio:pcm',
  videoPcm: 'audio:video-pcm',
  playback: 'audio:playback',
  mixerGet: 'audio:mixer-get',
  mixerSet: 'audio:mixer-set',
  mixerPush: 'audio:mixer-push',
  metersIn: 'audio:meters-in',
  metersOut: 'audio:meters-out',
  nativeInputs: 'audio:native-inputs',
  nativeStart: 'audio:native-start',
  nativeStop: 'audio:native-stop',
  nativeData: 'audio:native-data',
  nativeEnded: 'audio:native-ended',
} as const

/** Level readings sent ~20×/s from the audio window to the console UI. */
export interface Meters {
  /** Per strip, in the same order as the mixer config: peak and RMS in dBFS, compressor gain reduction in dB (≤ 0). */
  strips: { peakDb: number; rmsDb: number; reductionDb: number }[]
  masterPeakDb: [number, number]
  /** The sound of the video playing for the audience, before its level is applied (null while the audio engine is not running). */
  audience: { peakDb: number; rmsDb: number } | null
  /** Gain reduction in dB (≤ 0) of every effect that reduces gain (gate, compressor, limiter, de-esser), by effect id. */
  reductions: Record<string, number>
  /** What goes through an effect right now, by effect id, for its graph: the level at its input (gate, compressor) or the spectrum before and after it (EQ). */
  live?: Record<string, FxLive>
}

/** Live data of one effect for its graph: `inDb` is the peak level at its input (dBFS); `pre` and `post` are spectra in dBFS over log-spaced bands from 20 Hz to 20 kHz. */
export interface FxLive {
  inDb?: number
  pre?: number[]
  post?: number[]
}
