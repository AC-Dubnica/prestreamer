import {
  authUrl, GOOGLE_TOKEN_URL, noYoutubeClient, parseBroadcast, parseBroadcasts, parseIngest, sanitizeYoutubeClient, youtubeCan, youtubeErrorMessage, youtubePhase,
  type LifeCycle, type YoutubeBroadcast, type YoutubeClient, type YoutubeCommand, type YoutubeIngest, type YoutubeStatus,
} from '../shared/youtube'
import { t } from '../shared/i18n'

/** What the sign-in window brings back: the code, and what it needs to be exchanged. */
export interface AuthResult { code: string; redirectUri: string; verifier: string }

/** How the controller reaches the outside world; tests give it fakes. */
export interface YoutubeDeps {
  fetch(url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }): Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>
  /** Opens the browser for Google's sign-in and waits for the answer. Rejects when the person gives up. */
  authorize(client: YoutubeClient): Promise<AuthResult>
  loadRefreshToken(): string | null
  saveRefreshToken(token: string | null): void
  /** Starts the stream to this ingest (the key never leaves memory), from the virtual screen. */
  startStream(ingest: YoutubeIngest, screenId: string): Promise<void>
  stopStream(): Promise<void>
  isStreaming(): boolean
  sleep(ms: number): Promise<void>
  now(): number
  /** Why this cannot be used at all (tests must never reach Google), or ''. */
  unavailable(): string
}

const API = 'https://www.googleapis.com/youtube/v3'
const POLL_MS = 2000
/** After the stream drops: a short wait (a blip may heal itself), then a try every few seconds until it is back or the operator stops it. */
const RECONNECT_FIRST_MS = 3000
const RECONNECT_RETRY_MS = 5000

/** `retry`: a try again later can succeed (no connection, a YouTube hiccup, a slow start); otherwise something has to be changed first. */
class YoutubeError extends Error {
  constructor(message: string, readonly retry = false) { super(message) }
}

/**
 * The scheduled broadcast on YouTube: signing in, the list of broadcasts, and the steps start (send the stream, open the preview),
 * go live, and end. YouTube's side is read with the account's own login; the stream key is fetched when it is needed and only held
 * in memory. Never throws at the caller: a failure is the status message.
 */
export class YoutubeController {
  private client: YoutubeClient
  private access = ''
  private accessUntil = 0
  private account = ''
  private broadcasts: YoutubeBroadcast[] = []
  private selected = ''
  private busy = ''
  private failure = ''
  private info = ''
  private lastStatus = ''
  /** The operator started the stream and has not stopped it: if it drops, it is brought back by itself. */
  private keepAlive = false
  private screenId = ''
  private reconnecting = false
  private attempts = 0
  private loop: Promise<void> | null = null

  constructor(
    private readonly onStatus: (s: YoutubeStatus) => void,
    private readonly deps: YoutubeDeps,
    private readonly saveClient: (c: YoutubeClient) => void,
    initial: YoutubeClient = noYoutubeClient,
  ) {
    this.client = sanitizeYoutubeClient(initial)
  }

  private get signedIn(): boolean { return this.deps.loadRefreshToken() !== null }
  private get current(): YoutubeBroadcast | undefined { return this.broadcasts.find((b) => b.id === this.selected) }

  getStatus(): YoutubeStatus {
    const life = this.current?.lifeCycle ?? null
    const streaming = this.deps.isStreaming()
    const phase = youtubePhase(life, streaming, this.busy !== '', this.failure !== '')
    return {
      configured: !!this.client.clientId && !!this.client.clientSecret,
      clientId: this.client.clientId,
      signedIn: this.signedIn,
      account: this.account,
      broadcasts: this.broadcasts,
      selected: this.selected,
      phase,
      message: this.busy || this.failure || this.info,
      can: youtubeCan(phase, life, streaming, this.signedIn, !!this.current),
      streaming,
      reconnecting: this.reconnecting,
      unavailable: this.deps.unavailable(),
    }
  }

  setClient(raw: unknown): YoutubeStatus {
    const next = sanitizeYoutubeClient(raw)
    const changed = next.clientId !== this.client.clientId || next.clientSecret !== this.client.clientSecret
    this.client = next
    this.saveClient(next)
    if (changed && this.signedIn) this.forget() // a login belongs to the client that made it
    return this.push()
  }

