import type { PrestreamerApi } from '../preload'
import { defaultAppearance, type Appearance } from '../shared/appearance'
import { mediaThumb, pickBackground } from './background-picker'
import type { DisplayInfo, ScreenConfig, ScreenState } from '../shared/types'
import { idleAtem, type AtemStatus } from '../shared/atem'
import { askText, confirmDialog } from './dialogs'
import { iconButton } from './icons'
import { describeRole, openScreenForm } from './screen-form'
import { createStreamSettings, type StreamDialogDeps } from './stream-settings'

function el<T extends HTMLElement = HTMLElement>(tag: string, props: Partial<T> = {}, ...kids: (Node | string)[]): T {
  const e = Object.assign(document.createElement(tag) as T, props)
  e.append(...kids)
  return e
}

/** A small map of how the physical displays are arranged, numbered like the "Identify" overlay. */
function displayMap(displays: DisplayInfo[]): HTMLElement {
  const minX = Math.min(...displays.map((d) => d.x))
  const minY = Math.min(...displays.map((d) => d.y))
  const maxX = Math.max(...displays.map((d) => d.x + d.width))
  const maxY = Math.max(...displays.map((d) => d.y + d.height))
  const scale = Math.min(420 / (maxX - minX), 130 / (maxY - minY))
  const rects = displays
    .map((d, i) => {
      const x = (d.x - minX) * scale
      const y = (d.y - minY) * scale
      const w = d.width * scale
      const h = d.height * scale
      return `<rect x="${x + 1}" y="${y + 1}" width="${w - 2}" height="${h - 2}" rx="4" fill="${d.primary ? '#1e3a8a' : '#1f2937'}" stroke="#3b82f6" stroke-width="1.5"/>` +
        `<text x="${x + w / 2}" y="${y + h / 2 + 8}" text-anchor="middle" font-size="24" font-weight="700" fill="#e5e7eb">${i + 1}</text>`
    })
    .join('')
  const box = el('div', { className: 'dmap' })
  box.innerHTML = `<svg width="${(maxX - minX) * scale + 2}" height="${(maxY - minY) * scale + 2}" role="img" aria-label="Display arrangement">${rects}</svg>`
  return box
}

/**
 * The Settings tab: detected displays and the screens (outputs) built on them.
 * It only rebuilds when the screens or displays change, so a slide change does not steal focus from a field you are editing.
 */
