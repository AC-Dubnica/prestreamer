// A pretend Google/YouTube on a local port, for the end-to-end test and the screenshots of the YouTube pages
// (the app is pointed at it with PRESTREAMER_YOUTUBE_API). It knows one channel and two scheduled broadcasts, and moves a broadcast
// through ready -> testing -> live -> complete as the app asks. `log` lists the requests it got, for the checks.
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { fileURLToPath } from 'node:url'

export async function startFakeYoutube() {
  const log = []
  const next = (days, hour) => { const d = new Date(); d.setDate(d.getDate() + ((7 - d.getDay()) % 7 || 7) + days); d.setHours(hour, 0, 0, 0); return d.toISOString() }
  const broadcasts = [
    { id: 'sunday', title: 'Sunday service', scheduledStartTime: next(0, 10), life: 'ready', preview: true },
    { id: 'youth', title: 'Youth evening', scheduledStartTime: next(5, 18), life: 'ready', preview: false },
  ]
  let ingestPolls = 0
  const item = (b) => ({ id: b.id, snippet: { title: b.title, scheduledStartTime: b.scheduledStartTime }, status: { lifeCycleStatus: b.life, privacyStatus: 'unlisted' }, contentDetails: { boundStreamId: 'stream1', monitorStream: { enableMonitorStream: b.preview } } })
  const server = createServer((req, res) => {
    const u = new URL(req.url, 'http://x')
    const send = (body, status = 200) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)) }
    if (u.pathname !== '/__log') log.push(`${req.method} ${u.pathname}${u.search}`)
    req.on('data', () => {})
    req.on('end', () => {
      if (u.pathname === '/__log') return send({ log, broadcasts: broadcasts.map((b) => ({ id: b.id, life: b.life })) })
      if (u.pathname === '/token') return send({ access_token: 'fake-access', refresh_token: 'fake-refresh', expires_in: 3600 })
      if (u.pathname.endsWith('/channels')) return send({ items: [{ snippet: { title: 'AC Dubnica' } }] })
      if (u.pathname.endsWith('/liveBroadcasts/transition')) {
        const b = broadcasts.find((x) => x.id === u.searchParams.get('id'))
        const to = u.searchParams.get('broadcastStatus')
        if (b) b.life = to
        return send(b ? item(b) : {}, b ? 200 : 404)
      }
      if (u.pathname.endsWith('/liveBroadcasts')) {
        const id = u.searchParams.get('id')
        if (id) return send({ items: broadcasts.filter((b) => b.id === id).map(item) })
        const status = u.searchParams.get('broadcastStatus')
        const live = (b) => b.life === 'live' || b.life === 'testing'
        return send({ items: broadcasts.filter((b) => (status === 'active' ? b.life === 'live' : b.life !== 'live' && b.life !== 'complete')).map(item) })
      }
      if (u.pathname.endsWith('/liveStreams')) {
        ingestPolls++
        return send({ items: [{ cdn: { ingestionInfo: { ingestionAddress: 'rtmp://127.0.0.1:1/live2', streamName: 'fake-key' } }, status: { streamStatus: ingestPolls > 1 ? 'active' : 'inactive' } }] })
      }
      send({ error: { message: 'not found' } }, 404)
    })
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  return { url: `http://127.0.0.1:${server.address().port}`, log, broadcasts, close: () => server.close() }
}

/** The pretend server in a process of its own (the scripts start the app with spawnSync, which would stall a server in the same process). */
export async function launchFakeYoutube() {
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url)], { stdio: ['ignore', 'pipe', 'inherit'] })
  const url = await new Promise((resolve, reject) => {
    let text = ''
    child.stdout.on('data', (d) => { text += d; const m = /URL (\S+)/.exec(text); if (m) resolve(m[1]) })
    child.on('exit', () => reject(new Error('the pretend YouTube did not start')))
  })
  return { url, state: async () => (await fetch(`${url}/__log`)).json(), close: () => child.kill() }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const fake = await startFakeYoutube()
  console.log(`URL ${fake.url}`)
}
