import type { PrestreamerApi } from '../preload'
import { t } from '../shared/i18n'
import { idleYoutube, type YoutubeStatus } from '../shared/youtube'

function el<T extends HTMLElement = HTMLElement>(tag: string, props: Partial<T> = {}, ...kids: (Node | string)[]): T {
  const e = Object.assign(document.createElement(tag) as T, props)
  e.append(...kids)
  return e
}

/** The Settings → YouTube page: the Google Cloud client and the sign-in. Broadcasts themselves are run from the Present tab. */
export function createYoutubeSettings(api: PrestreamerApi) {
  let status: YoutubeStatus = idleYoutube
  const root = el('div', { className: 'setsec' })
  /** Text being typed: kept while the status changes under it. */
  let typing: { id: string; secret: string } | null = null

  function render(): void {
    const id = el<HTMLInputElement>('input', { type: 'text', value: typing?.id ?? status.clientId, spellcheck: false, autocomplete: 'off' })
    const secret = el<HTMLInputElement>('input', { type: 'password', value: typing?.secret ?? (status.configured ? '••••••••••••' : ''), spellcheck: false, autocomplete: 'off' })
    id.setAttribute('aria-label', t('stream.yt.set.clientId'))
    secret.setAttribute('aria-label', t('stream.yt.set.clientSecret'))
    const save = () => {
      typing = { id: id.value, secret: secret.value }
      // The secret is never sent back to this page, so the placeholder dots mean "unchanged".
      if (secret.value.startsWith('•')) return
      void api.youtubeSetClient({ clientId: id.value, clientSecret: secret.value }).then((s) => { typing = null; status = s; render() })
    }
    id.onchange = save
    secret.onchange = save
    const blocked = !!status.unavailable
    const signIn = el<HTMLButtonElement>('button', { className: 'primary', textContent: t('stream.yt.set.signIn'), disabled: blocked || !status.configured || status.phase === 'working', onclick: () => void api.youtubeCommand({ type: 'signIn' }) })
    const signOut = el<HTMLButtonElement>('button', { textContent: t('stream.yt.set.signOut'), disabled: blocked, onclick: () => void api.youtubeCommand({ type: 'signOut' }) })
    const who = status.signedIn ? (status.account ? t('stream.yt.set.signedIn', { account: status.account }) : t('stream.yt.set.signedInNoName')) : t('stream.yt.set.notSignedIn')
    root.replaceChildren(
      el('div', { className: 'sethead2' }, el('h2', { textContent: 'YouTube' })),
      el('p', { className: 'dim', textContent: t('stream.yt.set.intro') }),
      el('p', { className: 'dim', textContent: t('stream.yt.set.steps') }),
      el('div', { className: 'setcard' },
        el('label', { className: 'srow2' }, el('span', { textContent: t('stream.yt.set.clientId') }), el('span', { className: 'inl' }, id)),
        el('label', { className: 'srow2' }, el('span', { textContent: t('stream.yt.set.clientSecret') }), el('span', { className: 'inl' }, secret))),
      el('div', { className: 'btns' }, status.signedIn ? signOut : signIn, el('span', { className: 'dim', textContent: blocked ? t('stream.yt.set.testing') : who })),
      ...(status.message && status.phase === 'error' ? [el('div', { className: 'status error', textContent: status.message })] : []),
      ...(status.message && status.phase === 'working' ? [el('div', { className: 'status', textContent: status.message })] : []),
      el('p', { className: 'dim', textContent: t('stream.yt.set.testNote') }),
    )
  }
  render()
  return {
    root,
    update(next: YoutubeStatus): void {
      const focused = root.contains(document.activeElement) && document.activeElement instanceof HTMLInputElement
      status = next
      if (!focused) render() // never rebuild under a field being typed in
    },
  }
}
