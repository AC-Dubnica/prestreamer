import type { PrestreamerApi } from '../preload'
import { defaultAppearance, type Appearance } from '../shared/appearance'
import { mediaThumb, pickBackground } from './background-picker'
import type { DisplayInfo, ScreenConfig, ScreenState } from '../shared/types'
import { idleAtem, type AtemStatus } from '../shared/atem'
import { idleDmx } from '../shared/dmx'
import { createDmxSettings } from './dmx-settings'
import { createYoutubeSettings } from './youtube-settings'
import { createLanguageSettings } from './language-settings'
import { t } from '../shared/i18n'
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
  box.innerHTML = `<svg width="${(maxX - minX) * scale + 2}" height="${(maxY - minY) * scale + 2}" role="img" aria-label="${t('settings.displays.mapAria')}">${rects}</svg>`
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
  const dmxPage = createDmxSettings(api, idleDmx)
  const languagePage = createLanguageSettings(api)
  const youtubePage = createYoutubeSettings(api)
  let appearanceNote = ''
  // The categories listed down the left side; the one open is remembered.
  const CATEGORIES = [
    { id: 'visuals', label: t('settings.cat.visuals.label'), icon: 'image', hint: t('settings.cat.visuals.hint') },
    { id: 'screens', label: t('settings.cat.screens.label'), icon: 'present', hint: t('settings.cat.screens.hint') },
    { id: 'stream', label: t('settings.cat.stream.label'), icon: 'play', hint: t('settings.cat.stream.hint') },
    { id: 'youtube', label: 'YouTube', icon: 'youtube', hint: t('settings.cat.youtube.hint') },
    { id: 'atem', label: 'ATEM', icon: 'camera', hint: t('settings.cat.atem.hint') },
    { id: 'dmx', label: 'DMX', icon: 'bulb', hint: t('settings.cat.dmx.hint') },
    { id: 'language', label: t('settings.cat.language.label'), icon: 'globe', hint: t('settings.cat.language.hint') },
  ] as const
  type CategoryId = (typeof CATEGORIES)[number]['id']
  const CATEGORY_KEY = 'prestreamer.settingsCategory'
  const recallCategory = (): CategoryId => { try { const v = localStorage.getItem(CATEGORY_KEY) === 'displays' ? 'screens' : localStorage.getItem(CATEGORY_KEY); return CATEGORIES.find((c) => c.id === v)?.id ?? 'visuals' } catch { return 'visuals' } }
  let category: CategoryId = recallCategory()

  function screenCard(sc: ScreenConfig, state: ScreenState, index: number): HTMLElement {
    const live = state.live.includes(sc.id)
    const bound = state.displays.find((d) => d.id === sc.displayId)
    // A summary: what the screen is for, and where it is (or how big). Everything is changed in the Edit dialog.
    const ndi = sc.kind === 'ndi' ? state.ndi[sc.id] : undefined
    const where = sc.kind !== 'display'
      ? `${sc.width}×${sc.height}${sc.kind === 'ndi' ? ' · NDI' : ''}`
      : sc.displayId === null ? t('settings.card.window') : bound ? t(bound.primary ? 'settings.card.displayMain' : 'settings.card.display', { n: state.displays.indexOf(bound) + 1, label: bound.label, size: `${bound.width}×${bound.height}` }) : t('settings.card.notConnected', { label: sc.displayLabel ?? t('settings.card.displayWord') })
    const warn = sc.kind === 'display' && bound?.primary ? el('div', { className: 'warn', textContent: state.displays.length > 1 ? t('settings.card.mainWarn') : t('settings.card.onlyWarn') }) : null

    const del = iconButton('trash', t('settings.card.removeTitle'), async () => {
      const ok = await confirmDialog({
        title: t('settings.card.removeConfirmTitle', { name: sc.name }),
        message: t(live ? 'settings.card.removeConfirmLive' : 'settings.card.removeConfirm', { name: sc.name }),
        confirm: t('settings.card.removeConfirmButton'),
        danger: true,
      })
      if (ok) void api.removeScreen(sc.id)
    })

    return el('div', { className: 'setcard' },
      el('div', { className: 'sethead' },
        el('span', { className: `dot ${live ? 'on' : ''}` }),
        el('strong', { className: 'scname', textContent: sc.name }),
        el('span', { className: 'badge', textContent: sc.kind === 'display' ? t('settings.kind.display') : sc.kind === 'ndi' ? t('settings.kind.ndi') : t('settings.kind.virtual') }),
        el('span', { className: 'grow' }),
        el('button', { className: live ? 'danger' : 'primary', textContent: live ? t('settings.card.close') : t('settings.card.open'), title: t(live ? 'settings.card.closeTitle' : 'settings.card.openTitle', { name: sc.name }), onclick: () => toggleScreen(sc.id) }),
        iconButton('gear', t('settings.card.lookTitle'), () => deps.configure(sc.id), { size: 15, label: t('settings.card.look') }),
        iconButton('pencil', t('settings.card.editTitle'), () => openScreenForm(api, () => lastState ?? state, sc.id, { streaming: deps.streaming }), { size: 15, label: t('settings.card.edit') }),
        iconButton('up', t('settings.card.moveUp'), () => void api.moveScreen(sc.id, -1), { size: 15, disabled: index === 0 }),
        iconButton('down', t('settings.card.moveDown'), () => void api.moveScreen(sc.id, 1), { size: 15, disabled: index === state.screens.length - 1 }),
        del,
      ),
      el('div', { className: 'scrole', textContent: describeRole(sc, state) }),
      el('div', { className: 'dim', textContent: where }),
      ...(warn ? [warn] : []),
      ...(ndi ? [el('div', { className: ndi.state === 'error' ? 'warn' : 'dim', textContent: ndi.message })] : []),
    )
  }

  /** The Stream page: the only place for stream settings (the Present tab's Stream section just starts and stops it). */
  function streamSection(): HTMLElement {
    streamPage ??= createStreamSettings({ api, ...deps.stream })
    streamPage.refresh()
    return el('div', { className: 'setsec' }, el('div', { className: 'sethead2' }, el('h2', { textContent: t('settings.cat.stream.label') })), streamPage.root)
  }

  /** The ATEM page: where the switcher is, and which switching buttons the panels (Present and Monitor tabs) show. */
  function atemSection(): HTMLElement {
    const tick = (label: string, hint: string, key: 'preview' | 'cut' | 'auto') => {
      const box = el<HTMLInputElement>('input', { type: 'checkbox', checked: atemStatus.buttons[key] })
      box.onchange = () => void api.atemSetButtons({ [key]: box.checked }).then((s) => { atemStatus = s })
      return el('label', { className: 'srow2' }, el('span', { textContent: label }), el('span', { className: 'inl' }, box, el('span', { className: 'dim', textContent: hint })))
    }
    const change = el('button', { textContent: t('settings.change'), onclick: async () => {
      const value = await askText({ title: t('settings.atem.addressTitle'), label: t('settings.atem.addressLabel'), value: atemStatus.address, placeholder: '192.168.10.240', confirm: t('settings.atem.connect') })
      if (value !== null) atemStatus = await api.atemSetAddress(value)
      if (lastState) render(lastState, true)
    } })
    return el('div', { className: 'setsec' },
      el('div', { className: 'sethead2' }, el('h2', { textContent: t('settings.atem.title') })),
      el('div', { className: 'setcard' },
        el('div', { className: 'sethead' }, el('span', { className: `dot ${atemStatus.state === 'connected' ? 'on' : ''}` }), el('strong', { className: 'scname', textContent: atemStatus.state === 'connected' ? atemStatus.model : t('settings.atem.notConnected') }), el('span', { className: 'grow' })),
        el('div', { className: 'dim', textContent: atemStatus.message }),
        el('label', { className: 'srow2' }, el('span', { textContent: t('settings.atem.address') }), el('span', { className: 'inl' }, el('span', { textContent: atemStatus.address }), change)),
      ),
      el('h3', { className: 'sethead3', textContent: t('settings.atem.buttons') }),
      el('div', { className: 'setcard' },
        el('label', { className: 'srow2' }, el('span', { textContent: t('settings.atem.program') }), el('span', { className: 'dim', textContent: t('settings.atem.programHint') })),
        tick(t('settings.atem.preview'), t('settings.atem.previewHint'), 'preview'),
        tick(t('settings.atem.cut'), t('settings.atem.cutHint'), 'cut'),
        tick(t('settings.atem.auto'), t('settings.atem.autoHint'), 'auto'),
      ),
      el('p', { className: 'dim', textContent: t('settings.atem.note') }),
    )
  }

  /** One row of the "Backgrounds and logo" section: what is set, a button to choose, and one to clear it. */
  function lookRow(label: string, hint: string, current: { kind: 'image' | 'video'; file: string } | null, choose: () => void, clear: () => void): HTMLElement {
    return el('div', { className: 'lookrow' },
      el('div', { className: 'lookname' }, el('strong', { textContent: label }), el('span', { className: 'dim', textContent: hint })),
      current ? mediaThumb(current) : el('div', { className: 'mthumb none', textContent: t('settings.look.none') }),
      el('button', { textContent: current ? t('settings.change') : t('settings.choose'), onclick: choose }),
      iconButton('x', t('settings.look.clear', { what: label.toLowerCase() }), clear, { size: 15, disabled: !current }),
    )
  }

  async function chooseBackground(title: string, current: Appearance['songBackground'], apply: (bg: { kind: 'image' | 'video'; file: string } | null) => Appearance): Promise<void> {
    const bg = await pickBackground(api, current, { title, noneLabel: t('settings.look.noBackground'), noneHint: t('settings.look.noBackgroundHint') })
    if (bg === undefined) return
    if (bg !== null && bg.kind === 'css') return
    appearance = await api.appearanceSet(apply(bg))
    appearanceNote = ''
    if (lastState) render(lastState, true)
  }

  function lookSection(): HTMLElement {
    const save = async (next: Appearance, note = '') => { appearance = await api.appearanceSet(next); appearanceNote = note; if (lastState) render(lastState, true) }
    return el('div', { className: 'setsec' },
      el('div', { className: 'sethead2' }, el('h2', { textContent: t('settings.look.title') })),
      el('div', { className: 'setcard' },
        lookRow(t('settings.look.songs'), t('settings.look.songsHint'), appearance.songBackground,
          () => void chooseBackground(t('settings.look.songsPick'), appearance.songBackground, (bg) => ({ ...appearance, songBackground: bg })),
          () => void save({ ...appearance, songBackground: null })),
        lookRow(t('settings.look.scripture'), t('settings.look.scriptureHint'), appearance.scriptureBackground,
          () => void chooseBackground(t('settings.look.scripturePick'), appearance.scriptureBackground, (bg) => ({ ...appearance, scriptureBackground: bg })),
          () => void save({ ...appearance, scriptureBackground: null })),
        lookRow(t('settings.look.logo'), t('settings.look.logoHint'), appearance.logo ? { kind: 'image', file: appearance.logo } : null,
          async () => {
            const bg = await pickBackground(api, appearance.logo ? { kind: 'image', file: appearance.logo } : null, { title: t('settings.look.logoPick'), noneLabel: t('settings.look.noLogo'), noneHint: t('settings.look.noLogoHint') })
            if (bg === undefined) return
            if (bg === null) return void save({ ...appearance, logo: null })
            if (bg.kind !== 'image') return void save(appearance, t('settings.look.logoMustBePicture'))
            void save({ ...appearance, logo: bg.file })
          },
          () => void save({ ...appearance, logo: null })),
        el('div', { className: 'dim', textContent: appearanceNote }),
      ),
      el('p', { className: 'dim', textContent: t('settings.look.precedence') }),
    )
  }

  function render(state: ScreenState, force = false): void {
    lastState = state
    const signature = JSON.stringify([state.screens, state.displays, state.live])
    if (!force && signature === lastSignature) return
    lastSignature = signature

    const displays = el('div', { className: 'setsec' },
      el('div', { className: 'sethead2' }, el('h2', { textContent: t('settings.displays.title') }), iconButton('screen', t('settings.displays.identifyTitle'), () => void api.identifyDisplays(), { label: t('settings.displays.identify') })),
      ...state.displays.map((d, i) => el('div', { className: 'drow', textContent: t(d.primary ? 'settings.displays.rowPrimary' : 'settings.displays.row', { n: i + 1, label: d.label, size: `${d.width}×${d.height}`, x: d.x, y: d.y }) })),
      state.displays.length ? displayMap(state.displays) : el('div', { className: 'dim', textContent: t('settings.displays.none') }),
      el('p', { className: 'dim', textContent: t('settings.displays.note') }),
    )

    const addBar = el('div', { className: 'addbar' },
      el('button', { className: 'primary', textContent: t('settings.screens.add'), title: t('settings.screens.addTitle'), onclick: () => openScreenForm(api, () => lastState ?? state, null, { streaming: deps.streaming }) }),
      el('span', { className: 'dim', textContent: t('settings.screens.addHint') }),
    )

    const screens = el('div', { className: 'setsec' },
      el('div', { className: 'sethead2' }, el('h2', { textContent: t('settings.cat.screens.label') })),
      addBar,
      el('p', { className: 'dim', textContent: t('settings.screens.order') }),
      ...state.screens.map((sc, i) => screenCard(sc, state, i)),
      el('p', { className: 'dim', textContent: t('settings.screens.virtualNote') }),
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
    root.replaceChildren(nav, el('div', { className: 'setbody', role: 'tabpanel' }, ...(category === 'visuals' ? [lookSection()] : category === 'stream' ? [streamSection()] : category === 'atem' ? [atemSection()] : category === 'dmx' ? [dmxPage.root] : category === 'youtube' ? [youtubePage.root] : category === 'language' ? [languagePage.root] : [displays, screens])))
  }

  void api.atemGet().then((s) => { atemStatus = s; if (category === 'atem' && lastState) render(lastState, true) })
  api.onAtem((s) => { atemStatus = s; if (category === 'atem' && lastState) render(lastState, true) })
  void api.dmxGet().then((s) => dmxPage.update(s))
  api.onDmx((s) => dmxPage.update(s))
  void api.youtubeGet().then((s) => youtubePage.update(s))
  api.onYoutube((s) => youtubePage.update(s))

  return {
    render,
    /** The stream started or stopped, or its settings or the screens changed: bring the Stream page up to date if it is open. */
    refreshStream(): void { if (category === 'stream') streamPage?.refresh() },
    /** The saved look changed (here or elsewhere, e.g. a library file was deleted). */
    setAppearance(a: Appearance): void { appearance = a; if (lastState) render(lastState, true) },
  }
}
