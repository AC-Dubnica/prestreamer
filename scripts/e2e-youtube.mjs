// End-to-end check of running a scheduled YouTube broadcast from the app, against a pretend Google/YouTube (scripts/fake-youtube.mjs)
// and a local RTMP server (ffmpeg listening) instead of YouTube's ingest. Settings → YouTube (client, sign-in), the Present tab's panel
// (list, start and preview, go live, end) and what the pretend YouTube was asked. Needs a display and ffmpeg.
import { spawn, spawnSync } from 'node:child_process'
import { mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ensureElectron } from './electron-path.mjs'
import { launchFakeYoutube } from './fake-youtube.mjs'

const electronPath = await ensureElectron()
const ffmpeg = process.env.FFMPEG_PATH || 'ffmpeg'
const outDir = process.env.E2E_OUT_DIR || join(tmpdir(), 'prestreamer-e2e')
mkdirSync(outDir, { recursive: true })
const userData = join(outDir, 'userdata-youtube')
rmSync(userData, { recursive: true, force: true })

const fake = await launchFakeYoutube()
const rtmpUrl = 'rtmp://127.0.0.1:19350/live/yt'
const rtmp = spawn(ffmpeg, ['-hide_banner', '-loglevel', 'warning', '-y', '-listen', '1', '-i', rtmpUrl, '-c', 'copy', join(outDir, 'youtube-received.flv')], { stdio: 'ignore' })
await new Promise((r) => setTimeout(r, 1200))

const scenario = `(async () => {
  const w = (ms) => new Promise((r) => setTimeout(r, ms))
  const q = (sel, root = document) => root.querySelector(sel)
  const qa = (sel, root = document) => [...root.querySelectorAll(sel)]
  const tab = (n) => qa('#tabs button').find((b) => b.textContent.trim() === n)
  const until = async (fn, ms = 40000) => { for (let t = 0; t < ms; t += 400) { if (await fn()) return true; await w(400) } return false }
  const r = {}
  await w(800)
  r.before = await prestreamer.youtubeGet()
  r.panelHiddenBefore = q('.ytpanel').hidden === true

  // Settings → YouTube: the client, then the sign-in
  tab('Settings').click(); await w(500)
  qa('#view-settings .setnav button').find((b) => b.textContent.trim() === 'YouTube').click(); await w(500)
  const fields = qa('#view-settings input[type=text], #view-settings input[type=password]')
  r.fields = fields.length
  r.signInDisabled = qa('#view-settings button').find((b) => b.textContent.includes('Sign in with Google')).disabled
  await prestreamer.youtubeSetClient({ clientId: 'client-id', clientSecret: 'client-secret' }); await w(500)
  const signIn = qa('#view-settings button').find((b) => b.textContent.includes('Sign in with Google'))
  r.signInEnabled = !signIn.disabled
  signIn.click()
  r.signedIn = await until(async () => (await prestreamer.youtubeGet()).signedIn, 8000)
  await w(500)
  r.pageText = q('#view-settings .setbody').textContent
  r.signOutButton = !!qa('#view-settings button').find((b) => b.textContent.trim() === 'Sign out')

  // The Present tab: the broadcasts take the place of the plain Start button
  tab('Present').click(); await w(600)
  const st = await prestreamer.youtubeGet()
  r.list = st.broadcasts.map((b) => b.title)
  r.selected = st.selected
  r.panelShown = q('.ytpanel').hidden === false
  r.options = qa('.ytpanel select option').map((o) => o.textContent)
  r.plainStartHidden = qa('.streamgo').find((e) => !e.closest('.ytpanel')).hidden === true
  r.startLabel = qa('.ytpanel button').map((b) => b.textContent.trim())

  // Start: the stream goes out and the preview opens
  const screen = (await prestreamer.getState()).screens.find((s) => s.kind === 'virtual')
  prestreamer.youtubeCommand({ type: 'start', screenId: screen.id })
  r.preview = await until(async () => (await prestreamer.youtubeGet()).phase === 'preview')
  await w(500)
  r.previewButtons = qa('.ytpanel button').map((b) => b.textContent.trim()).filter((t) => t !== '↻')
  r.streaming = (await prestreamer.youtubeGet()).streaming
  r.streamStatus = (await prestreamer.streamGetStatus()).state

  // Go live, then end (the end is asked about first)
  qa('.ytpanel button').find((b) => b.textContent.trim() === 'Go live').click()
  r.live = await until(async () => (await prestreamer.youtubeGet()).phase === 'live')
  await w(500)
  r.liveButtons = qa('.ytpanel button').map((b) => b.textContent.trim()).filter((t) => t !== '↻')
  qa('.ytpanel button').find((b) => b.textContent.trim() === 'End stream').click(); await w(500)
  const dlg = q('#modal:not([hidden]) .dialog')
  r.askText = dlg ? dlg.textContent : ''
  qa('button', dlg).find((b) => b.textContent.trim() === 'Cancel')?.click(); await w(400)
  r.stillLive = (await prestreamer.youtubeGet()).phase === 'live'
  qa('.ytpanel button').find((b) => b.textContent.trim() === 'End stream').click(); await w(500)
  qa('button', q('#modal:not([hidden]) .dialog')).find((b) => b.textContent.trim() === 'End stream').click()
  r.ended = await until(async () => { const s = await prestreamer.youtubeGet(); return !s.streaming && !s.broadcasts.some((b) => b.id === 'sunday' && b.lifeCycle === 'live') }, 20000)
  r.streamStatusAfter = (await prestreamer.streamGetStatus()).state
  return r
})()`