export function createSettingsView(root: HTMLElement, api: PrestreamerApi, toggleScreen: (id: string) => void, deps: { configure: (id: string) => void; streaming: () => boolean; stream: Omit<StreamDialogDeps, 'api'> }) {
  let lastSignature = ''
  let appearance: Appearance = defaultAppearance
  let lastState: ScreenState | null = null
  let atemStatus: AtemStatus = idleAtem
  let streamPage: ReturnType<typeof createStreamSettings> | null = null
  let appearanceNote = ''
  // The categories listed down the left side; the one open is remembered.
  const CATEGORIES = [
    { id: 'visuals', label: 'Visuals', icon: 'image', hint: 'Backgrounds for songs and Bible readings, and the logo' },
    { id: 'screens', label: 'Screens', icon: 'present', hint: 'The outputs (audience displays, stage monitor, stream, mirrors) and the monitors connected to this computer' },
    { id: 'stream', label: 'Stream', icon: 'play', hint: 'Where the stream goes (YouTube or a file), the screen and key, and how it is encoded' },
    { id: 'atem', label: 'ATEM', icon: 'camera', hint: 'The video switcher: its address and which switching buttons to show' },
  ] as const
  type CategoryId = (typeof CATEGORIES)[number]['id']
  const CATEGORY_KEY = 'prestreamer.settingsCategory'
  const recallCategory = (): CategoryId => { try { const v = localStorage.getItem(CATEGORY_KEY) === 'displays' ? 'screens' : localStorage.getItem(CATEGORY_KEY); return CATEGORIES.find((c) => c.id === v)?.id ?? 'visuals' } catch { return 'visuals' } }
  let category: CategoryId = recallCategory()

  function screenCard(sc: ScreenConfig, state: ScreenState, index: number): HTMLElement {
    const live = state.live.includes(sc.id)
    const bound = state.displays.find((d) => d.id === sc.displayId)
    // A summary: what the screen is for, and where it is (or how big). Everything is changed in the Edit dialog.
    const where = sc.kind === 'virtual'
      ? `${sc.width}×${sc.height}`
      : sc.displayId === null ? 'Opens in a window (no display chosen)' : bound ? `Display ${state.displays.indexOf(bound) + 1} · ${bound.label} · ${bound.width}×${bound.height}${bound.primary ? ' · main display' : ''}` : `${sc.displayLabel ?? 'Display'} (not connected)`
    const warn = sc.kind === 'display' && bound?.primary ? el('div', { className: 'warn', textContent: state.displays.length > 1 ? 'This is your main display, where this window is. While live, the screen covers it.' : 'This is your only display, so a live screen covers this window.' }) : null

    const del = iconButton('trash', 'Remove this screen', async () => {
      const ok = await confirmDialog({
        title: `Remove ${sc.name}?`,
        message: `${sc.name} and its look (colours, fonts, source, sound) will be deleted.${live ? ' It is open now and will be closed.' : ''}`,
        confirm: 'Remove screen',
        danger: true,
      })
      if (ok) void api.removeScreen(sc.id)
    })

    return el('div', { className: 'setcard' },
      el('div', { className: 'sethead' },
        el('span', { className: `dot ${live ? 'on' : ''}` }),
        el('strong', { className: 'scname', textContent: sc.name }),
        el('span', { className: 'badge', textContent: sc.kind === 'display' ? 'Display screen' : 'Virtual screen' }),
        el('span', { className: 'grow' }),
        el('button', { className: live ? 'danger' : 'primary', textContent: live ? 'Close' : 'Open', title: live ? `Close ${sc.name}` : `Open ${sc.name}`, onclick: () => toggleScreen(sc.id) }),
        iconButton('gear', 'Look: colours, fonts, background, text layout, video source', () => deps.configure(sc.id), { size: 15, label: 'Look…' }),
        iconButton('pencil', 'Change name, what it shows, display or size', () => openScreenForm(api, () => lastState ?? state, sc.id, { streaming: deps.streaming }), { size: 15, label: 'Edit…' }),
        iconButton('up', 'Move up: higher priority', () => void api.moveScreen(sc.id, -1), { size: 15, disabled: index === 0 }),
        iconButton('down', 'Move down: lower priority', () => void api.moveScreen(sc.id, 1), { size: 15, disabled: index === state.screens.length - 1 }),
        del,
      ),
      el('div', { className: 'scrole', textContent: describeRole(sc, state) }),
      el('div', { className: 'dim', textContent: where }),
      ...(warn ? [warn] : []),
    )
  }

  /** The Stream page: the only place for stream settings (the Present tab's Stream section just starts and stops it). */
  function streamSection(): HTMLElement {
    streamPage ??= createStreamSettings({ api, ...deps.stream })
    streamPage.refresh()
    return el('div', { className: 'setsec' }, el('div', { className: 'sethead2' }, el('h2', { textContent: 'Stream' })), streamPage.root)
  }

  /** The ATEM page: where the switcher is, and which switching buttons the panels (Present and Monitor tabs) show. */
  function atemSection(): HTMLElement {
    const tick = (label: string, hint: string, key: 'preview' | 'cut' | 'auto') => {
      const box = el<HTMLInputElement>('input', { type: 'checkbox', checked: atemStatus.buttons[key] })
      box.onchange = () => void api.atemSetButtons({ [key]: box.checked }).then((s) => { atemStatus = s })
      return el('label', { className: 'srow2' }, el('span', { textContent: label }), el('span', { className: 'inl' }, box, el('span', { className: 'dim', textContent: hint })))
    }
    const change = el('button', { textContent: 'Change…', onclick: async () => {
      const value = await askText({ title: 'ATEM address', label: 'IP address of the switcher (ATEM Software Control shows it; factory setting 192.168.10.240)', value: atemStatus.address, placeholder: '192.168.10.240', confirm: 'Connect' })
      if (value !== null) atemStatus = await api.atemSetAddress(value)
      if (lastState) render(lastState, true)
    } })
    return el('div', { className: 'setsec' },
      el('div', { className: 'sethead2' }, el('h2', { textContent: 'ATEM switcher' })),
      el('div', { className: 'setcard' },
        el('div', { className: 'sethead' }, el('span', { className: `dot ${atemStatus.state === 'connected' ? 'on' : ''}` }), el('strong', { className: 'scname', textContent: atemStatus.state === 'connected' ? atemStatus.model : 'Not connected' }), el('span', { className: 'grow' })),
        el('div', { className: 'dim', textContent: atemStatus.message }),
        el('label', { className: 'srow2' }, el('span', { textContent: 'Address' }), el('span', { className: 'inl' }, el('span', { textContent: atemStatus.address }), change)),
      ),
      el('h3', { className: 'sethead3', textContent: 'Buttons in the ATEM panels' }),
      el('div', { className: 'setcard' },
        el('label', { className: 'srow2' }, el('span', { textContent: 'Program' }), el('span', { className: 'dim', textContent: 'always shown: one button per input' })),
        tick('Preview', 'the preview row, to line up the next camera before a Cut or Auto', 'preview'),
        tick('Cut', 'swap preview and program at once', 'cut'),
        tick('Auto', 'swap them with the switcher\'s transition', 'auto'),
      ),
      el('p', { className: 'dim', textContent: 'The ATEM is controlled over Ethernet: the Mini\'s USB port is only a webcam. The panels are in the Present tab (under the screens) and the Monitor tab (under the picture), and appear only while a switcher is connected.' }),
    )
  }

  /** One row of the "Backgrounds and logo" section: what is set, a button to choose, and one to clear it. */
  function lookRow(label: string, hint: string, current: { kind: 'image' | 'video'; file: string } | null, choose: () => void, clear: () => void): HTMLElement {
    return el('div', { className: 'lookrow' },
      el('div', { className: 'lookname' }, el('strong', { textContent: label }), el('span', { className: 'dim', textContent: hint })),
      current ? mediaThumb(current) : el('div', { className: 'mthumb none', textContent: 'None' }),
      el('button', { textContent: current ? 'Change…' : 'Choose…', onclick: choose }),
      iconButton('x', `Clear: no ${label.toLowerCase()}`, clear, { size: 15, disabled: !current }),
    )
  }

  async function chooseBackground(title: string, current: Appearance['songBackground'], apply: (bg: { kind: 'image' | 'video'; file: string } | null) => Appearance): Promise<void> {
    const bg = await pickBackground(api, current, { title, noneLabel: 'No background', noneHint: 'Each song or screen keeps its own colour' })
    if (bg === undefined) return
    if (bg !== null && bg.kind === 'css') return
    appearance = await api.appearanceSet(apply(bg))
    appearanceNote = ''
    if (lastState) render(lastState, true)
  }

  function lookSection(): HTMLElement {
    const save = async (next: Appearance, note = '') => { appearance = await api.appearanceSet(next); appearanceNote = note; if (lastState) render(lastState, true) }
    return el('div', { className: 'setsec' },
      el('div', { className: 'sethead2' }, el('h2', { textContent: 'Backgrounds and logo' })),
      el('div', { className: 'setcard' },
        lookRow('Songs', 'behind every song without a picture or video of its own', appearance.songBackground,
          () => void chooseBackground('Background for all songs', appearance.songBackground, (bg) => ({ ...appearance, songBackground: bg })),
          () => void save({ ...appearance, songBackground: null })),
        lookRow('Scripture', 'behind Bible readings without a picture or video of their own', appearance.scriptureBackground,
          () => void chooseBackground('Background for all Bible readings', appearance.scriptureBackground, (bg) => ({ ...appearance, scriptureBackground: bg })),
          () => void save({ ...appearance, scriptureBackground: null })),
        lookRow('Logo', 'shown on every screen by the Logo button (or the L key)', appearance.logo ? { kind: 'image', file: appearance.logo } : null,
          async () => {
            const bg = await pickBackground(api, appearance.logo ? { kind: 'image', file: appearance.logo } : null, { title: 'Choose the logo', noneLabel: 'No logo', noneHint: 'The Logo button stays off' })
            if (bg === undefined) return
            if (bg === null) return void save({ ...appearance, logo: null })
            if (bg.kind !== 'image') return void save(appearance, 'A logo must be a picture, not a video.')
            void save({ ...appearance, logo: bg.file })
          },
          () => void save({ ...appearance, logo: null })),
        el('div', { className: 'dim', textContent: appearanceNote }),
      ),
      el('p', { className: 'dim', textContent: 'A song\'s or slide\'s own picture or video always wins. Next comes the background chosen here, then the background of the screen itself (the ⚙ button on a screen in the Present tab), then its colour.' }),
    )
  }

  function render(state: ScreenState, force = false): void {
    lastState = state
    const signature = JSON.stringify([state.screens, state.displays, state.live])
    if (!force && signature === lastSignature) return
    lastSignature = signature

    const displays = el('div', { className: 'setsec' },
      el('div', { className: 'sethead2' }, el('h2', { textContent: 'Displays' }), iconButton('screen', 'Show a number on every display for three seconds', () => void api.identifyDisplays(), { label: 'Identify displays' })),
      ...state.displays.map((d, i) => el('div', { className: 'drow', textContent: `${i + 1}   ${d.label} · ${d.width}×${d.height} at (${d.x}, ${d.y})${d.primary ? ' · primary' : ''}` })),
      state.displays.length ? displayMap(state.displays) : el('div', { className: 'dim', textContent: 'No displays detected.' }),
      el('p', { className: 'dim', textContent: 'Plug in a monitor or projector and it appears here at once. A display screen below is shown full-screen on the display you pick.' }),
    )

    const addBar = el('div', { className: 'addbar' },
      el('button', { className: 'primary', textContent: 'Add screen…', title: 'A display screen (audience, stage monitor, stream copy) or a virtual screen for the stream', onclick: () => openScreenForm(api, () => lastState ?? state, null, { streaming: deps.streaming }) }),
      el('span', { className: 'dim', textContent: 'Display screens are shown on a monitor or projector; a virtual screen is what the stream picks up.' }),
    )

    const screens = el('div', { className: 'setsec' },
      el('div', { className: 'sethead2' }, el('h2', { textContent: 'Screens' })),
      addBar,
      el('p', { className: 'dim', textContent: 'The order is the priority: it is the order of the screens in the Present tab, and the top screen is the one whose look is used for slide previews. Use the arrows to change it. Look… opens the same settings as the ⚙ on the screen in the Present tab.' }),
      ...state.screens.map((sc, i) => screenCard(sc, state, i)),
      el('p', { className: 'dim', textContent: 'A virtual screen is rendered inside PreStreamer, not shown on a monitor: it is what the stream picks up (and where text over a camera is composed). It does not appear as a display in macOS or Windows.' }),
    )

    const nav = el('nav', { className: 'setnav', role: 'tablist' }, ...CATEGORIES.map((c) => {
      const b = iconButton(c.icon, c.hint, () => {
        category = c.id
        try { localStorage.setItem(CATEGORY_KEY, category) } catch { /* only a convenience */ }
        render(state, true)
      }, { label: c.label, className: c.id === category ? 'on' : '' })
      b.setAttribute('aria-label', c.label)
      b.setAttribute('role', 'tab')
      b.setAttribute('aria-selected', String(c.id === category))
      return b
    }))
    // The connected monitors come first: they are what the screens below are bound to.
    root.replaceChildren(nav, el('div', { className: 'setbody', role: 'tabpanel' }, ...(category === 'visuals' ? [lookSection()] : category === 'stream' ? [streamSection()] : category === 'atem' ? [atemSection()] : [displays, screens])))
  }

  void api.atemGet().then((s) => { atemStatus = s; if (category === 'atem' && lastState) render(lastState, true) })
  api.onAtem((s) => { atemStatus = s; if (category === 'atem' && lastState) render(lastState, true) })

  return {
    render,
    /** The stream started or stopped, or its settings or the screens changed: bring the Stream page up to date if it is open. */
    refreshStream(): void { if (category === 'stream') streamPage?.refresh() },
    /** The saved look changed (here or elsewhere, e.g. a library file was deleted). */
    setAppearance(a: Appearance): void { appearance = a; if (lastState) render(lastState, true) },
  }
}