  /** The stream started or stopped on its own (ffmpeg ended): the buttons follow. */
  streamChanged(): void {
    if (!this.busy && !this.deps.isStreaming()) {
      if (this.keepAlive) this.loop ??= this.reconnectLoop()
      else if (this.current && (this.current.lifeCycle === 'live' || this.current.lifeCycle === 'testing')) this.info = t('stream.yt.interrupted')
    }
    this.push()
  }

  /** Resolves when no reconnecting is going on (tests wait for it). */
  settled(): Promise<void> { return this.loop ?? Promise.resolve() }

  async command(cmd: YoutubeCommand): Promise<YoutubeStatus> {
    if (this.deps.unavailable()) return this.getStatus()
    if (this.busy && cmd.type !== 'select') return this.getStatus()
    if (cmd.type === 'select') {
      if (this.broadcasts.some((b) => b.id === cmd.id)) { this.selected = cmd.id; this.failure = ''; this.info = '' }
      return this.push()
    }
    if (cmd.type === 'signOut') { this.keepAlive = false; this.forget(); return this.push() }
    if (cmd.type === 'stop' || cmd.type === 'end') this.keepAlive = false // asked for: nothing to bring back
    const steps: Record<string, () => Promise<void>> = {
      signIn: () => this.signIn(),
      refresh: () => this.refresh(),
      start: () => this.start(cmd.type === 'start' ? cmd.screenId : ''),
      goLive: () => this.goLive(),
      stop: () => this.stopSending(),
      end: () => this.end(),
    }
    this.failure = ''
    this.info = ''
    try {
      await steps[cmd.type]()
    } catch (e) {
      this.failure = e instanceof Error ? e.message : String(e)
    } finally {
      this.busy = ''
    }
    return this.push()
  }

  // --- sign-in ---------------------------------------------------------------------------------------------------------------

  private forget(): void {
    this.deps.saveRefreshToken(null)
    this.access = ''
    this.account = ''
    this.broadcasts = []
    this.selected = ''
  }

  private async signIn(): Promise<void> {
    if (!this.client.clientId || !this.client.clientSecret) throw new YoutubeError(t('stream.yt.needClient'))
    this.working(t('stream.yt.waitingBrowser'))
    const auth = await this.deps.authorize(this.client)
    const token = await this.tokenRequest({ grant_type: 'authorization_code', code: auth.code, redirect_uri: auth.redirectUri, code_verifier: auth.verifier })
    if (!token.refresh_token) throw new YoutubeError(t('stream.yt.noRefresh'))
    this.deps.saveRefreshToken(token.refresh_token)
    await this.loadAccount()
    await this.refresh()
  }

