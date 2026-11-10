/** Managing a scheduled YouTube broadcast from the app (YouTube Live Streaming API). Pure model: no I/O. */

import { t } from './i18n'

/** What the operator enters once, from their own Google Cloud project (a "Desktop app" OAuth client). Saved in youtube.json. */
export interface YoutubeClient {
  clientId: string
  clientSecret: string
}

export const noYoutubeClient: YoutubeClient = { clientId: '', clientSecret: '' }

/** The life of a broadcast on YouTube's side. */
export type LifeCycle = 'created' | 'ready' | 'testStarting' | 'testing' | 'liveStarting' | 'live' | 'complete' | 'revoked'

const LIFE_CYCLES: readonly string[] = ['created', 'ready', 'testStarting', 'testing', 'liveStarting', 'live', 'complete', 'revoked']

export interface YoutubeBroadcast {
  id: string
  title: string
  /** ISO time the broadcast is scheduled for ('' when not set). */
  scheduledStart: string
  privacy: string
  lifeCycle: LifeCycle
  /** The stream (ingest) bound to it; empty when none is bound yet. */
  streamId: string
  /** Whether YouTube lets it go through a private preview ("testing") before going live. */
  preview: boolean
}

/**
 * idle: not sending. working: talking to YouTube / waiting for it. preview: sending, and the broadcast can be checked in YouTube Studio
 * before the audience sees it. ready: sending, and can go live at once (no preview on this broadcast). live: the audience sees it.
 * ended: finished. error: the last step failed (the message says why).
 */
export type YoutubePhase = 'idle' | 'working' | 'preview' | 'ready' | 'live' | 'ended' | 'error'

export interface YoutubeStatus {
  /** A client id and secret are saved. */
  configured: boolean
  clientId: string
  signedIn: boolean
  /** Name of the channel that is signed in. */
  account: string
  broadcasts: YoutubeBroadcast[]
  selected: string
  phase: YoutubePhase
  /** One line for the operator. */
  message: string
  /** What the buttons may do now. */
  can: { start: boolean; goLive: boolean; stop: boolean; end: boolean }
  /** The stream is being sent to the selected broadcast. */
  streaming: boolean
  /** The stream dropped and is being brought back by itself. */
  reconnecting: boolean
  /** Why nothing can be done here at all (tests), or ''. */
  unavailable: string
}

export const idleYoutube: YoutubeStatus = {
  configured: false, clientId: '', signedIn: false, account: '', broadcasts: [], selected: '', phase: 'idle', message: '',
  can: { start: false, goLive: false, stop: false, end: false }, streaming: false, reconnecting: false, unavailable: '',
}

export type YoutubeCommand =
  | { type: 'signIn' }
  | { type: 'signOut' }
  | { type: 'refresh' }
  | { type: 'select'; id: string }
  /** Start sending the stream to the selected broadcast, and open its preview when it has one. `screenId` is the virtual screen. */
  | { type: 'start'; screenId: string }
  | { type: 'goLive' }
  /** Stop sending but leave the broadcast where it is (a preview can be picked up again). */
  | { type: 'stop' }
  /** Finish the live broadcast on YouTube and stop sending. */
  | { type: 'end' }

export const sanitizeYoutubeClient = (raw: unknown): YoutubeClient => {
  const r = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
  const clean = (v: unknown): string => (typeof v === 'string' ? v.trim().slice(0, 300) : '')
  return { clientId: clean(r.clientId), clientSecret: clean(r.clientSecret) }
}

/** Which buttons make sense, from where the broadcast is and whether the stream is being sent. */
export function youtubePhase(life: LifeCycle | null, streaming: boolean, busy: boolean, failed: boolean): YoutubePhase {
  if (busy) return 'working'
  if (failed) return 'error'
  if (!life) return 'idle'
  if (life === 'complete' || life === 'revoked') return 'ended'
  if (life === 'live' || life === 'liveStarting') return 'live'
  if (!streaming) return 'idle'
  return life === 'testing' ? 'preview' : 'ready'
}

export function youtubeCan(phase: YoutubePhase, life: LifeCycle | null, streaming: boolean, signedIn: boolean, hasSelection: boolean): YoutubeStatus['can'] {
  const none = { start: false, goLive: false, stop: false, end: false }
  if (!signedIn || !hasSelection || phase === 'working' || phase === 'ended') return none
  const onAir = life === 'liveStarting' || life === 'live'
  return {
    // Also reconnects a stream that dropped while the broadcast was already on.
    start: !streaming && life !== null,
    goLive: streaming && (life === 'ready' || life === 'testing'),
    stop: streaming && !onAir,
    end: onAir,
  }
}

