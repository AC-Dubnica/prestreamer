import { shell } from 'electron'
import { createHash, randomBytes } from 'node:crypto'
import { createServer } from 'node:http'
import { authUrl, type YoutubeClient } from '../shared/youtube'
import { t } from '../shared/i18n'
import type { AuthResult } from './youtube'

const WAIT_MS = 5 * 60_000
const b64 = (b: Buffer): string => b.toString('base64url')

const page = (title: string, text: string): string =>
  `<!doctype html><meta charset="utf-8"><title>PreStreamer</title><body style="font:16px system-ui;margin:15vh auto;max-width:28em;text-align:center"><h2>${title}</h2><p>${text}</p>`

/**
 * Google's sign-in for a desktop app: the browser is sent to Google, which comes back to a short-lived server on this computer
 * (127.0.0.1, a free port) with a one-time code. PKCE keeps the code useless to anyone who sees it.
 */
export function authorize(client: YoutubeClient): Promise<AuthResult> {
  const verifier = b64(randomBytes(48))
  const challenge = b64(createHash('sha256').update(verifier).digest())
  const state = b64(randomBytes(16))
  return new Promise((resolve, reject) => {
    const server = createServer()
    let done = false
    const finish = (err: Error | null, result?: AuthResult) => {
      if (done) return
      done = true
      clearTimeout(timer)
      server.close()
      if (err) reject(err)
      else resolve(result!)
    }
    const timer = setTimeout(() => finish(new Error(t('stream.yt.signInTimeout'))), WAIT_MS)
    server.on('request', (req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      if (url.pathname !== '/') { res.writeHead(404).end(); return }
      const code = url.searchParams.get('code')
      const error = url.searchParams.get('error')
      const ok = !!code && url.searchParams.get('state') === state
      res.writeHead(ok ? 200 : 400, { 'content-type': 'text/html; charset=utf-8' })
      res.end(ok ? page(t('stream.yt.pageDone'), t('stream.yt.pageClose')) : page(t('stream.yt.pageFailed'), t('stream.yt.pageClose')))
      if (ok) finish(null, { code: code!, redirectUri: `http://127.0.0.1:${(server.address() as { port: number }).port}`, verifier })
      else finish(new Error(error ? t('stream.yt.signInDenied', { reason: error }) : t('stream.yt.signInFailed')))
    })
    server.on('error', (e) => finish(e))
    server.listen(0, '127.0.0.1', () => {
      const redirect = `http://127.0.0.1:${(server.address() as { port: number }).port}`
      void shell.openExternal(authUrl(client, redirect, challenge, state)).catch((e) => finish(e as Error))
    })
  })
}
