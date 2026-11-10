import { contextBridge, ipcRenderer } from 'electron'
import type { Announcement, AnnounceRequest, QuickMessage } from '../shared/announce'
import type { Appearance } from '../shared/appearance'
import type { AtemButtons, AtemCommand, AtemStatus } from '../shared/atem'
import type { DmxCommand, DmxSettings, DmxStatus } from '../shared/dmx'
import type { MixerConfig } from '../shared/mixer'
import type { NativeInput } from '../shared/native-audio'
import type { StreamSettings } from '../shared/stream-settings'
import type { BibleImportResult, BibleSummary, BibleVerse } from '../shared/bible'
import {
  AUDIO_IPC,
  IPC,
  type AudioConfig,
  type AudioStatus,
  type Meters,
  type MediaKind,
  type ImportedVideo,
  type OutputPayload,
  type PlaybackCommand,
  type PlaybackState,
  type ScreenConfig,
  type ScreenState,
  type Service,
  type Slide,
  type Song,
  type SongExportResult,
  type SongImportResult,
  type StreamStartRequest,
  type StreamStatus,
} from '../shared/types'

const api = {
  getState: (): Promise<ScreenState> => ipcRenderer.invoke(IPC.getState),
  onState: (cb: (s: ScreenState) => void) => {
    ipcRenderer.on(IPC.stateChanged, (_e, s: ScreenState) => cb(s))
  },
  addVirtual: (name: string, w: number, h: number) => ipcRenderer.invoke(IPC.addVirtual, name, w, h),
  addDisplayScreen: (name: string, opts: { stage?: boolean; mirrorOf?: string } = {}) => ipcRenderer.invoke(IPC.addDisplayScreen, name, opts),
  addNdiScreen: (name: string, opts: { width?: number; height?: number; stage?: boolean; mirrorOf?: string } = {}) => ipcRenderer.invoke(IPC.addNdiScreen, name, opts),
  updateScreen: (id: string, patch: Partial<ScreenConfig>) => ipcRenderer.invoke(IPC.updateScreen, id, patch),
  moveScreen: (id: string, delta: -1 | 1): Promise<void> => ipcRenderer.invoke(IPC.moveScreen, id, delta),
  reorderScreen: (id: string, target: string, after: boolean): Promise<void> => ipcRenderer.invoke(IPC.reorderScreen, id, target, after),
  identifyDisplays: (): Promise<void> => ipcRenderer.invoke(IPC.identifyDisplays),
  removeScreen: (id: string) => ipcRenderer.invoke(IPC.removeScreen, id),
  setLive: (id: string, live: boolean) => ipcRenderer.invoke(IPC.setLive, id, live),
  showSlide: (slide: Slide | null) => ipcRenderer.invoke(IPC.showSlide, slide),
  clearScreen: (id: string, blank: boolean) => ipcRenderer.invoke(IPC.clearScreen, id, blank),
  outputInit: (id: string): Promise<OutputPayload | null> => ipcRenderer.invoke(IPC.outputInit, id),
  onOutputUpdate: (cb: (p: OutputPayload) => void) => {
    ipcRenderer.on(IPC.outputUpdate, (_e, p: OutputPayload) => cb(p))
  },
  streamStart: (req: StreamStartRequest): Promise<void> => ipcRenderer.invoke(IPC.streamStart, req),
  streamStop: (): Promise<void> => ipcRenderer.invoke(IPC.streamStop),
  streamSettingsGet: (): Promise<StreamSettings> => ipcRenderer.invoke(IPC.streamSettingsGet),
  streamSettingsSet: (s: StreamSettings): Promise<StreamSettings> => ipcRenderer.invoke(IPC.streamSettingsSet, s),
  streamGetStatus: (): Promise<StreamStatus> => ipcRenderer.invoke(IPC.streamGetStatus),
  songsList: (): Promise<Song[]> => ipcRenderer.invoke(IPC.songsList),
  songsSave: (song: Song): Promise<Song[]> => ipcRenderer.invoke(IPC.songsSave, song),
  songsDelete: (id: string): Promise<Song[]> => ipcRenderer.invoke(IPC.songsDelete, id),
  songsExport: (): Promise<SongExportResult | null> => ipcRenderer.invoke(IPC.songsExport),
  songsClear: (): Promise<Song[]> => ipcRenderer.invoke(IPC.songsClear),
  songsImport: (): Promise<{ songs: Song[]; result: SongImportResult } | null> => ipcRenderer.invoke(IPC.songsImport),
  servicesList: (): Promise<Service[]> => ipcRenderer.invoke(IPC.servicesList),
  servicesSave: (svc: Service): Promise<Service[]> => ipcRenderer.invoke(IPC.servicesSave, svc),
  servicesDelete: (id: string): Promise<Service[]> => ipcRenderer.invoke(IPC.servicesDelete, id),
  bibleList: (): Promise<BibleSummary[]> => ipcRenderer.invoke(IPC.bibleList),
  bibleChapter: (id: string, book: number, chapter: number): Promise<BibleVerse[] | null> => ipcRenderer.invoke(IPC.bibleChapter, id, book, chapter),
  bibleRemove: (id: string): Promise<BibleSummary[]> => ipcRenderer.invoke(IPC.bibleRemove, id),
  bibleImportDialog: (): Promise<BibleImportResult[]> => ipcRenderer.invoke(IPC.bibleImportDialog),
  bibleImportQuelea: (): Promise<{ folders: string[]; results: BibleImportResult[] }> => ipcRenderer.invoke(IPC.bibleImportQuelea),
  bibleImportPaths: (paths: string[]): Promise<BibleImportResult[]> => ipcRenderer.invoke(IPC.bibleImportPaths, paths),
  announceShow: (req: AnnounceRequest): Promise<boolean> => ipcRenderer.invoke(IPC.announceShow, req),
  announceClear: (): Promise<void> => ipcRenderer.invoke(IPC.announceClear),
  setNextSlide: (slide: Slide | null): Promise<void> => ipcRenderer.invoke(IPC.setNextSlide, slide),
  setCameraOnly: (on: boolean): Promise<void> => ipcRenderer.invoke(IPC.setCameraOnly, on),
  onAnnouncement: (cb: (a: Announcement | null) => void) => {
    ipcRenderer.on(IPC.announceState, (_e, a: Announcement | null) => cb(a))
  },
  announceQuickList: (): Promise<QuickMessage[]> => ipcRenderer.invoke(IPC.announceQuickList),
  announceQuickSave: (q: QuickMessage): Promise<QuickMessage[]> => ipcRenderer.invoke(IPC.announceQuickSave, q),
  announceQuickDelete: (id: string): Promise<QuickMessage[]> => ipcRenderer.invoke(IPC.announceQuickDelete, id),
  appearanceGet: (): Promise<Appearance> => ipcRenderer.invoke(IPC.appearanceGet),
  appearanceSet: (a: Appearance): Promise<Appearance> => ipcRenderer.invoke(IPC.appearanceSet, a),
  onAppearance: (cb: (a: Appearance) => void) => {
    ipcRenderer.on(IPC.appearanceChanged, (_e, a: Appearance) => cb(a))
  },
  atemGet: (): Promise<AtemStatus> => ipcRenderer.invoke(IPC.atemGet),
  onAtem: (cb: (s: AtemStatus) => void) => {
    ipcRenderer.on(IPC.atemState, (_e, s: AtemStatus) => cb(s))
  },
  atemSetAddress: (address: string): Promise<AtemStatus> => ipcRenderer.invoke(IPC.atemSetAddress, address),
  atemSend: (cmd: AtemCommand): Promise<boolean> => ipcRenderer.invoke(IPC.atemSend, cmd),
  atemSetButtons: (patch: Partial<AtemButtons>): Promise<AtemStatus> => ipcRenderer.invoke(IPC.atemSetButtons, patch),
  dmxGet: (): Promise<DmxStatus> => ipcRenderer.invoke(IPC.dmxGet),
  onDmx: (cb: (s: DmxStatus) => void) => {
    ipcRenderer.on(IPC.dmxState, (_e, s: DmxStatus) => cb(s))
  },
  dmxSetSettings: (settings: DmxSettings): Promise<DmxStatus> => ipcRenderer.invoke(IPC.dmxSetSettings, settings),
  dmxCommand: (cmd: DmxCommand): Promise<DmxStatus> => ipcRenderer.invoke(IPC.dmxCommand, cmd),
  mediaRemove: (file: string): Promise<boolean> => ipcRenderer.invoke(IPC.mediaRemove, file),
  picturesImport: (): Promise<{ title: string; slides: string[] } | null> => ipcRenderer.invoke(IPC.picturesImport),
  mediaList: (): Promise<import('../shared/types').MediaEntry[]> => ipcRenderer.invoke(IPC.mediaList),
  mediaImport: (kind: MediaKind) => ipcRenderer.invoke(IPC.mediaImport, kind) as Promise<import('../shared/types').Background | null>,
  streamKeySaved: (): Promise<boolean> => ipcRenderer.invoke(IPC.streamKeyState),
  streamKeyForget: (): Promise<void> => ipcRenderer.invoke(IPC.streamKeyForget),
  streamKeySet: (key: string): Promise<void> => ipcRenderer.invoke(IPC.streamKeySet, key),
  audioConfigure: (cfg: AudioConfig): Promise<AudioStatus> => ipcRenderer.invoke(AUDIO_IPC.configure, cfg),
  audioGetStatus: (): Promise<AudioStatus> => ipcRenderer.invoke(AUDIO_IPC.getStatus),
  audioNativeInputs: (): Promise<NativeInput[]> => ipcRenderer.invoke(AUDIO_IPC.nativeInputs),
  audioMixerGet: (): Promise<MixerConfig> => ipcRenderer.invoke(AUDIO_IPC.mixerGet),
  audioMixerSet: (m: MixerConfig): Promise<MixerConfig> => ipcRenderer.invoke(AUDIO_IPC.mixerSet, m),
  onMeters: (cb: (m: Meters) => void) => {
    ipcRenderer.on(AUDIO_IPC.metersOut, (_e, m: Meters) => cb(m))
  },
  onAudio: (cb: (s: AudioStatus) => void) => {
    ipcRenderer.on(AUDIO_IPC.status, (_e, s: AudioStatus) => cb(s))
  },
  presentationImport: (): Promise<{ title: string; slides: string[] } | null> => ipcRenderer.invoke(IPC.presentationImport),
  onPresentationStatus: (cb: (message: string) => void) => {
    ipcRenderer.on(IPC.presentationStatus, (_e, message: string) => cb(message))
  },
  videoImport: (): Promise<ImportedVideo | null> => ipcRenderer.invoke(IPC.videoImport),
  onVideoProgress: (cb: (pct: number) => void) => {
    ipcRenderer.on(IPC.videoProgress, (_e, pct: number) => cb(pct))
  },
  playbackCommand: (cmd: PlaybackCommand) => ipcRenderer.invoke(IPC.playbackCommand, cmd),
  playbackGet: (): Promise<PlaybackState> => ipcRenderer.invoke(IPC.playbackGet),
  onPlayback: (cb: (s: PlaybackState) => void) => {
    ipcRenderer.on(IPC.playbackState, (_e, s: PlaybackState) => cb(s))
  },
  playbackReport: (screenId: string, positionSec: number) => ipcRenderer.send(IPC.playbackReport, screenId, positionSec),
  onStream: (cb: (s: StreamStatus) => void) => {
    ipcRenderer.on(IPC.streamStatus, (_e, s: StreamStatus) => cb(s))
  },
}

export type PrestreamerApi = typeof api
contextBridge.exposeInMainWorld('prestreamer', api)