// --- Reading YouTube's answers ---------------------------------------------------------------------------------------------

const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' ? (v as Record<string, unknown>) : {})
const str = (v: unknown): string => (typeof v === 'string' ? v : '')

export function parseBroadcast(raw: unknown): YoutubeBroadcast | null {
  const r = obj(raw)
  const id = str(r.id)
  const life = str(obj(r.status).lifeCycleStatus)
  if (!id || !LIFE_CYCLES.includes(life)) return null
  const snippet = obj(r.snippet)
  const content = obj(r.contentDetails)
  return {
    id,
    title: str(snippet.title) || id,
    scheduledStart: str(snippet.scheduledStartTime),
    privacy: str(obj(r.status).privacyStatus),
    lifeCycle: life as LifeCycle,
    streamId: str(content.boundStreamId),
    preview: obj(content.monitorStream).enableMonitorStream !== false,
  }
}

/** The broadcasts of a list answer: the ones that have not finished, the soonest first (those without a time last). */
export function parseBroadcasts(raw: unknown): YoutubeBroadcast[] {
  const items = obj(raw).items
  const list = (Array.isArray(items) ? items : []).map(parseBroadcast).filter((b): b is YoutubeBroadcast => b !== null && b.lifeCycle !== 'complete' && b.lifeCycle !== 'revoked')
  return list.sort((a, b) => (a.scheduledStart || '9').localeCompare(b.scheduledStart || '9'))
}

export interface YoutubeIngest {
  /** rtmp://... without the key. */
  address: string
  key: string
  /** YouTube sees the video arriving. */
  active: boolean
}

export function parseIngest(raw: unknown): YoutubeIngest | null {
  const item = obj((Array.isArray(obj(raw).items) ? (obj(raw).items as unknown[]) : [])[0])
  const info = obj(obj(item.cdn).ingestionInfo)
  const address = str(info.ingestionAddress)
  const key = str(info.streamName)
  if (!address || !key) return null
  return { address, key, active: str(obj(item.status).streamStatus) === 'active' }
}

/** A message for what went wrong, from the body of a Google error (never the raw JSON). */
export function youtubeErrorMessage(status: number, body: unknown): string {
  const e = obj(obj(body).error)
  const reason = str(obj((Array.isArray(e.errors) ? (e.errors as unknown[]) : [])[0]).reason)
  const message = str(e.message)
  if (reason === 'liveStreamingNotEnabled') return t('stream.yt.err.notEnabled')
  if (reason === 'quotaExceeded' || reason === 'rateLimitExceeded' || reason === 'dailyLimitExceeded') return t('stream.yt.err.quota')
  if (reason === 'insufficientPermissions' || reason === 'forbidden') return t('stream.yt.err.permission')
  if (reason === 'invalidTransition' || reason === 'redundantTransition') return t('stream.yt.err.transition', { message })
  if (status === 401) return t('stream.yt.err.signedOut')
  if (status === 403 && /access not configured|has not been used|disabled/i.test(message)) return t('stream.yt.err.apiOff')
  return message ? t('stream.yt.err.other', { message }) : t('stream.yt.err.status', { status })
}

/** "Sun 10 Nov, 10:00 - Sunday service" for the list of broadcasts. */
export function broadcastLabel(b: YoutubeBroadcast, locale?: string): string {
  const when = b.scheduledStart ? new Date(b.scheduledStart) : null
  const time = when && !Number.isNaN(when.getTime()) ? when.toLocaleString(locale, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : ''
  return time ? `${time} - ${b.title}` : b.title
}

// --- Signing in (OAuth for a desktop app: loopback address and PKCE) -------------------------------------------------------

export const YOUTUBE_SCOPE = 'https://www.googleapis.com/auth/youtube'
export const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth'
export const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token'

export function authUrl(client: YoutubeClient, redirectUri: string, challenge: string, state: string): string {
  const q = new URLSearchParams({
    client_id: client.clientId, redirect_uri: redirectUri, response_type: 'code', scope: YOUTUBE_SCOPE,
    code_challenge: challenge, code_challenge_method: 'S256', state, access_type: 'offline', prompt: 'consent',
  })
  return `${GOOGLE_AUTH_URL}?${q}`
}
