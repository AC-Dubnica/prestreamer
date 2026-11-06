import type { PrestreamerApi } from '../preload'
import { SCREEN_LIMITS, SIZE_PRESETS, clampSize, roleOf, rolePatch, type ScreenRole } from '../shared/screens'
import type { DisplayInfo, Look, ScreenConfig, ScreenState } from '../shared/types'
import { showModal } from './dialogs'

function el<T extends HTMLElement = HTMLElement>(tag: string, props: Partial<T> = {}, ...kids: (Node | string)[]): T {
  const e = Object.assign(document.createElement(tag) as T, props)
  e.append(...kids)
  return e
}

type Kind = 'display' | 'virtual'

/** What a screen is for, in words: shown on the card and in the dialog. */
export function describeRole(sc: ScreenConfig, state: ScreenState): string {
  if (sc.kind === 'virtual') return 'For the stream'
  const role = roleOf(sc)
  if (role.kind === 'stage') return 'Stage monitor: current slide, next slide and clock'
  if (role.kind === 'mirror') return `Mirror of ${state.screens.find((s) => s.id === role.of)?.name ?? 'another screen'}`
  return 'Slides in its own look'
}

/**
 * One dialog to add a screen or to edit one. Nothing happens until Apply (Cancel or Esc leave everything as it was).
 * The type (display or virtual) is chosen when adding and cannot change later: they are different kinds of window.
 * Everything else stays editable, including what a display screen shows.
 */