const run = spawnSync(electronPath, ['.'], {
  env: {
    ...process.env, PRESTREAMER_USER_DATA: userData, PRESTREAMER_YOUTUBE_API: fake.url, PRESTREAMER_RTMP_URL: rtmpUrl,
    PRESTREAMER_STREAM_SETTINGS: JSON.stringify({ mode: 'youtube', width: 1280, height: 720, fps: 30, videoKbps: 2000 }),
    PRESTREAMER_SNAPSHOT: join(outDir, 'youtube.png'), PRESTREAMER_EVAL: scenario,
  },
  encoding: 'utf8',
  timeout: 150_000,
})
rtmp.kill()
const seen = await fake.state()
fake.close()
const line = /^EVAL (.*)$/m.exec(run.stdout ?? '')
if (!line) {
  console.error('The YouTube scenario did not report a result.', run.status, (run.stderr || '').slice(-600), (run.stdout || '').slice(-600))
  process.exit(1)
}
const r = JSON.parse(line[1])
const log = seen.log
const j = JSON.stringify
const checks = [
  ['before signing in the panel is hidden and nothing is signed in', r.panelHiddenBefore && r.before.signedIn === false && r.before.configured === false, j([r.panelHiddenBefore, r.before.signedIn])],
  ['Settings → YouTube has the client fields, and signing in needs them first', r.fields === 2 && r.signInDisabled && r.signInEnabled, j([r.fields, r.signInDisabled, r.signInEnabled])],
  ['signing in works and the page names the channel', r.signedIn && /Signed in: AC Dubnica/.test(r.pageText) && r.signOutButton, r.pageText.slice(0, 120)],
  ['the secret is not sent back to the page', !/client-secret/.test(r.pageText) && !log.some((l) => /client-secret/.test(l)), ''],
  ['the Present tab lists the scheduled broadcasts, soonest first, and picks the first', j(r.list) === j(['Sunday service', 'Youth evening']) && r.selected === 'sunday' && r.options.length === 2, j([r.list, r.selected])],
  ['the panel replaces the plain Start button', r.panelShown && r.plainStartHidden && r.startLabel.includes('Start and open preview'), j(r.startLabel)],
  ['Start sends the stream and opens the preview (testing) once YouTube receives it', r.preview && r.streaming && r.streamStatus === 'running' && log.some((l) => /transition.*broadcastStatus=testing/.test(l)), j([r.preview, r.streamStatus])],
  ['in the preview the buttons are Go live and Stop sending', j(r.previewButtons) === j(['Go live', 'Stop sending']), j(r.previewButtons)],
  ['Go live moves the broadcast to live, and only then', r.live && log.some((l) => /transition.*broadcastStatus=live/.test(l)) && log.findIndex((l) => /broadcastStatus=live/.test(l)) > log.findIndex((l) => /broadcastStatus=testing/.test(l)), j(r.liveButtons)],
  ['live, the one button is End stream', j(r.liveButtons) === j(['End stream']), j(r.liveButtons)],
  ['End stream asks first, and Cancel leaves it live', /for good/i.test(r.askText) && r.stillLive, r.askText.slice(0, 100)],
  ['confirming ends the broadcast on YouTube and stops the stream', r.ended && log.some((l) => /transition.*broadcastStatus=complete/.test(l)) && r.streamStatusAfter !== 'running', j([r.ended, r.streamStatusAfter])],
  ['the stream key never reaches the page', !JSON.stringify(r).includes('fake-key'), ''],
]
let failed = 0
for (const [name, ok, detail] of checks) {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`)
}
console.log(`\n${checks.length - failed}/${checks.length} YouTube checks passed`)
process.exit(failed ? 1 : 0)
