import { app, BrowserWindow, dialog, ipcMain, Menu, protocol, session } from 'electron'
import { homedir } from 'node:os'
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { AUDIO_IPC, IPC, type PlaybackCommand, MEDIA_SCHEME, type AudioConfig, type MediaKind, type ScreenConfig, type Service, type Slide, type Song, type StreamStartRequest } from '../shared/types'
import { deleteFromLibrary, listLibrary, pickMedia, pickPictures, serveMedia } from './library'
import { ListStore, writeJsonAtomic } from './store'
import { streamKey } from './secrets'
import { SEED_QUICK_MESSAGES, sanitizeAnnounceRequest, sanitizeQuickMessage, type QuickMessage } from '../shared/announce'
import { defaultScreens } from '../shared/screens'
import { SEED_SERVICES, SEED_SONGS } from '../shared/songs'
import { ScreenManager } from './screens'
import { NdiOutputs } from './ndi'
import { AudioBridge } from './audio'
import { defaultStreamSettings, sanitizeStreamSettings, type StreamSettings } from '../shared/stream-settings'
import { BibleStore, autoImportFromQuelea, findBibleFiles, queleaBibleFolders } from './bibles'
import { Playback } from './playback'
import { readFileSync } from 'node:fs'
import { setBundledToolsEnabled } from './tools'
import { pickVideo } from './video'
import { pickPresentation } from './presentations'
import { runDevHooks } from './devhooks'
import { exportSongs, pickSongsZip, songsFromZip } from './song-import'
import { defaultSession, fitBounds, safeToRestore, sanitizeSession, type Session } from '../shared/session'
import { defaultAppearance, forgetAppearanceMedia, sanitizeAppearance, type Appearance } from '../shared/appearance'
import { AtemController, realAtemClient } from './atem'
import { defaultAtemSettings, sanitizeAtemButtons, sanitizeAtemSettings, type AtemCommand } from '../shared/atem'
import { Streamer, fileTarget, youtubeTarget } from './streamer'

app.setName('PreStreamer')
const APP_ICON = join(__dirname, '..', '..', 'build', 'icon.png')
// Data stays in the folder named "prestreamer" (what earlier versions used), whatever the display name is, so
// renaming the app does not hide existing songs and settings. Tests and CI point PRESTREAMER_USER_DATA at a scratch
// folder so they never touch real data. Resolved first: Chromium aborts without a message on a path containing "..".
app.setPath('userData', process.env.PRESTREAMER_USER_DATA ? resolve(process.env.PRESTREAMER_USER_DATA) : join(app.getPath('appData'), 'prestreamer'))

// Must run before app ready. 'stream' lets <video> seek/loop via range requests.
protocol.registerSchemesAsPrivileged([
  // corsEnabled: the mixer's audio window plays video soundtracks from here, and the browser delivers silence unless CORS allows it
  { scheme: MEDIA_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true } },
])

let operator: BrowserWindow | null = null
const userData = () => app.getPath('userData')
const songStore = new ListStore<Song>('songs.json', SEED_SONGS, userData)
const serviceStore = new ListStore<Service>('services.json', SEED_SERVICES, userData)
const screenStore = new ListStore<ScreenConfig>('screens.json', defaultScreens(), userData)
const quickStore = new ListStore<QuickMessage>('announcements.json', SEED_QUICK_MESSAGES, userData)
const bibleStore = new BibleStore(() => join(userData(), 'bibles'))

// Linux. Output windows must land on a particular display, which a Wayland client may not ask for, so under a Wayland session
// the app runs through XWayland (set PRESTREAMER_NATIVE_WAYLAND=1 to opt out). An AppImage cannot carry a root-owned
// chrome-sandbox, and Ubuntu 24.04 blocks the unprivileged-namespace fallback, so it starts without the Chromium sandbox
// (it only ever loads its own pages and local media); the .deb keeps the sandbox.
if (process.platform === 'linux') {
  if (process.env.XDG_SESSION_TYPE === 'wayland' && process.env.DISPLAY && !process.env.PRESTREAMER_NATIVE_WAYLAND) app.commandLine.appendSwitch('ozone-platform', 'x11')
  if (process.env.APPIMAGE) app.commandLine.appendSwitch('no-sandbox')
}

// Created in whenReady: Electron's `screen` module is unusable before then.
let screens: ScreenManager
let ndiOutputs: NdiOutputs | undefined
let streamer: Streamer
let audio: AudioBridge
let playback: Playback
let atem: AtemController