  private async tokenRequest(form: Record<string, string>): Promise<{ access_token: string; refresh_token?: string; expires_in: number }> {
    const body = new URLSearchParams({ client_id: this.client.clientId, client_secret: this.client.clientSecret, ...form }).toString()
    const res = await this.net(GOOGLE_TOKEN_URL, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body })
    const json = (await res.json().catch(() => ({}))) as Record<string, unknown>
    if (!res.ok || typeof json.access_token !== 'string') {
      if (json.error === 'invalid_grant' && form.grant_type === 'refresh_token') { this.forget(); throw new YoutubeError(t('stream.yt.err.signedOut')) }
      throw new YoutubeError(t('stream.yt.err.token', { message: String(json.error_description ?? json.error ?? res.status) }), res.status >= 500)
    }
    const expires = typeof json.expires_in === 'number' ? json.expires_in : 3600
    this.access = json.access_token
    this.accessUntil = this.deps.now() + expires * 1000
    return { access_token: json.access_token, refresh_token: typeof json.refresh_token === 'string' ? json.refresh_token : undefined, expires_in: expires }
  }

  /** A request that fails before an answer arrives means there is no connection: said so, and worth trying again. */
  private async net(url: string, init?: Parameters<YoutubeDeps['fetch']>[1]): ReturnType<YoutubeDeps['fetch']> {
    try {
      return await this.deps.fetch(url, init)
    } catch {
      throw new YoutubeError(t('stream.yt.err.offline'), true)
    }
  }

  private async bearer(): Promise<string> {
    if (this.access && this.deps.now() < this.accessUntil - 60_000) return this.access
    const refresh = this.deps.loadRefreshToken()
    if (!refresh) throw new YoutubeError(t('stream.yt.err.signedOut'))
    await this.tokenRequest({ grant_type: 'refresh_token', refresh_token: refresh })
    return this.access
  }

  private async api(path: string, method = 'GET'): Promise<unknown> {
    const res = await this.net(`${API}/${path}`, { method, headers: { authorization: `Bearer ${await this.bearer()}`, accept: 'application/json' } })
    const json = await res.json().catch(() => ({}))
    if (!res.ok) {
      if (res.status === 401) { this.access = '' }
      throw new YoutubeError(youtubeErrorMessage(res.status, json), res.status >= 500 || res.status === 429)
    }
    return json
  }

  private async loadAccount(): Promise<void> {
    const json = (await this.api('channels?part=snippet&mine=true')) as { items?: { snippet?: { title?: string } }[] }
    this.account = json.items?.[0]?.snippet?.title ?? ''
  }

  // --- the broadcasts --------------------------------------------------------------------------------------------------------

  private async refresh(): Promise<void> {
    if (!this.signedIn) throw new YoutubeError(t('stream.yt.err.signedOut'))
    this.working(t('stream.yt.loading'))
    if (!this.account) await this.loadAccount()
    const part = 'part=id,snippet,status,contentDetails&maxResults=25'
    const [upcoming, active] = await Promise.all([this.api(`liveBroadcasts?${part}&broadcastStatus=upcoming`), this.api(`liveBroadcasts?${part}&broadcastStatus=active`)])
    const all = [...parseBroadcasts(active), ...parseBroadcasts(upcoming)]
    this.broadcasts = all.filter((b, i) => all.findIndex((o) => o.id === b.id) === i)
    // Keep the choice; else the one that is already on, else the next one scheduled.
    if (!this.broadcasts.some((b) => b.id === this.selected)) this.selected = (this.broadcasts.find((b) => b.lifeCycle === 'live' || b.lifeCycle === 'testing') ?? this.broadcasts[0])?.id ?? ''
    if (!this.broadcasts.length) this.info = t('stream.yt.none')
  }

  /** Reads one broadcast again and puts it in the list. */
  private async reload(id: string): Promise<YoutubeBroadcast> {
    const json = await this.api(`liveBroadcasts?part=id,snippet,status,contentDetails&id=${encodeURIComponent(id)}`)
    const b = parseBroadcast(((json as { items?: unknown[] }).items ?? [])[0])
    if (!b) throw new YoutubeError(t('stream.yt.gone'))
    this.broadcasts = this.broadcasts.some((x) => x.id === b.id) ? this.broadcasts.map((x) => (x.id === b.id ? b : x)) : [...this.broadcasts, b]
    this.push()
    return b
  }

  private async ingestOf(b: YoutubeBroadcast): Promise<YoutubeIngest> {
    if (!b.streamId) throw new YoutubeError(t('stream.yt.noStream'))
    const ingest = parseIngest(await this.api(`liveStreams?part=cdn,status&id=${encodeURIComponent(b.streamId)}`))
    if (!ingest) throw new YoutubeError(t('stream.yt.noStream'))
    return ingest
  }

  private async until<T>(what: string, read: () => Promise<T | null>, seconds: number): Promise<T> {
    const end = this.deps.now() + seconds * 1000
    for (;;) {
      const v = await read()
      if (v !== null) return v
      if (this.deps.now() >= end) throw new YoutubeError(t('stream.yt.timeout', { what }), true)
      await this.deps.sleep(POLL_MS)
    }
  }

  private async transition(id: string, to: 'testing' | 'live' | 'complete'): Promise<void> {
    await this.api(`liveBroadcasts/transition?broadcastStatus=${to}&id=${encodeURIComponent(id)}&part=id,status`, 'POST')
  }

  private async waitFor(id: string, goal: LifeCycle, what: string, seconds: number): Promise<YoutubeBroadcast> {
    return this.until(what, async () => { const b = await this.reload(id); return b.lifeCycle === goal ? b : null }, seconds)
  }

  // --- the steps -------------------------------------------------------------------------------------------------------------

  private working(message: string): void {
    this.busy = message
    this.push()
  }

  private selectedOrFail(): YoutubeBroadcast {
    const b = this.current
    if (!b) throw new YoutubeError(t('stream.yt.pick'))
    return b
  }

  private async start(screenId: string): Promise<void> {
    let b = await this.reload(this.selectedOrFail().id)
    if (b.lifeCycle === 'complete' || b.lifeCycle === 'revoked') throw new YoutubeError(t('stream.yt.over'))
    this.screenId = screenId || this.screenId
    this.working(t('stream.yt.sending'))
    const ingest = await this.ingestOf(b)
    if (!this.deps.isStreaming()) await this.deps.startStream(ingest, screenId)
    this.push()
    await this.until(t('stream.yt.what.video'), async () => ((await this.ingestOf(b)).active ? true : null), 60)
    b = await this.reload(b.id)
    if ((b.lifeCycle === 'ready' || b.lifeCycle === 'created') && b.preview) {
      this.working(t('stream.yt.openingPreview'))
      try {
        await this.transition(b.id, 'testing')
        await this.waitFor(b.id, 'testing', t('stream.yt.what.preview'), 90)
        this.info = t('stream.yt.previewOpen')
      } catch (e) {
        if (!(e instanceof YoutubeError)) throw e
        this.info = t('stream.yt.noPreview', { message: e.message }) // the stream is on its way; going live straight away still works
      }
    } else if (b.lifeCycle === 'ready' || b.lifeCycle === 'created') this.info = t('stream.yt.noPreviewSet')
    this.keepAlive = true
  }

  private async goLive(): Promise<void> {
    const b = this.selectedOrFail()
    this.working(t('stream.yt.goingLive'))
    await this.transition(b.id, 'live')
    await this.waitFor(b.id, 'live', t('stream.yt.what.live'), 90)
    this.info = t('stream.yt.isLive')
  }

  private async stopSending(): Promise<void> {
    this.working(t('stream.yt.stopping'))
    await this.deps.stopStream()
    await this.reload(this.selectedOrFail().id).catch(() => undefined)
  }

  private async end(): Promise<void> {
    const b = this.selectedOrFail()
    this.working(t('stream.yt.ending'))
    await this.transition(b.id, 'complete')
    await this.deps.stopStream()
    await this.waitFor(b.id, 'complete', t('stream.yt.what.end'), 60).catch(() => undefined)
    await this.refresh()
    this.info = t('stream.yt.ended')
  }

  // --- bringing a dropped stream back ----------------------------------------------------------------------------------------

  /**
   * The stream stopped by itself while the operator wants it on: wait a moment, then try again every few seconds (no connection, a
   * slow start ...) until it is sending again. Pressing Stop or End, or signing out, ends it. It only sends the same stream to the same
   * broadcast again; it never changes what the broadcast is doing on YouTube.
   */
  private async reconnectLoop(): Promise<void> {
    try {
      await this.deps.sleep(RECONNECT_FIRST_MS)
      this.attempts = 0
      while (this.keepAlive && !this.busy && !this.deps.isStreaming()) {
        this.attempts++
        this.reconnecting = true
        this.info = t('stream.yt.reconnecting', { n: this.attempts })
        this.push()
        try {
          await this.reconnectOnce()
        } catch (e) {
          if (this.deps.isStreaming()) await this.deps.stopStream().catch(() => undefined) // a start that never reached YouTube: begin again cleanly
          const message = e instanceof Error ? e.message : String(e)
          if (e instanceof YoutubeError && !e.retry) { this.keepAlive = false; this.failure = t('stream.yt.retryStopped', { reason: message }); break }
          if (!this.keepAlive) break
          this.info = t('stream.yt.retryIn', { reason: message, seconds: RECONNECT_RETRY_MS / 1000, n: this.attempts })
          this.push()
          await this.deps.sleep(RECONNECT_RETRY_MS)
          continue
        }
        if (this.keepAlive && this.deps.isStreaming()) this.info = t('stream.yt.reconnected')
      }
    } finally {
      this.reconnecting = false
      this.loop = null
      this.push()
    }
  }

  private async reconnectOnce(): Promise<void> {
    const id = this.selected
    if (!id) throw new YoutubeError(t('stream.yt.pick'))
    const b = await this.reload(id)
    if (b.lifeCycle === 'complete' || b.lifeCycle === 'revoked') throw new YoutubeError(t('stream.yt.over'))
    const ingest = await this.ingestOf(b)
    if (!this.keepAlive) return
    if (!this.deps.isStreaming()) await this.deps.startStream(ingest, this.screenId)
    await this.until(t('stream.yt.what.video'), async () => ((await this.ingestOf(b)).active ? true : null), 45)
    if (!this.keepAlive) { await this.deps.stopStream(); return } // stopped meanwhile
    await this.reload(id)
  }

  private push(): YoutubeStatus {
    const s = this.getStatus()
    const key = JSON.stringify(s)
    if (key !== this.lastStatus) { this.lastStatus = key; this.onStatus(s) }
    return s
  }
}

