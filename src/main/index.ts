import { app, BrowserWindow, ipcMain, protocol, session } from 'electron'
import { join, resolve } from 'node:path'
import { AUDIO_IPC, IPC, type PlaybackCommand, MEDIA_SCHEME, type AudioConfig, type MediaKind, type ScreenConfig, type Service, type Slide, type Song, type StreamStartRequest } from '../shared/types'
import { pickMedia, serveMedia } from './library'
import { ListStore } from './store'
import { streamKey } from './secrets'
import { SEED_SERVICES, SEED_SONGS } from '../shared/songs'
import { ScreenManager } from './screens'
import { AudioBridge } from './audio'
import { Playback } from './playback'
import { setBundledToolsEnabled } from './tools'
import { pickVideo } from './video'
import { runDevHooks } from './devhooks'
import { Streamer, fileTarget, youtubeTarget } from './streamer'

// Tests and CI point this at a scratch folder so they never touch real songs, services, mixer or stream key.
// (resolved first: Chromium aborts without a message on a path containing "..")
if (process.env.PRESTREAMER_USER_DATA) app.setPath('userData', resolve(process.env.PRESTREAMER_USER_DATA))

// Must run before app ready. 'stream' lets <video> seek/loop via range requests.
protocol.registerSchemesAsPrivileged([
  { scheme: MEDIA_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
])

let operator: BrowserWindow | null = null
const userData = () => app.getPath('userData')
const songStore = new ListStore<Song>('songs.json', SEED_SONGS, userData)
const serviceStore = new ListStore<Service>('services.json', SEED_SERVICES, userData)

// Created in whenReady: Electron's `screen` module is unusable before then.
let screens: ScreenManager
let streamer: Streamer
let audio: AudioBridge
let playback: Playback

function createOperator(): void {
  operator = new BrowserWindow({
    width: 1400,
    height: 860,
    title: 'prestreamer',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      sandbox: true,
    },
  })
  operator.loadFile(join(__dirname, '../renderer/operator.html'))
  operator.on('closed', async () => {
    operator = null
    await streamer.stop()
    audio.close()
    screens.closeAll()
    app.quit()
  })
}

/** Shows a slide on every screen; a video cue also loads the shared playback clock (paused at 0). */
function presentSlide(slide: Slide | null): void {
  screens.showSlide(slide)
  playback.load(slide?.video ?? null)
}

async function startStream(req: StreamStartRequest): Promise<void> {
  const cfg = screens.getState().screens.find((s) => s.id === req.screenId)
  if (!cfg || cfg.kind !== 'virtual') throw new Error('Streaming needs a virtual screen')
  if (!screens.getState().live.includes(cfg.id)) screens.setLive(cfg.id, true)

  let key = ''
  if (req.mode === 'youtube') {
    // A typed key is remembered (encrypted); otherwise the saved one is used.
    const typed = req.streamKey?.trim()
    if (typed) streamKey.save(typed)
    key = typed || streamKey.load() || ''
    if (!key) throw new Error('YouTube stream key is required (enter it once; it is then remembered)')
  }
  const target =
    req.mode === 'youtube' ? youtubeTarget(key) : fileTarget(req.filePath || join(app.getPath('videos'), 'prestreamer-test.mkv'))
  await streamer.start(() => screens.lastFrame(cfg.id), target, key, audio.live ? audio.port : 0, (t) => audio.armSync(t))
}

