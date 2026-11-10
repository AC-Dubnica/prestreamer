import type { PrestreamerApi } from '../preload'
import { TONE_COLORS, MAX_ANNOUNCE_CHARS, type AnnounceStyle, type AnnounceTone, type QuickMessage } from '../shared/announce'
import { t } from '../shared/i18n'
import type { ScreenState } from '../shared/types'
import { confirmDialog, showModal } from './dialogs'
import { iconButton } from './icons'

function el<T extends HTMLElement = HTMLElement>(tag: string, props: Partial<T> = {}, ...kids: (Node | string)[]): T {
  const e = Object.assign(document.createElement(tag) as T, props)
  e.append(...kids)
  return e
}

export interface AnnounceDeps {
  api: PrestreamerApi
  getState(): ScreenState
  getQuick(): QuickMessage[]
  setQuick(list: QuickMessage[]): void
  /** Announcing from a single-screen view: start with just this screen ticked (and don't remember that as the usual choice). */
  only?: string | null
}

interface Remembered { style: AnnounceStyle; tone: AnnounceTone; autoHideSec: number | null; screens: string[] | null }
const KEY = 'prestreamer.announce'
const DEFAULTS: Remembered = { style: 'banner-bottom', tone: 'alert', autoHideSec: null, screens: null }

/** The last choices are remembered, so in a hurry it is: press A, click the message. */
function recall(): Remembered {
  try {
    return { ...DEFAULTS, ...(JSON.parse(localStorage.getItem(KEY) ?? '{}') as Partial<Remembered>) }
  } catch {
    return DEFAULTS
  }
}
function remember(r: Remembered): void {
  try { localStorage.setItem(KEY, JSON.stringify(r)) } catch { /* private mode etc.: remembering is only a convenience */ }
}

const STYLE_LABELS: [AnnounceStyle, string][] = [['banner-bottom', t('devices.announce.bannerBottom')], ['banner-top', t('devices.announce.bannerTop')], ['fullscreen', t('devices.announce.fullscreen')]]
const TONE_LABELS: [AnnounceTone, string][] = [['alert', t('devices.announce.alert')], ['notice', t('devices.announce.notice')], ['info', t('devices.announce.info')]]
const TIME_LABELS: [string, string][] = [['', t('devices.announce.untilClear')], ['10', t('devices.announce.sec10')], ['30', t('devices.announce.sec30')], ['60', t('devices.announce.min1')], ['300', t('devices.announce.min5')]]

/**
 * Popup for a live announcement. Quick messages go on air with one click; a custom message is typed and sent with
 * Ctrl/Cmd+Enter. The announcement lays over the screens without changing the slide or the video underneath.
 */
