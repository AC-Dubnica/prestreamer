import type { PrestreamerApi } from '../preload'
import { t } from '../shared/i18n'
import { broadcastLabel, idleYoutube, type YoutubeStatus } from '../shared/youtube'
import { confirmDialog } from './dialogs'

function el<T extends HTMLElement = HTMLElement>(tag: string, props: Partial<T> = {}, ...kids: (Node | string)[]): T {
  const e = Object.assign(document.createElement(tag) as T, props)
  e.append(...kids)
  return e
}

export interface YoutubePanelDeps {
  /** The virtual screen the stream is made from, if there is one. */
  screenId(): string | undefined
  /** Starts the mixer when it is not running (the stream's sound), before the stream starts. */
  ensureMixer(): Promise<void>
}

/** The Present tab's controls for a scheduled YouTube broadcast: choose it, start (and preview), go live, end. */
export function createYoutubePanel(api: PrestreamerApi, host: HTMLElement, deps: YoutubePanelDeps) {
  let status: YoutubeStatus = idleYoutube

  const run = (cmd: Parameters<PrestreamerApi['youtubeCommand']>[0]) => void api.youtubeCommand(cmd)

  function render(): void {
    const s = status
    const list = el<HTMLSelectElement>('select', { disabled: s.phase === 'working' || s.streaming },
      ...s.broadcasts.map((b) => el<HTMLOptionElement>('option', { value: b.id, textContent: broadcastLabel(b, api.language), selected: b.id === s.selected })))
    list.setAttribute('aria-label', t('stream.yt.broadcast'))
    list.onchange = () => run({ type: 'select', id: list.value })
    const reload = el<HTMLButtonElement>('button', { textContent: '↻', title: t('stream.yt.reload'), disabled: s.phase === 'working' || s.streaming, onclick: () => run({ type: 'refresh' }) })
    reload.setAttribute('aria-label', t('stream.yt.reload'))

    const started = s.broadcasts.find((b) => b.id === s.selected)?.lifeCycle
    const start = el<HTMLButtonElement>('button', {
      className: 'primary', disabled: !s.can.start || !deps.screenId(),
      textContent: started === 'live' || started === 'testing' ? t('stream.yt.reconnect') : t('stream.yt.start'),
      onclick: async () => {
        const screenId = deps.screenId()
        if (!screenId) return
        await deps.ensureMixer()
        run({ type: 'start', screenId })
      },
    })
    const goLive = el<HTMLButtonElement>('button', { className: 'primary', textContent: t('stream.yt.goLive'), disabled: !s.can.goLive, onclick: () => run({ type: 'goLive' }) })
    const stop = el<HTMLButtonElement>('button', { textContent: t('stream.yt.stop'), disabled: !s.can.stop, onclick: () => run({ type: 'stop' }) })
    const end = el<HTMLButtonElement>('button', {
      className: 'danger', textContent: t('stream.yt.end'), disabled: !s.can.end,
      onclick: async () => { if (await confirmDialog({ title: t('stream.yt.endAsk'), message: t('stream.yt.endMsg'), confirm: t('stream.yt.end'), danger: true })) run({ type: 'end' }) },
    })
    // Only the steps that apply are shown, so there is nothing to wonder about.
    const buttons = s.phase === 'live' ? [...(s.can.start ? [start] : []), end]
      : s.phase === 'preview' || s.phase === 'ready' ? [goLive, stop]
      : [start]
    host.replaceChildren(
      el('div', { className: 'dmxrow' }, list, reload),
      el('div', { className: `status ${s.phase === 'error' ? 'error' : s.phase === 'live' ? 'running' : ''}`, textContent: `${t(`stream.yt.phase.${s.phase}`)}${s.message ? ` — ${s.message}` : ''}` }),
      el('div', { className: 'streamgo' }, ...buttons),
    )
  }
  render()
  return {
    update(next: YoutubeStatus): void { status = next; render() },
    get status(): YoutubeStatus { return status },
  }
}