ipcMain.handle(IPC.getState, () => screens.getState())
ipcMain.handle(IPC.addVirtual, (_e, name: string, w: number, h: number) => screens.addVirtual(name, w, h))
ipcMain.handle(IPC.updateScreen, (_e, id: string, patch: Partial<ScreenConfig>) => screens.update(id, patch))
ipcMain.handle(IPC.removeScreen, (_e, id: string) => screens.remove(id))
ipcMain.handle(IPC.setLive, (_e, id: string, live: boolean) => screens.setLive(id, live))
ipcMain.handle(IPC.showSlide, (_e, slide: Slide | null) => presentSlide(slide))
ipcMain.handle(IPC.playbackCommand, (_e, cmd: PlaybackCommand) => playback.command(cmd))
ipcMain.handle(IPC.playbackGet, () => playback.get())
ipcMain.on(IPC.playbackReport, (_e, id: string, pos: number) => screens.report(id, pos))
ipcMain.handle(IPC.videoImport, () => pickVideo(operator, (pct) => operator?.webContents.send(IPC.videoProgress, pct)))
ipcMain.handle(IPC.outputInit, (_e, id: string) => screens.payloadFor(id))
ipcMain.handle(IPC.streamStart, (_e, req: StreamStartRequest) => startStream(req))
ipcMain.handle(IPC.streamStop, () => streamer.stop())
ipcMain.handle(IPC.streamGetStatus, () => streamer.getStatus())
ipcMain.handle(IPC.songsList, () => songStore.list())
ipcMain.handle(IPC.songsSave, (_e, song: Song) => songStore.save(song))
ipcMain.handle(IPC.songsDelete, (_e, id: string) => songStore.remove(id))
ipcMain.handle(IPC.servicesList, () => serviceStore.list())
ipcMain.handle(IPC.servicesSave, (_e, svc: Service) => serviceStore.save(svc))
ipcMain.handle(IPC.servicesDelete, (_e, id: string) => serviceStore.remove(id))
ipcMain.handle(IPC.mediaImport, (_e, kind: MediaKind) => pickMedia(operator, kind))
ipcMain.handle(IPC.streamKeyState, () => streamKey.has())
ipcMain.handle(IPC.streamKeyForget, () => streamKey.forget())
ipcMain.handle(AUDIO_IPC.configure, (_e, cfg: AudioConfig) => audio.configure(cfg))
ipcMain.handle(AUDIO_IPC.getStatus, () => audio.getStatus())
ipcMain.handle(AUDIO_IPC.mixerGet, () => audio.getMixer())
ipcMain.handle(AUDIO_IPC.mixerSet, (_e, m: unknown) => audio.setMixer(m))

app.whenReady().then(() => {
  setBundledToolsEnabled(app.isPackaged)
  protocol.handle(MEDIA_SCHEME, (req) => serveMedia(req))
  songStore.load()
  serviceStore.load()
  // Only local app pages exist, so the one permission we grant is camera/mic (ATEM, mixer).
  session.defaultSession.setPermissionRequestHandler((_wc, permission, cb) => cb(permission === 'media'))
  session.defaultSession.setPermissionCheckHandler((_wc, permission) => permission === 'media')

  screens = new ScreenManager(
    (state) => operator?.webContents.send(IPC.stateChanged, state),
    // Frames are pulled by the streamer via lastFrame(); NDI sinks can subscribe here later.
    () => {},
  )
  playback = new Playback((state) => {
    screens.setPlayback(state)
    operator?.webContents.send(IPC.playbackState, state)
  })
  streamer = new Streamer((status) => operator?.webContents.send(IPC.streamStatus, status))
  audio = new AudioBridge(
    (status) => operator?.webContents.send(AUDIO_IPC.status, status),
    (meters) => operator?.webContents.send(AUDIO_IPC.metersOut, meters),
  )
  void audio.init()

  // Seed screens: one display-bound "Audience" and one virtual "Stream".
  // The audience screen plays the sound of video cues (point its output at the mixer's USB return).
  const audience = screens.addDisplayScreen('Audience', null)
  screens.update(audience.id, { look: { ...audience.look, videoAudio: true } })
  screens.addVirtual('Stream', 1920, 1080)
  createOperator()

  runDevHooks({ screens, streamer, audio, playback, operator: () => operator, startStream, presentSlide })
})

app.on('window-all-closed', () => app.quit())
