import { describe, expect, it } from 'vitest'
import { YoutubeController, type YoutubeDeps } from '../src/main/youtube'
import { authUrl, broadcastLabel, parseBroadcasts, parseIngest, youtubeCan, youtubeErrorMessage, youtubePhase, type YoutubeStatus } from '../src/shared/youtube'

const broadcast = (id: string, life: string, extra: Record<string, unknown> = {}) => ({
  id, snippet: { title: `Show ${id}`, scheduledStartTime: '2026-11-15T09:00:00Z' }, status: { lifeCycleStatus: life, privacyStatus: 'public' },
  contentDetails: { boundStreamId: 'str1', monitorStream: { enableMonitorStream: true } }, ...extra,
})

/** A pretend YouTube: one broadcast moving through its life as the controller asks, one stream that turns active once frames arrive. */
function fakeYoutube(opts: { life?: string; preview?: boolean; refuseTesting?: boolean; streamActiveAfterStart?: boolean } = {}) {
  const calls: string[] = []
  const state = { offline: false, onSleep: null as null | (() => void), life: opts.life ?? 'ready', sending: false, refreshToken: null as string | null, stopped: 0, started: [] as { address: string; key: string }[] }
  const deps: YoutubeDeps = {
    async fetch(url, init) {
      if (state.offline) throw new TypeError('fetch failed')
      const u = new URL(url)
      const path = u.pathname.replace('/youtube/v3/', '')
      calls.push(`${init?.method ?? 'GET'} ${path}${u.search ? '?' + u.searchParams.toString() : ''}`)
      const json = (body: unknown, status = 200) => ({ ok: status < 400, status, json: async () => body })
      if (u.host === 'oauth2.googleapis.com') {
        const form = new URLSearchParams(init?.body)
        if (form.get('grant_type') === 'authorization_code') return json({ access_token: 'acc', refresh_token: 'ref', expires_in: 3600 })
        return form.get('refresh_token') === 'ref' ? json({ access_token: 'acc2', expires_in: 3600 }) : json({ error: 'invalid_grant' }, 400)
      }
      if (path.startsWith('channels')) return json({ items: [{ snippet: { title: 'Our Church' } }] })
      if (path === 'liveBroadcasts/transition') {
        const to = u.searchParams.get('broadcastStatus')
        if (to === 'testing' && opts.refuseTesting) return json({ error: { message: 'no', errors: [{ reason: 'invalidTransition' }] } }, 403)
        state.life = to === 'testing' ? 'testing' : to === 'live' ? 'live' : 'complete'
        return json({})
      }
      if (path.startsWith('liveBroadcasts')) {
        const status = u.searchParams.get('broadcastStatus')
        const mine = broadcast('b1', state.life, { contentDetails: { boundStreamId: 'str1', monitorStream: { enableMonitorStream: opts.preview !== false } } })
        if (status === 'upcoming') return json({ items: state.life === 'live' || state.life === 'complete' ? [] : [mine] })
        if (status === 'active') return json({ items: state.life === 'live' ? [mine] : [] })
        return json({ items: [mine] })
      }
      if (path.startsWith('liveStreams')) return json({ items: [{ cdn: { ingestionInfo: { ingestionAddress: 'rtmp://a.rtmp.youtube.com/live2', streamName: 'SECRET-KEY' } }, status: { streamStatus: state.sending ? 'active' : 'inactive' } }] })
      return json({}, 404)
    },
    async authorize() { return { code: 'c', redirectUri: 'http://127.0.0.1:1', verifier: 'v' } },
    loadRefreshToken: () => state.refreshToken,
    saveRefreshToken: (t) => { state.refreshToken = t },
    async startStream(ingest) { state.started.push(ingest); state.sending = true },
    async stopStream() { state.sending = false; state.stopped++ },
    isStreaming: () => state.sending,
    sleep: async () => { clock += 2000; state.onSleep?.() },
    now: () => clock,
    unavailable: () => '',
  }
  let clock = 1_000_000
  const seen: YoutubeStatus[] = []
  const controller = new YoutubeController((s) => seen.push(s), deps, () => {}, { clientId: 'id', clientSecret: 'secret' })
  return { controller, state, calls, seen, deps, advance: (ms: number) => { clock += ms } }
}

