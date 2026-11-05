import type { PrestreamerApi } from '../preload'
import { TONE_COLORS, MAX_ANNOUNCE_CHARS, type AnnounceStyle, type AnnounceTone, type QuickMessage } from '../shared/announce'
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

const STYLE_LABELS: [AnnounceStyle, string][] = [['banner-bottom', 'Bottom banner'], ['banner-top', 'Top banner'], ['fullscreen', 'Full screen']]
const TONE_LABELS: [AnnounceTone, string][] = [['alert', 'Red (urgent)'], ['notice', 'Amber'], ['info', 'Blue (info)']]
const TIME_LABELS: [string, string][] = [['', 'Until I clear it'], ['10', '10 seconds'], ['30', '30 seconds'], ['60', '1 minute'], ['300', '5 minutes']]

/**
 * Popup for a live announcement. Quick messages go on air with one click; a custom message is typed and sent with
 * Ctrl/Cmd+Enter. The announcement lays over the screens without changing the slide or the video underneath.
 */
export function openAnnounceDialog(deps: AnnounceDeps): void {
  const { api } = deps
  const mem = recall()
  const state = deps.getState()

  const text = el<HTMLTextAreaElement>('textarea', { rows: 3, maxLength: MAX_ANNOUNCE_CHARS, placeholder: 'Type the message to show on the screens…', spellcheck: true })
  const style = el<HTMLSelectElement>('select')
  style.append(...STYLE_LABELS.map(([v, t]) => el<HTMLOptionElement>('option', { value: v, textContent: t, selected: v === mem.style })))
  const tone = el<HTMLSelectElement>('select')
  tone.append(...TONE_LABELS.map(([v, t]) => el<HTMLOptionElement>('option', { value: v, textContent: t, selected: v === mem.tone })))
  const time = el<HTMLSelectElement>('select')
  time.append(...TIME_LABELS.map(([v, t]) => el<HTMLOptionElement>('option', { value: v, textContent: t, selected: v === String(mem.autoHideSec ?? '') })))
  const save = el<HTMLInputElement>('input', { type: 'checkbox' })

  const screenBoxes = state.screens.map((sc) => ({ sc, box: el<HTMLInputElement>('input', { type: 'checkbox', checked: mem.screens === null || mem.screens.includes(sc.id) }) }))
  const chosen = () => screenBoxes.filter((b) => b.box.checked).map((b) => b.sc.id)

  const sendBtn = el<HTMLButtonElement>('button', { className: 'danger', textContent: 'Show now' })
  const hint = el('span', { className: 'dim' })
  let closeDialog: () => void = () => {}

  const refresh = () => {
    const none = chosen().length === 0
    sendBtn.disabled = !text.value.trim() || none
    hint.textContent = none ? 'Choose at least one screen.' : ''
  }

  /** Puts a message on air. All screens ticked is stored as "every screen", so a screen added later shows it too. */
  async function send(message: string, st: AnnounceStyle, tn: AnnounceTone): Promise<void> {
    const ids = chosen()
    if (!message.trim() || !ids.length) return
    const autoHideSec = time.value ? Number(time.value) : null
    const screens = ids.length === state.screens.length ? null : ids
    const ok = await api.announceShow({ text: message, style: st, tone: tn, screens, autoHideSec })
    if (!ok) return
    remember({ style: st, tone: tn, autoHideSec, screens })
    if (save.checked && message === text.value.trim()) deps.setQuick(await api.announceQuickSave({ id: crypto.randomUUID(), text: message.trim(), style: st, tone: tn }))
    closeDialog()
  }

  const quickRow = (q: QuickMessage): HTMLElement => {
    const go = el('button', { className: 'qbtn', title: 'Show this on the screens now', onclick: () => void send(q.text, q.style, q.tone) }, q.text)
    go.style.borderLeftColor = TONE_COLORS[q.tone]
    const del = iconButton('trash', 'Delete this quick message', async () => {
      if (!(await confirmDialog({ title: 'Delete quick message?', message: q.text, confirm: 'Delete', danger: true }))) return
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
      el('h3', { className: 'dhead', textContent: 'Live announcement' }),
      el('div', { className: 'dbody' },
        ...(live ? [el('div', { className: 'annlive' }, el('span', { textContent: `On air now: “${live.text}”` }), el('button', { className: 'danger', textContent: 'Clear it', onclick: () => { void api.announceClear(); close() } }))] : []),
        el('label', { className: 'dlabel', textContent: 'Quick messages (click to show at once)' }),
        el('div', { className: 'qlist' }, ...(quick.length ? quick.map(quickRow) : [el('div', { className: 'dim', textContent: 'None saved yet. Tick "Save as a quick message" below when you send a custom one.' })])),
        el('label', { className: 'dlabel', textContent: 'Or write a message (Ctrl/Cmd+Enter to show)' }),
        text,
        el('div', { className: 'annopts' },
          el('label', {}, el('span', { textContent: 'Style' }), style),
          el('label', {}, el('span', { textContent: 'Colour' }), tone),
          el('label', {}, el('span', { textContent: 'Stays' }), time)),
        el('div', { className: 'annscreens' }, el('span', { className: 'dlabel', textContent: 'Show on' }), ...screenBoxes.map(({ sc, box }) => el('label', { className: 'chk' }, box, ` ${sc.name}`))),
        el('label', { className: 'chk' }, save, ' Save as a quick message'),
      ),
      el('div', { className: 'dfoot' }, hint, el('span', { className: 'grow' }), el('button', { textContent: 'Cancel', onclick: () => close() }), sendBtn),
    )
  }

  showModal(dialog)
  refresh()
  text.focus()
}