export function openAnnounceDialog(deps: AnnounceDeps): void {
  const { api, only } = deps
  const mem = recall()
  const state = deps.getState()

  const text = el<HTMLTextAreaElement>('textarea', { rows: 3, maxLength: MAX_ANNOUNCE_CHARS, placeholder: t('devices.announce.placeholder'), spellcheck: true })
  const style = el<HTMLSelectElement>('select')
  style.append(...STYLE_LABELS.map(([v, label]) => el<HTMLOptionElement>('option', { value: v, textContent: label, selected: v === mem.style })))
  const tone = el<HTMLSelectElement>('select')
  tone.append(...TONE_LABELS.map(([v, label]) => el<HTMLOptionElement>('option', { value: v, textContent: label, selected: v === mem.tone })))
  const time = el<HTMLSelectElement>('select')
  time.append(...TIME_LABELS.map(([v, label]) => el<HTMLOptionElement>('option', { value: v, textContent: label, selected: v === String(mem.autoHideSec ?? '') })))
  const save = el<HTMLInputElement>('input', { type: 'checkbox' })

  const screenBoxes = state.screens.map((sc) => ({ sc, box: el<HTMLInputElement>('input', { type: 'checkbox', checked: only ? sc.id === only : mem.screens === null || mem.screens.includes(sc.id) }) }))
  const chosen = () => screenBoxes.filter((b) => b.box.checked).map((b) => b.sc.id)

  const sendBtn = el<HTMLButtonElement>('button', { className: 'danger', textContent: t('devices.announce.showNow') })
  const hint = el('span', { className: 'dim' })
  let closeDialog: () => void = () => {}

  const refresh = () => {
    const none = chosen().length === 0
    sendBtn.disabled = !text.value.trim() || none
    hint.textContent = none ? t('devices.announce.chooseOne') : ''
  }

  /** Puts a message on air. All screens ticked is stored as "every screen", so a screen added later shows it too. */
  async function send(message: string, st: AnnounceStyle, tn: AnnounceTone): Promise<void> {
    const ids = chosen()
    if (!message.trim() || !ids.length) return
    const autoHideSec = time.value ? Number(time.value) : null
    const screens = ids.length === state.screens.length ? null : ids
    const ok = await api.announceShow({ text: message, style: st, tone: tn, screens, autoHideSec })
    if (!ok) return
    remember({ style: st, tone: tn, autoHideSec, screens: only ? mem.screens : screens })
    if (save.checked && message === text.value.trim()) deps.setQuick(await api.announceQuickSave({ id: crypto.randomUUID(), text: message.trim(), style: st, tone: tn }))
    closeDialog()
  }

  const quickRow = (q: QuickMessage): HTMLElement => {
    const go = el('button', { className: 'qbtn', title: t('devices.announce.quickHint'), onclick: () => void send(q.text, q.style, q.tone) }, q.text)
    go.style.borderLeftColor = TONE_COLORS[q.tone]
    const del = iconButton('trash', t('devices.announce.deleteQuick'), async () => {
      if (!(await confirmDialog({ title: t('devices.announce.deleteQuickAsk'), message: q.text, confirm: t('devices.announce.delete'), danger: true }))) return
      deps.setQuick(await api.announceQuickDelete(q.id))
      openAnnounceDialog(deps) // redraw with the updated list
    }, { size: 14 })
    return el('div', { className: 'qrow' }, go, del)
  }

  const live = state.announcement
  const dialog = (close: () => void): HTMLElement => {
    closeDialog = close
    text.oninput = refresh
    text.onkeydown = (e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void send(text.value, style.value as AnnounceStyle, tone.value as AnnounceTone) } }
    sendBtn.onclick = () => void send(text.value, style.value as AnnounceStyle, tone.value as AnnounceTone)
    screenBoxes.forEach(({ box }) => { box.onchange = refresh })
    const quick = deps.getQuick()
    return el('div', { className: 'dialog pad ann', role: 'dialog' },
      el('h3', { className: 'dhead', textContent: t('devices.announce.heading') }),
      el('div', { className: 'dbody' },
        ...(live ? [el('div', { className: 'annlive' }, el('span', { textContent: t('devices.announce.onAir', { text: live.text }) }), el('button', { className: 'danger', textContent: t('devices.announce.clearIt'), onclick: () => { void api.announceClear(); close() } }))] : []),
        el('label', { className: 'dlabel', textContent: t('devices.announce.quickLabel') }),
        el('div', { className: 'qlist' }, ...(quick.length ? quick.map(quickRow) : [el('div', { className: 'dim', textContent: t('devices.announce.noQuick') })])),
        el('label', { className: 'dlabel', textContent: t('devices.announce.writeLabel') }),
        text,
        el('div', { className: 'annopts' },
          el('label', {}, el('span', { textContent: t('devices.announce.style') }), style),
          el('label', {}, el('span', { textContent: t('devices.announce.colour') }), tone),
          el('label', {}, el('span', { textContent: t('devices.announce.stays') }), time)),
        el('div', { className: 'annscreens' }, el('span', { className: 'dlabel', textContent: t('devices.announce.showOn') }), el('div', { className: 'annlist' }, ...screenBoxes.map(({ sc, box }) => el('label', { className: 'chk' }, box, el('span', { textContent: sc.name }))))),
        el('label', { className: 'chk' }, save, t('devices.announce.saveQuick')),
      ),
      el('div', { className: 'dfoot' }, hint, el('span', { className: 'grow' }), el('button', { textContent: t('devices.announce.cancel'), onclick: () => close() }), sendBtn),
    )
  }

  showModal(dialog)
  refresh()
  text.focus()
}