describe('YouTube broadcasts', () => {
  it('signs in, shows the channel and lists the scheduled broadcast', async () => {
    const { controller, state } = fakeYoutube()
    const s = await controller.command({ type: 'signIn' })
    expect(state.refreshToken).toBe('ref')
    expect(s.signedIn).toBe(true)
    expect(s.account).toBe('Our Church')
    expect(s.broadcasts.map((b) => b.id)).toEqual(['b1'])
    expect(s.selected).toBe('b1')
    expect(s.phase).toBe('idle')
    expect(s.can).toEqual({ start: true, goLive: false, stop: false, end: false })
  })

  it('starts the stream with the key from YouTube, then opens the preview', async () => {
    const { controller, state, calls } = fakeYoutube()
    await controller.command({ type: 'signIn' })
    const s = await controller.command({ type: 'start', screenId: 'v1' })
    expect(state.started).toEqual([{ address: 'rtmp://a.rtmp.youtube.com/live2', key: 'SECRET-KEY', active: false }])
    expect(calls.some((c) => c.startsWith('POST liveBroadcasts/transition') && c.includes('broadcastStatus=testing'))).toBe(true)
    expect(s.phase).toBe('preview')
    expect(s.can).toEqual({ start: false, goLive: true, stop: true, end: false })
  })

  it('goes live only when asked, and ends the broadcast and the stream', async () => {
    const { controller, state, calls } = fakeYoutube()
    await controller.command({ type: 'signIn' })
    await controller.command({ type: 'start', screenId: 'v1' })
    expect(calls.some((c) => c.includes('broadcastStatus=live'))).toBe(false)
    let s = await controller.command({ type: 'goLive' })
    expect(s.phase).toBe('live')
    expect(s.can.end).toBe(true)
    s = await controller.command({ type: 'end' })
    expect(calls.some((c) => c.includes('broadcastStatus=complete'))).toBe(true)
    expect(state.sending).toBe(false)
    expect(s.phase).not.toBe('live')
  })

  it('skips the preview for a broadcast that has none and offers going live at once', async () => {
    const { controller, calls } = fakeYoutube({ preview: false })
    await controller.command({ type: 'signIn' })
    const s = await controller.command({ type: 'start', screenId: 'v1' })
    expect(calls.some((c) => c.includes('broadcastStatus=testing'))).toBe(false)
    expect(s.phase).toBe('ready')
    expect(s.can.goLive).toBe(true)
  })

  it('still lets you go live when YouTube refuses the preview', async () => {
    const { controller } = fakeYoutube({ refuseTesting: true })
    await controller.command({ type: 'signIn' })
    const s = await controller.command({ type: 'start', screenId: 'v1' })
    expect(s.phase).toBe('ready')
    expect(s.message).toMatch(/preview could not be opened/i)
  })

  it('stopping the stream during the preview leaves the broadcast in preview', async () => {
    const { controller } = fakeYoutube()
    await controller.command({ type: 'signIn' })
    await controller.command({ type: 'start', screenId: 'v1' })
    const s = await controller.command({ type: 'stop' })
    expect(s.streaming).toBe(false)
    expect(s.broadcasts[0].lifeCycle).toBe('testing')
    expect(s.can.start).toBe(true) // picks the preview up again
  })

  it('reconnects a live broadcast whose stream dropped, without a second transition', async () => {
    const { controller, state, calls } = fakeYoutube({ life: 'live' })
    await controller.command({ type: 'signIn' })
    state.sending = false
    const s = await controller.command({ type: 'start', screenId: 'v1' })
    expect(state.started).toHaveLength(1)
    expect(calls.filter((c) => c.includes('transition'))).toHaveLength(0)
    expect(s.phase).toBe('live')
  })

  it('never keeps the stream key', async () => {
    const { controller, seen } = fakeYoutube()
    await controller.command({ type: 'signIn' })
    await controller.command({ type: 'start', screenId: 'v1' })
    expect(JSON.stringify(seen)).not.toContain('SECRET-KEY')
  })

  it('reports a broadcast with no stream bound', async () => {
    const { controller, deps } = fakeYoutube()
    const inner = deps.fetch
    deps.fetch = async (url, init) => {
      const r = await inner(url, init)
      if (!url.includes('liveBroadcasts?') && !url.includes('id=b1')) return r
      return { ok: r.ok, status: r.status, json: async () => { const j = (await r.json()) as { items?: { contentDetails?: { boundStreamId?: string } }[] }; j.items?.forEach((i) => { if (i.contentDetails) i.contentDetails.boundStreamId = '' }); return j } }
    }
    await controller.command({ type: 'signIn' })
    const s = await controller.command({ type: 'start', screenId: 'v1' })
    expect(s.phase).toBe('error')
    expect(s.message).toMatch(/stream key/i)
  })

  it('signs out when the saved login is no longer valid', async () => {
    const { controller, state, advance } = fakeYoutube()
    await controller.command({ type: 'signIn' })
    state.refreshToken = 'revoked'
    advance(2 * 3600 * 1000) // the short-lived access token has run out
    const s = await controller.command({ type: 'refresh' })
    expect(s.signedIn).toBe(false)
    expect(s.message).toMatch(/sign in again/i)
  })

  it('refuses to sign in without a client', async () => {
    const { deps } = fakeYoutube()
    const c = new YoutubeController(() => {}, deps, () => {})
    const s = await c.command({ type: 'signIn' })
    expect(s.signedIn).toBe(false)
    expect(s.message).toMatch(/Client ID/)
  })

  it('does nothing while testing', async () => {
    const { deps } = fakeYoutube()
    const c = new YoutubeController(() => {}, { ...deps, unavailable: () => 'off' }, () => {}, { clientId: 'a', clientSecret: 'b' })
    expect((await c.command({ type: 'signIn' })).signedIn).toBe(false)
  })
})