export function openScreenForm(api: PrestreamerApi, getState: () => ScreenState, editing: string | null, opts: { streaming: () => boolean }): void {
  const state0 = getState()
  const existing = editing ? state0.screens.find((s) => s.id === editing) : undefined
  if (editing && !existing) return

  let kind: Kind = existing?.kind ?? 'display'
  let role: ScreenRole = existing ? roleOf(existing) : { kind: 'own' }
  let nameTouched = !!existing
  let displayId: number | null = existing?.displayId ?? null

  const count = (pred: (s: ScreenConfig) => boolean) => state0.screens.filter(pred).length + 1
  const suggestion = (): string => {
    if (kind === 'virtual') return `Virtual screen ${count((s) => s.kind === 'virtual')}`
    if (role.kind === 'stage') return `Stage monitor ${count((s) => roleOf(s).kind === 'stage')}`
    if (role.kind === 'mirror') { const of = role.of; return `${state0.screens.find((s) => s.id === of)?.name ?? 'Screen'} mirror ${count((s) => !!s.mirrorOf)}` }
    return `Display screen ${count((s) => s.kind === 'display' && !s.mirrorOf && roleOf(s).kind === 'own')}`
  }

  const name = el<HTMLInputElement>('input', { type: 'text', maxLength: 40, value: existing?.name ?? '' })
  name.oninput = () => { nameTouched = true; sync() }

  // Type (adding only)
  const kinds = (['display', 'virtual'] as const).map((k) => {
    const b = el<HTMLButtonElement>('button', { className: 'kindcard' },
      el('strong', { textContent: k === 'display' ? 'Display screen' : 'Virtual screen' }),
      el('span', { className: 'dim', textContent: k === 'display' ? 'Shown full-screen on a monitor or projector: the audience, a stage monitor, or a copy of the stream.' : 'Drawn inside PreStreamer, not on a monitor. This is what the stream picks up.' }),
    )
    b.onclick = () => { kind = k; if (!nameTouched) name.value = ''; sync() }
    return { k, b }
  })
  const kindFixed = el('div', { className: 'dim', textContent: existing ? `${existing.kind === 'display' ? 'Display screen' : 'Virtual screen'}: the type is fixed once added` : '' })

  // Display screens
  const shows = el<HTMLSelectElement>('select', { title: 'What this screen shows' })
  const mirrorTargets = state0.screens.filter((x) => x.id !== existing?.id && !x.mirrorOf)
  const followed = !!existing && state0.screens.some((x) => x.mirrorOf === existing.id)
  shows.append(
    el<HTMLOptionElement>('option', { value: 'own', textContent: 'Slides, in its own look' }),
    el<HTMLOptionElement>('option', { value: 'stage', textContent: 'Stage monitor: current slide, next slide, clock' }),
    ...(followed ? [] : mirrorTargets.map((x) => el<HTMLOptionElement>('option', { value: `mirror:${x.id}`, textContent: `Mirror of ${x.name}` }))),
  )
  shows.value = role.kind === 'mirror' ? `mirror:${role.of}` : role.kind
  if (shows.value !== (role.kind === 'mirror' ? `mirror:${role.of}` : role.kind)) shows.value = 'own' // the mirrored screen is gone
  shows.onchange = () => {
    role = shows.value === 'stage' ? { kind: 'stage' } : shows.value.startsWith('mirror:') ? { kind: 'mirror', of: shows.value.slice(7) } : { kind: 'own' }
    sync()
  }
  const showsHint = el('div', { className: 'dim sfhint' })

  const display = el<HTMLSelectElement>('select')
  display.append(el<HTMLOptionElement>('option', { value: '', textContent: 'None (opens in a window)' }))
  state0.displays.forEach((d: DisplayInfo, i: number) => {
    const other = state0.screens.find((x) => x.id !== existing?.id && x.kind === 'display' && x.displayId === d.id)
    display.append(el<HTMLOptionElement>('option', { value: String(d.id), textContent: `${i + 1} · ${d.label} · ${d.width}×${d.height}${d.primary ? ' · main display' : ''}${other ? ` (also used by ${other.name})` : ''}` }))
  })
  if (displayId !== null && !state0.displays.some((d) => d.id === displayId)) display.append(el<HTMLOptionElement>('option', { value: String(displayId), textContent: `${existing?.displayLabel ?? 'Display'} (not connected)` }))
  display.value = displayId === null ? '' : String(displayId)
  display.onchange = () => { displayId = display.value ? Number(display.value) : null; sync() }
  const displayWarn = el('div', { className: 'warn' })

  const sound = el<HTMLInputElement>('input', { type: 'checkbox', checked: existing?.look.videoAudio ?? false })

  // Virtual screens
  const w = el<HTMLInputElement>('input', { type: 'number', value: String(existing?.width ?? SIZE_PRESETS[0].width), min: String(SCREEN_LIMITS.width[0]), max: String(SCREEN_LIMITS.width[1]) })
  const h = el<HTMLInputElement>('input', { type: 'number', value: String(existing?.height ?? SIZE_PRESETS[0].height), min: String(SCREEN_LIMITS.height[0]), max: String(SCREEN_LIMITS.height[1]) })
  const preset = el<HTMLSelectElement>('select')
  const sizeNow = () => `${Number(w.value)}×${Number(h.value)}`
  const syncPreset = () => { const i = SIZE_PRESETS.findIndex((p) => `${p.width}×${p.height}` === sizeNow()); preset.value = i >= 0 ? String(i) : '' }
  preset.append(el<HTMLOptionElement>('option', { value: '', textContent: 'Custom' }), ...SIZE_PRESETS.map((p, i) => el<HTMLOptionElement>('option', { value: String(i), textContent: p.label })))
  preset.onchange = () => { const p = SIZE_PRESETS[Number(preset.value)]; if (p) { w.value = String(p.width); h.value = String(p.height) } sync() }
  w.oninput = h.oninput = () => { syncPreset(); sync() }
  syncPreset()
  const sizeHint = el('div', { className: 'dim sfhint' })
  // The stream is encoded from the first frame's size, so a screen it uses keeps its size until the stream stops.
  const sizeLocked = !!existing && existing.kind === 'virtual' && opts.streaming()
  if (sizeLocked) { w.disabled = true; h.disabled = true; preset.disabled = true }

  const row = (label: string, ...controls: HTMLElement[]) => el('label', { className: 'sdrow' }, el('span', { textContent: label }), el('span', { className: 'inl' }, ...controls))
  const typeRow = el('div', { className: 'sdgroup' }, el('h4', { textContent: 'Type' }), existing ? kindFixed : el('div', { className: 'kindrow' }, ...kinds.map((k) => k.b)))
  const displayGroup = el('div', { className: 'sdgroup' }, el('h4', { textContent: 'Display screen' }), row('Shows', shows), showsHint, row('Display', display), displayWarn, row('Video sound', sound, el('span', { className: 'dim', textContent: 'play the sound of video cues from this screen' })))
  const virtualGroup = el('div', { className: 'sdgroup' }, el('h4', { textContent: 'Size' }), row('Resolution', preset), row('Width × height', w, el('span', { textContent: '×' }), h), sizeHint)

  const apply = el<HTMLButtonElement>('button', { className: 'primary', textContent: existing ? 'Apply' : 'Add screen' })
  const title = el('h3', { className: 'sdtitle', textContent: existing ? `${existing.name} · edit screen` : 'Add a screen' })

  function sync(): void {
    kinds.forEach(({ k, b }) => { b.classList.toggle('on', k === kind); b.setAttribute('aria-pressed', String(k === kind)) })
    name.placeholder = suggestion()
    displayGroup.hidden = kind !== 'display'
    virtualGroup.hidden = kind !== 'virtual'
    sound.disabled = role.kind !== 'own'
    showsHint.textContent = role.kind === 'stage' ? 'Never shown on the stream. The Present tab previews and the Monitor tab show it like any screen.' : role.kind === 'mirror' ? 'Looks exactly like that screen (picture, text, announcements). Its own look is not used.' : ''
    const bound = state0.displays.find((d) => d.id === displayId)
    displayWarn.hidden = !bound?.primary
    displayWarn.textContent = bound?.primary ? (state0.displays.length > 1 ? 'This is your main display, where this window is. While live, the screen covers it. Pick another display for the audience.' : 'This is your only display, so a live screen will cover this window. Use "None (opens in a window)" until a second display is connected.') : ''
    const size = clampSize(Number(w.value), Number(h.value))
    sizeHint.textContent = sizeLocked ? 'The stream is using this size. Stop the stream to change it.' : `${size.width}×${size.height}${size.width !== Number(w.value) || size.height !== Number(h.value) ? ' (adjusted to the limits, and to even numbers the encoder needs)' : ''}`
    apply.disabled = false
  }

  async function submit(close: () => void): Promise<void> {
    const finalName = name.value.trim() || suggestion()
    apply.disabled = true
    if (kind === 'virtual') {
      const size = clampSize(Number(w.value), Number(h.value))
      if (existing) await api.updateScreen(existing.id, { name: finalName, ...(sizeLocked ? {} : size) })
      else await api.addVirtual(finalName, size.width, size.height)
    } else {
      const cur: ScreenConfig = existing ?? (await api.addDisplayScreen(finalName, {}) as ScreenConfig)
      const patch = rolePatch(role, cur)
      const look = { ...(patch.look ?? cur.look), ...(role.kind === 'own' ? { videoAudio: sound.checked } : {}) } as Look
      await api.updateScreen(cur.id, { name: finalName, displayId, mirrorOf: patch.mirrorOf, look })
    }
    close()
  }

  showModal((close) => {
    apply.onclick = () => void submit(close)
    name.onkeydown = (e) => { if (e.key === 'Enter') apply.click() }
    return el('div', { className: 'dialog sd', role: 'dialog' },
      el('div', { className: 'sdhead' }, title, el('span', { className: 'grow' }), el('button', { textContent: 'Cancel', onclick: () => close() }), apply),
      el('div', { className: 'sdbody' },
        el('div', { className: 'sdgroup' }, el('h4', { textContent: 'Name' }), name),
        typeRow, displayGroup, virtualGroup,
      ),
    )
  })
  sync()
  name.focus()
}

