import type { PrestreamerApi } from '../preload'
import { SCREEN_LIMITS, SIZE_PRESETS } from '../shared/screens'
import type { DisplayInfo, ScreenConfig, ScreenState } from '../shared/types'
import { confirmDialog } from './dialogs'
import { iconButton } from './icons'

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
export function createSettingsView(root: HTMLElement, api: PrestreamerApi, toggleScreen: (id: string) => void) {
  let lastSignature = ''
  let newName = ''
  let newPreset = 0

  function screenCard(sc: ScreenConfig, state: ScreenState, index: number): HTMLElement {
    const live = state.live.includes(sc.id)
    const name = el<HTMLInputElement>('input', { type: 'text', value: sc.name, maxLength: 40 })
    name.onchange = () => { const v = name.value.trim(); if (v) void api.updateScreen(sc.id, { name: v }) }

    const rows: HTMLElement[] = []
    if (sc.kind === 'display') {
      const select = el<HTMLSelectElement>('select')
      select.append(el<HTMLOptionElement>('option', { value: '', textContent: 'None (opens in a window)', selected: sc.displayId === null }))
      state.displays.forEach((d, i) => {
        const other = state.screens.find((x) => x.id !== sc.id && x.kind === 'display' && x.displayId === d.id)
        select.append(el<HTMLOptionElement>('option', { value: String(d.id), textContent: `${i + 1} · ${d.label} · ${d.width}×${d.height}${d.primary ? ' · main display' : ''}${other ? ` (also used by ${other.name})` : ''}`, selected: sc.displayId === d.id }))
      })
      // A saved binding whose display is not connected right now stays visible instead of silently showing "None".
      if (sc.displayId !== null && !state.displays.some((d) => d.id === sc.displayId)) {
        select.append(el<HTMLOptionElement>('option', { value: String(sc.displayId), textContent: `${sc.displayLabel ?? 'Display'} (not connected)`, selected: true }))
      }
      select.onchange = () => void api.updateScreen(sc.id, { displayId: select.value ? Number(select.value) : null })
      rows.push(el('label', { className: 'srow2' }, el('span', { textContent: 'Display' }), select))
      const followed = state.screens.some((x) => x.mirrorOf === sc.id)
      const targets = state.screens.filter((x) => x.id !== sc.id && !x.mirrorOf)
      if (!followed && targets.length) {
        const mirror = el<HTMLSelectElement>('select', { title: 'Show exactly what another screen shows (for example the stream, on a stage monitor)' })
        mirror.append(el<HTMLOptionElement>('option', { value: '', textContent: 'No: this screen has its own look', selected: !sc.mirrorOf }), ...targets.map((x) => el<HTMLOptionElement>('option', { value: x.id, textContent: `Mirror ${x.name}`, selected: sc.mirrorOf === x.id })))
        mirror.onchange = () => void api.updateScreen(sc.id, { mirrorOf: mirror.value })
        rows.push(el('label', { className: 'srow2' }, el('span', { textContent: 'Shows' }), mirror))
      }
      // A full-screen output on the display that also hosts this window would cover the controls while it is live.
      const bound = state.displays.find((d) => d.id === sc.displayId)
      if (bound?.primary && state.displays.length > 1) rows.push(el('div', { className: 'warn', textContent: 'This is your main display, where this window is. While live, the screen will cover it. Pick another display for the audience.' }))
      else if (bound?.primary) rows.push(el('div', { className: 'warn', textContent: 'This is your only display, so a live screen will cover this window. Use "None (opens in a window)" until a second display is connected.' }))
    } else {
      const w = el<HTMLInputElement>('input', { type: 'number', value: String(sc.width), min: String(SCREEN_LIMITS.width[0]), max: String(SCREEN_LIMITS.width[1]) })
      const h = el<HTMLInputElement>('input', { type: 'number', value: String(sc.height), min: String(SCREEN_LIMITS.height[0]), max: String(SCREEN_LIMITS.height[1]) })
      const commit = () => void api.updateScreen(sc.id, { width: Number(w.value), height: Number(h.value) })
      w.onchange = commit
      h.onchange = commit
      const preset = el<HTMLSelectElement>('select')
      preset.append(el<HTMLOptionElement>('option', { value: '', textContent: 'Preset…' }), ...SIZE_PRESETS.map((p, i) => el<HTMLOptionElement>('option', { value: String(i), textContent: p.label })))
      preset.onchange = () => { const p = SIZE_PRESETS[Number(preset.value)]; if (p) void api.updateScreen(sc.id, { width: p.width, height: p.height }) }
      rows.push(el('label', { className: 'srow2' }, el('span', { textContent: 'Size' }), el('span', { className: 'inl' }, w, el('span', { textContent: '×' }), h, preset)))
    }

    const sound = el<HTMLInputElement>('input', { type: 'checkbox', checked: sc.look.videoAudio })
    sound.onchange = () => void api.updateScreen(sc.id, { look: { ...sc.look, videoAudio: sound.checked } })
    if (!sc.mirrorOf) rows.push(el('label', { className: 'srow2' }, el('span', { textContent: 'Video sound' }), el('span', { className: 'inl' }, sound, el('span', { className: 'dim', textContent: 'play the sound of video cues from this screen' }))))

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
        name,
        el('span', { className: 'badge', textContent: sc.kind === 'display' ? 'Display screen' : 'Virtual screen' }),
        el('button', { className: live ? 'danger' : 'primary', textContent: live ? 'Close' : 'Open', title: live ? `Close ${sc.name}` : `Open ${sc.name}`, onclick: () => toggleScreen(sc.id) }),
        iconButton('up', 'Move up: higher priority', () => void api.moveScreen(sc.id, -1), { size: 15, disabled: index === 0 }),
        iconButton('down', 'Move down: lower priority', () => void api.moveScreen(sc.id, 1), { size: 15, disabled: index === state.screens.length - 1 }),
        del,
      ),
      ...rows,
    )
  }

  function render(state: ScreenState, force = false): void {
    const signature = JSON.stringify([state.screens, state.displays, state.live])
    if (!force && signature === lastSignature) return
    lastSignature = signature

    const displays = el('div', { className: 'setsec' },
      el('div', { className: 'sethead2' }, el('h2', { textContent: 'Displays' }), iconButton('screen', 'Show a number on every display for three seconds', () => void api.identifyDisplays(), { label: 'Identify displays' })),
      ...state.displays.map((d, i) => el('div', { className: 'drow', textContent: `${i + 1}   ${d.label} · ${d.width}×${d.height} at (${d.x}, ${d.y})${d.primary ? ' · primary' : ''}` })),
      state.displays.length ? displayMap(state.displays) : el('div', { className: 'dim', textContent: 'No displays detected.' }),
      el('p', { className: 'dim', textContent: 'Plug in a monitor or projector and it appears here at once. A display screen below is shown full-screen on the display you pick.' }),
    )

    const nameInput = el<HTMLInputElement>('input', { type: 'text', placeholder: `Virtual ${state.screens.filter((s) => s.kind === 'virtual').length + 1}`, value: newName, maxLength: 40 })
    nameInput.oninput = () => { newName = nameInput.value }
    const presetSelect = el<HTMLSelectElement>('select')
    presetSelect.append(...SIZE_PRESETS.map((p, i) => el<HTMLOptionElement>('option', { value: String(i), textContent: p.label, selected: i === newPreset })))
    presetSelect.onchange = () => { newPreset = Number(presetSelect.value) }

    // Both ways of adding a screen sit together, at the top.
    const addBar = el('div', { className: 'setcard addbar' },
      el('strong', { textContent: 'Add a screen' }),
      iconButton('screen', 'A screen shown full-screen on a display', () => void api.addDisplayScreen(`Display screen ${state.screens.filter((s) => s.kind === 'display').length + 1}`), { badge: true, label: 'Display screen' }),
      iconButton('screen', 'A monitor for the people on stage: the current slide, the next one and the clock. Not shown on the stream.', () => void api.addDisplayScreen(`Stage monitor ${state.screens.filter((s) => s.look.layout === 'stage').length + 1}`, { stage: true }), { label: 'Stage monitor' }),
      iconButton('screen', 'A display that shows exactly what the stream shows: the same picture, text and announcements, for the people on stage.', () => {
        const stream = state.screens.find((s) => s.kind === 'virtual')
        void api.addDisplayScreen(`Stream monitor ${state.screens.filter((s) => s.mirrorOf).length + 1}`, { mirrorOf: stream?.id })
      }, { label: 'Stream mirror' }),
      el('span', { className: 'sep' }),
      nameInput,
      presetSelect,
      iconButton('plus', 'A screen rendered inside PreStreamer, for the stream', () => {
        const p = SIZE_PRESETS[newPreset] ?? SIZE_PRESETS[0]
        void api.addVirtual(newName.trim() || nameInput.placeholder, p.width, p.height)
        newName = ''
      }, { label: 'Virtual screen' }),
    )

    const screens = el('div', { className: 'setsec' },
      el('div', { className: 'sethead2' }, el('h2', { textContent: 'Screens' })),
      addBar,
      el('p', { className: 'dim', textContent: 'The order is the priority: it is the order of the screens in the Present tab, and the top screen is the one whose look is used for slide previews. Use the arrows to change it.' }),
      ...state.screens.map((sc, i) => screenCard(sc, state, i)),
      el('p', { className: 'dim', textContent: 'A virtual screen is rendered inside PreStreamer, not shown on a monitor: it is what the stream picks up (and where text over a camera is composed). It does not appear as a display in macOS or Windows. Colours, fonts, backgrounds, video source and the caption layout are set per screen with its ⚙ button in the Present tab.' }),
    )

    root.replaceChildren(displays, screens)
  }

  return { render }
}