describe('YouTube reconnecting', () => {
  const dropped = async (opts: Parameters<typeof fakeYoutube>[0] = {}) => {
    const f = fakeYoutube(opts)
    await f.controller.command({ type: 'signIn' })
    await f.controller.command({ type: 'start', screenId: 'v1' })
    await f.controller.command({ type: 'goLive' })
    f.state.sending = false // the connection went away and ffmpeg ended
    return f
  }

  it('sends the stream again by itself, without another transition', async () => {
    const { controller, state, calls } = await dropped()
    const before = calls.filter((c) => c.includes('transition')).length
    controller.streamChanged()
    await controller.settled()
    expect(state.sending).toBe(true)
    expect(state.started).toHaveLength(2)
    expect(calls.filter((c) => c.includes('transition')).length).toBe(before)
    const s = controller.getStatus()
    expect(s.phase).toBe('live')
    expect(s.reconnecting).toBe(false)
    expect(s.message).toMatch(/stream is back/i)
  })

  it('keeps trying while there is no connection, and says so', async () => {
    const { controller, state, seen } = await dropped()
    state.offline = true
    let sleeps = 0
    state.onSleep = () => { if (++sleeps === 4) state.offline = false } // the connection comes back after a few tries
    controller.streamChanged()
    await controller.settled()
    expect(state.sending).toBe(true)
    expect(seen.some((s) => /No connection to YouTube/.test(s.message) && s.reconnecting)).toBe(true)
  })

  it('stops trying when the operator ends the stream', async () => {
    const { controller, state } = await dropped()
    state.offline = true
    state.onSleep = () => { state.offline = false; void controller.command({ type: 'stop' }) }
    controller.streamChanged()
    await controller.settled()
    expect(state.sending).toBe(false)
    expect(controller.getStatus().reconnecting).toBe(false)
  })

  it('does not reconnect a stream the operator stopped', async () => {
    const f = fakeYoutube()
    await f.controller.command({ type: 'signIn' })
    await f.controller.command({ type: 'start', screenId: 'v1' })
    await f.controller.command({ type: 'stop' })
    f.controller.streamChanged()
    await f.controller.settled()
    expect(f.state.started).toHaveLength(1)
  })

  it('gives up when YouTube has ended the broadcast meanwhile', async () => {
    const { controller, state } = await dropped()
    state.life = 'complete'
    controller.streamChanged()
    await controller.settled()
    const s = controller.getStatus()
    expect(state.sending).toBe(false)
    expect(s.message).toMatch(/automatic reconnecting stopped/i)
  })

  it('explains a missing connection in words when a button is pressed', async () => {
    const { controller, state } = await dropped()
    state.offline = true
    const s = await controller.command({ type: 'goLive' })
    expect(s.message).toMatch(/No connection to YouTube/)
    expect(s.message).not.toMatch(/fetch failed/)
  })
})