// App-wide look: the song and scripture backgrounds and the logo (appearance.json).
const appearancePath = () => join(userData(), 'appearance.json')
let appearance: Appearance = defaultAppearance
function loadAppearance(): void {
  try { appearance = sanitizeAppearance(JSON.parse(readFileSync(appearancePath(), 'utf8'))) } catch { appearance = defaultAppearance }
}
function setAppearance(next: Appearance): Appearance {
  appearance = next
  writeJsonAtomic(appearancePath(), appearance)
  operator?.webContents.send(IPC.appearanceChanged, appearance)
  return appearance
}

const streamSettingsPath = () => join(userData(), 'stream-settings.json')
let streamSettings: StreamSettings = defaultStreamSettings

/** Settings saved last time (validated), then PRESTREAMER_STREAM_SETTINGS, a test knob that overrides them. */
function loadStreamSettings(): void {
  try {
    streamSettings = sanitizeStreamSettings(JSON.parse(readFileSync(streamSettingsPath(), 'utf8')))
  } catch {
    streamSettings = defaultStreamSettings
  }
  if (process.env.PRESTREAMER_STREAM_SETTINGS) streamSettings = sanitizeStreamSettings(JSON.parse(process.env.PRESTREAMER_STREAM_SETTINGS))
}

// --- Remembering how the app was left: window position and open screens -----------------------------------------------------
const sessionPath = () => join(userData(), 'session.json')
let sessionState: Session = defaultSession()
let quitting = false
let sessionTimer: ReturnType<typeof setTimeout> | null = null

function loadSession(): void {
  try { sessionState = sanitizeSession(JSON.parse(readFileSync(sessionPath(), 'utf8'))) } catch { sessionState = defaultSession() }
}
/** Saved shortly after a change (dragging a window fires many events). Not while quitting: closing the screens must not forget them. */
function saveSessionSoon(): void {
  if (quitting) return
  if (sessionTimer) clearTimeout(sessionTimer)
  sessionTimer = setTimeout(() => { try { writeJsonAtomic(sessionPath(), sessionState) } catch { /* remembering is a convenience */ } }, 400)
}
function rememberWindow(win: BrowserWindow): void {
  const note = () => {
    if (win.isDestroyed() || quitting || win.isMinimized() || win.isFullScreen()) return
    sessionState.maximized = win.isMaximized()
    if (!sessionState.maximized) sessionState.bounds = win.getBounds()
    saveSessionSoon()
  }
  win.on('resize', note)
  win.on('move', note)
  win.on('maximize', note)
  win.on('unmaximize', note)
}
/** Opens the screens that were open last time, except those that would cover the controls. Never starts a stream. */
function restoreScreens(): void {
  const { screens: all, displays } = screens.getState()
  for (const id of sessionState.liveScreens) {
    const cfg = all.find((s) => s.id === id)
    if (cfg && safeToRestore(cfg, displays)) screens.setLive(id, true)
  }
}

function createOperator(): void {
  loadSession()
  const bounds = fitBounds(sessionState.bounds, screens.getState().displays)
  operator = new BrowserWindow({
    width: bounds?.width ?? 1400,
    height: bounds?.height ?? 860,
    ...(bounds ? { x: bounds.x, y: bounds.y } : {}),
    title: 'PreStreamer',
    // Window/taskbar icon for Windows and Linux when running from source (installers carry the icon in the executable).
    ...(existsSync(APP_ICON) ? { icon: APP_ICON } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      sandbox: true,
    },
  })
  if (sessionState.maximized) operator.maximize()
  rememberWindow(operator)
  operator.loadFile(join(__dirname, '../renderer/operator.html'))
  operator.on('closed', async () => {
    quitting = true
    operator = null
    await streamer.stop()
    await atem.stop()
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

  // PRESTREAMER_RTMP_URL points the stream at a local RTMP server (the end-to-end tests run one), never at YouTube.
  const testServer = process.env.PRESTREAMER_RTMP_URL
  let key = ''
  if (req.mode === 'youtube' && !testServer) {
    // A typed key is remembered (encrypted); otherwise the saved one is used.
    const typed = req.streamKey?.trim()
    if (typed) streamKey.save(typed)
    key = typed || streamKey.load() || ''
    if (!key) throw new Error('No stream key yet: add it in Settings → Stream, under Destination')
  }
  const target = testServer
    ? { url: testServer, format: 'flv' as const, label: 'Local RTMP server (test)' }
    : req.mode === 'youtube'
      ? youtubeTarget(key)
      : fileTarget(req.filePath || join(app.getPath('videos'), `PreStreamer ${new Date().toISOString().slice(0, 16).replace('T', ' ').replace(':', '-')}.mkv`))
  // Always the mixer's port: it carries silence while the mixer is off, so the mixer can be started at any time.
  const settings = streamSettings // fixed for the whole stream, whatever is edited meanwhile
  screens.setVirtualFrameRate(settings.fps)
  await streamer.start(() => screens.lastFrame(cfg.id), target, key, req.audio === 'none' ? 0 : audio.port, (t) => audio.armSync(t), settings)
}

ipcMain.handle(IPC.getState, () => screens.getState())
ipcMain.handle(IPC.addVirtual, (_e, name: string, w: number, h: number) => screens.addVirtual(name, w, h))
ipcMain.handle(IPC.addNdiScreen, (_e, name: string, opts?: { width?: number; height?: number; stage?: boolean; mirrorOf?: string }) => screens.addNdiScreen(String(name), { width: Number(opts?.width) || undefined, height: Number(opts?.height) || undefined, stage: opts?.stage === true, mirrorOf: typeof opts?.mirrorOf === 'string' ? opts.mirrorOf : undefined }))
ipcMain.handle(IPC.addDisplayScreen, (_e, name: string, opts?: { stage?: boolean; mirrorOf?: string }) => screens.addDisplayScreen(name, null, { stage: opts?.stage === true, mirrorOf: typeof opts?.mirrorOf === 'string' ? opts.mirrorOf : undefined }))
ipcMain.handle(IPC.updateScreen, (_e, id: string, patch: Partial<ScreenConfig>) => screens.update(id, patch))
ipcMain.handle(IPC.removeScreen, (_e, id: string) => screens.remove(id))
ipcMain.handle(IPC.identifyDisplays, () => screens.identifyDisplays())
ipcMain.handle(IPC.reorderScreen, (_e, id: string, target: string, after: boolean) => screens.reorder(String(id), String(target), after === true))
ipcMain.handle(IPC.moveScreen, (_e, id: string, delta: number) => screens.move(id, delta < 0 ? -1 : 1))
ipcMain.handle(IPC.setLive, (_e, id: string, live: boolean) => screens.setLive(id, live))
ipcMain.handle(IPC.showSlide, (_e, slide: Slide | null) => presentSlide(slide))
ipcMain.handle(IPC.clearScreen, (_e, id: string, blank: boolean) => screens.setBlank(id, blank === true))
ipcMain.handle(IPC.playbackCommand, (_e, cmd: PlaybackCommand) => playback.command(cmd))
ipcMain.handle(IPC.playbackGet, () => playback.get())
ipcMain.on(IPC.playbackReport, (_e, id: string, pos: number) => screens.report(id, pos))
ipcMain.handle(IPC.presentationImport, () => pickPresentation(operator, (msg) => operator?.webContents.send(IPC.presentationStatus, msg)))
ipcMain.handle(IPC.videoImport, () => pickVideo(operator, (pct) => operator?.webContents.send(IPC.videoProgress, pct)))
ipcMain.handle(IPC.outputInit, (_e, id: string) => screens.payloadFor(id))
ipcMain.handle(IPC.streamStart, (_e, req: StreamStartRequest) => startStream(req))
ipcMain.handle(IPC.streamStop, () => streamer.stop())
ipcMain.handle(IPC.streamGetStatus, () => streamer.getStatus())
ipcMain.handle(IPC.streamSettingsGet, () => streamSettings)
ipcMain.handle(IPC.streamSettingsSet, (_e, raw: unknown) => {
  streamSettings = sanitizeStreamSettings(raw)
  writeJsonAtomic(streamSettingsPath(), streamSettings)
  return streamSettings
})
ipcMain.handle(IPC.songsList, () => songStore.list())
ipcMain.handle(IPC.songsSave, (_e, song: Song) => songStore.save(song))
ipcMain.handle(IPC.songsDelete, (_e, id: string) => songStore.remove(id))
ipcMain.handle(IPC.songsExport, () => exportSongs(operator, songStore.list(), app.getPath('documents')))
ipcMain.handle(IPC.songsClear, () => { songStore.replaceAll([]); return songStore.list() })
ipcMain.handle(IPC.songsImport, async () => {
  const path = await pickSongsZip(operator, app.getPath('downloads'))
  if (!path) return null
  const { songs, result } = await songsFromZip(path, songStore.list())
  if (songs.length) songStore.replaceAll([...songStore.list(), ...songs])
  return { songs: songStore.list(), result }
})
ipcMain.handle(IPC.servicesList, () => serviceStore.list())
ipcMain.handle(IPC.servicesSave, (_e, svc: Service) => serviceStore.save(svc))
ipcMain.handle(IPC.servicesDelete, (_e, id: string) => serviceStore.remove(id))
ipcMain.handle(IPC.announceShow, (_e, raw: unknown) => {
  const req = sanitizeAnnounceRequest(raw)
  if (!req) return false // nothing to show
  screens.showAnnouncement(req)
  return true
})
ipcMain.handle(IPC.announceClear, () => screens.clearAnnouncement())
ipcMain.handle(IPC.setNextSlide, (_e, slide: Slide | null) => screens.setNextSlide(slide ?? null))
ipcMain.handle(IPC.setCameraOnly, (_e, on: unknown) => screens.setCameraOnly(on === true))
const quickList = (): QuickMessage[] => quickStore.list().map(sanitizeQuickMessage).filter((q): q is QuickMessage => q !== null)
ipcMain.handle(IPC.announceQuickList, () => quickList())
ipcMain.handle(IPC.announceQuickSave, (_e, raw: unknown) => {
  const q = sanitizeQuickMessage(raw)
  if (q) quickStore.save(q)
  return quickList()
})
ipcMain.handle(IPC.announceQuickDelete, (_e, id: string) => { quickStore.remove(id); return quickList() })
ipcMain.handle(IPC.bibleList, () => bibleStore.list())
ipcMain.handle(IPC.bibleChapter, (_e, id: string, book: number, chapter: number) => bibleStore.chapter(id, book, chapter))
ipcMain.handle(IPC.bibleRemove, (_e, id: string) => { bibleStore.remove(id); return bibleStore.list() })
ipcMain.handle(IPC.bibleImportPaths, (_e, paths: string[]) => paths.map((p) => bibleStore.importFile(p)))
ipcMain.handle(IPC.bibleImportDialog, async () => {
  const options: Electron.OpenDialogOptions = { title: 'Choose Bible files (Zefania XML)', properties: ['openFile', 'multiSelections'], filters: [{ name: 'Zefania XML Bible', extensions: ['xml'] }] }
  const result = operator ? await dialog.showOpenDialog(operator, options) : await dialog.showOpenDialog(options)
  return result.canceled ? [] : result.filePaths.map((p) => bibleStore.importFile(p))
})
ipcMain.handle(IPC.bibleImportQuelea, () => {
  const { folders, files } = findBibleFiles(queleaBibleFolders(homedir(), process.platform))
  return { folders, results: files.map((f) => bibleStore.importFile(f)) }
})
ipcMain.handle(IPC.mediaImport, (_e, kind: MediaKind) => pickMedia(operator, kind))
ipcMain.handle(IPC.mediaList, () => listLibrary())
ipcMain.handle(IPC.mediaRemove, (_e, file: string) => {
  const removed = deleteFromLibrary(file)
  if (removed) {
    screens.forgetBackgroundMedia(file) // a screen that used it goes back to its colour
    const next = forgetAppearanceMedia(appearance, file)
    if (next !== appearance) setAppearance(next)
  }
  return removed
})
ipcMain.handle(IPC.picturesImport, () => pickPictures(operator))
ipcMain.handle(IPC.appearanceGet, () => appearance)
ipcMain.handle(IPC.appearanceSet, (_e, raw: unknown) => setAppearance(sanitizeAppearance(raw)))
ipcMain.handle(IPC.atemGet, () => atem.getStatus())
ipcMain.handle(IPC.atemSetAddress, (_e, address: unknown) => atem.setAddress(address))
ipcMain.handle(IPC.atemSend, (_e, cmd: AtemCommand) => atem.send(cmd))
ipcMain.handle(IPC.atemSetButtons, (_e, patch: unknown) => atem.setButtons(sanitizeAtemButtons({ ...atem.getSettings().buttons, ...(patch && typeof patch === 'object' ? patch : {}) })))
ipcMain.handle(IPC.streamKeyState, () => streamKey.has())
ipcMain.handle(IPC.streamKeyForget, () => streamKey.forget())
ipcMain.handle(IPC.streamKeySet, (_e, key: unknown) => { const k = typeof key === 'string' ? key.trim() : ''; if (k) streamKey.save(k) })
ipcMain.handle(AUDIO_IPC.configure, (_e, cfg: AudioConfig) => audio.configure(cfg))
ipcMain.handle(AUDIO_IPC.getStatus, () => audio.getStatus())
ipcMain.handle(AUDIO_IPC.mixerGet, () => audio.getMixer())
ipcMain.handle(AUDIO_IPC.mixerSet, (_e, m: unknown) => audio.setMixer(m))

app.whenReady().then(() => {
  setBundledToolsEnabled(app.isPackaged)
  // Running from source under a plain Electron bundle: at least the Dock picture is ours (the Dock's name comes from the bundle; `npm start` renames it).
  if (process.platform === 'darwin' && !app.isPackaged && existsSync(APP_ICON)) app.dock?.setIcon(APP_ICON)
  // Windows and Linux would show Electron's default menu bar (with Reload) in the operator window; macOS keeps its own menu.
  if (app.isPackaged && process.platform !== 'darwin') Menu.setApplicationMenu(null)
  protocol.handle(MEDIA_SCHEME, (req) => serveMedia(req))
  songStore.load()
  // Test and dev runs use their own data folder and must not pick up the real user's Quelea files.
  if (!process.env.PRESTREAMER_USER_DATA) autoImportFromQuelea(bibleStore, join(userData(), 'bibles-auto-import.json'), homedir(), process.platform)
  serviceStore.load()
  loadStreamSettings()
  loadAppearance()
  quickStore.load()
  // Only local app pages exist, so the one permission we grant is camera/mic (ATEM, mixer).
  session.defaultSession.setPermissionRequestHandler((_wc, permission, cb) => cb(permission === 'media'))
  session.defaultSession.setPermissionCheckHandler((_wc, permission) => permission === 'media')

  screens = new ScreenManager(
    (state) => {
      operator?.webContents.send(IPC.stateChanged, state)
      sessionState.liveScreens = state.live
      saveSessionSoon()
    },
    // Frames are pulled by the streamer and the NDI senders via lastFrame().
    () => {},
    screenStore,
  )
  ndiOutputs = new NdiOutputs((id, status) => screens.setNdiStatus(id, status))
  screens.setNdiOutputs(ndiOutputs)
  playback = new Playback((state) => {
    screens.setPlayback(state)
    audio.sendPlayback(state)
    operator?.webContents.send(IPC.playbackState, state)
  })
  streamer = new Streamer((status) => {
    screens.setStreamLive(status.state === 'running')
    operator?.webContents.send(IPC.streamStatus, status)
  })
  audio = new AudioBridge(
    (status) => operator?.webContents.send(AUDIO_IPC.status, status),
    (meters) => operator?.webContents.send(AUDIO_IPC.metersOut, meters),
  )
  audio.onPcm((pcm) => ndiOutputs?.audio('stream', pcm)) // NDI screens with the stream's sound
  audio.onVideoPcm((pcm) => ndiOutputs?.audio('video', pcm)) // ... or with the sound of the videos only
  void audio.init()
  const atemPath = join(userData(), 'atem.json')
  let atemSettings = defaultAtemSettings
  try { atemSettings = sanitizeAtemSettings(JSON.parse(readFileSync(atemPath, 'utf8'))) } catch { /* nothing saved yet */ }
  atem = new AtemController(
    (status) => operator?.webContents.send(IPC.atemState, status),
    realAtemClient,
    (next) => { try { writeJsonAtomic(atemPath, next) } catch { /* the address is a convenience */ } },
    atemSettings,
  )
  // Tests use a scratch data folder and must not send network packets to whatever sits at the default address.
  if (!process.env.PRESTREAMER_USER_DATA || process.env.PRESTREAMER_ATEM === '1') atem.start()

  createOperator()
  restoreScreens()

  runDevHooks({ screens, streamer, audio, playback, operator: () => operator, startStream, presentSlide })
})

app.on('before-quit', () => { quitting = true })
app.on('window-all-closed', () => app.quit())