describe('YouTube model', () => {
  it('reads broadcasts: unfinished ones, soonest first', () => {
    const list = parseBroadcasts({ items: [broadcast('b', 'ready', { snippet: { title: 'Later', scheduledStartTime: '2026-11-22T09:00:00Z' } }), broadcast('a', 'ready'), broadcast('c', 'complete'), { id: 'x', status: { lifeCycleStatus: 'nonsense' } }] })
    expect(list.map((b) => b.id)).toEqual(['a', 'b'])
  })
  it('reads the ingest and whether video arrives', () => {
    expect(parseIngest({ items: [{ cdn: { ingestionInfo: { ingestionAddress: 'rtmp://x/live2', streamName: 'k' } }, status: { streamStatus: 'active' } }] })).toEqual({ address: 'rtmp://x/live2', key: 'k', active: true })
    expect(parseIngest({ items: [] })).toBeNull()
  })
  it('phases and buttons', () => {
    expect(youtubePhase('testing', true, false, false)).toBe('preview')
    expect(youtubePhase('ready', true, false, false)).toBe('ready')
    expect(youtubePhase('ready', false, false, false)).toBe('idle')
    expect(youtubePhase('live', false, false, false)).toBe('live')
    expect(youtubePhase('complete', false, false, false)).toBe('ended')
    expect(youtubePhase('ready', true, true, false)).toBe('working')
    expect(youtubeCan('working', 'ready', false, true, true)).toEqual({ start: false, goLive: false, stop: false, end: false })
    expect(youtubeCan('live', 'live', true, true, true).end).toBe(true)
    expect(youtubeCan('idle', 'ready', false, false, true).start).toBe(false) // not signed in
  })
  it('explains Google errors in words', () => {
    expect(youtubeErrorMessage(403, { error: { errors: [{ reason: 'liveStreamingNotEnabled' }] } })).toMatch(/not enabled for live streaming/)
    expect(youtubeErrorMessage(403, { error: { errors: [{ reason: 'quotaExceeded' }] } })).toMatch(/daily limit/)
    expect(youtubeErrorMessage(401, {})).toMatch(/sign in again/i)
    expect(youtubeErrorMessage(500, {})).toMatch(/500/)
  })
  it('builds the sign-in address with PKCE and a refresh token request', () => {
    const q = new URL(authUrl({ clientId: 'cid', clientSecret: 's' }, 'http://127.0.0.1:5', 'chal', 'st')).searchParams
    expect(q.get('code_challenge_method')).toBe('S256')
    expect(q.get('access_type')).toBe('offline')
    expect(q.get('redirect_uri')).toBe('http://127.0.0.1:5')
    expect(q.get('client_secret')).toBeNull()
  })
  it('labels a broadcast with its time', () => {
    expect(broadcastLabel({ id: 'a', title: 'Sunday', scheduledStart: '', privacy: '', lifeCycle: 'ready', streamId: '', preview: true })).toBe('Sunday')
  })
})
