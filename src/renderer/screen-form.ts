import type { PrestreamerApi } from '../preload'
import { SCREEN_LIMITS, SIZE_PRESETS, clampSize, hasRoles, roleOf, rolePatch, type ScreenRole } from '../shared/screens'
import type { DisplayInfo, Look, NdiSound, ScreenConfig, ScreenState } from '../shared/types'
import { showModal } from './dialogs'
import { t } from '../shared/i18n'

function el<T extends HTMLElement = HTMLElement>(tag: string, props: Partial<T> = {}, ...kids: (Node | string)[]): T {
  const e = Object.assign(document.createElement(tag) as T, props)
  e.append(...kids)
  return e
}

type Kind = ScreenConfig['kind']

const kindName = (k: Kind): string => t(k === 'display' ? 'settings.kind.display' : k === 'virtual' ? 'settings.kind.virtual' : 'settings.kind.ndi')
const kindHint = (k: Kind): string => t(k === 'display' ? 'settings.form.kindHint.display' : k === 'virtual' ? 'settings.form.kindHint.virtual' : 'settings.form.kindHint.ndi')

/** What a screen is for, in words: shown on the card and in the dialog. */
export function describeRole(sc: ScreenConfig, state: ScreenState): string {
  if (sc.kind === 'virtual') return t('settings.role.stream')
  const role = roleOf(sc)
  const text = role.kind === 'stage' ? t('settings.role.stage') : role.kind === 'mirror' ? t('settings.role.mirror', { name: state.screens.find((s) => s.id === role.of)?.name ?? t('settings.role.anotherScreen') }) : t('settings.role.own')
  return sc.kind === 'ndi' ? `NDI · ${text}` : text
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
  // These become the screen's saved name, so they stay English like the default screens' names.
  const suggestion = (): string => {
    if (kind === 'virtual') return `Virtual screen ${count((s) => s.kind === 'virtual')}`
    if (kind === 'ndi' && role.kind === 'own') return `NDI screen ${count((s) => s.kind === 'ndi' && !s.mirrorOf && roleOf(s).kind === 'own')}`
    if (kind === 'ndi' && role.kind === 'stage') return `NDI stage monitor ${count((s) => s.kind === 'ndi' && roleOf(s).kind === 'stage')}`
    if (role.kind === 'stage') return `Stage monitor ${count((s) => roleOf(s).kind === 'stage')}`
    if (role.kind === 'mirror') { const of = role.of; return `${state0.screens.find((s) => s.id === of)?.name ?? 'Screen'} mirror ${count((s) => !!s.mirrorOf)}` }
    return `Display screen ${count((s) => s.kind === 'display' && !s.mirrorOf && roleOf(s).kind === 'own')}`
  }

  const name = el<HTMLInputElement>('input', { type: 'text', maxLength: 40, value: existing?.name ?? '' })
  name.oninput = () => { nameTouched = true; sync() }

  // Type (adding only)
  const kinds = (['display', 'ndi', 'virtual'] as const).map((k) => {
    const b = el<HTMLButtonElement>('button', { className: 'kindcard' },
      el('strong', { textContent: kindName(k) }),
      el('span', { className: 'dim', textContent: kindHint(k) }),
    )
    b.onclick = () => { kind = k; if (!nameTouched) name.value = ''; sync() }
    return { k, b }
  })
  const kindFixed = el('div', { className: 'dim', textContent: existing ? t('settings.form.typeFixed', { kind: kindName(existing.kind) }) : '' })

  // Display screens
  const shows = el<HTMLSelectElement>('select', { title: t('settings.form.showsTitle') })
  const mirrorTargets = state0.screens.filter((x) => x.id !== existing?.id && !x.mirrorOf)
  const followed = !!existing && state0.screens.some((x) => x.mirrorOf === existing.id)
  shows.append(
    el<HTMLOptionElement>('option', { value: 'own', textContent: t('settings.form.show.own') }),
    el<HTMLOptionElement>('option', { value: 'stage', textContent: t('settings.form.show.stage') }),
    ...(followed ? [] : mirrorTargets.map((x) => el<HTMLOptionElement>('option', { value: `mirror:${x.id}`, textContent: t('settings.role.mirror', { name: x.name }) }))),
  )
  shows.value = role.kind === 'mirror' ? `mirror:${role.of}` : role.kind
  if (shows.value !== (role.kind === 'mirror' ? `mirror:${role.of}` : role.kind)) shows.value = 'own' // the mirrored screen is gone
  shows.onchange = () => {
    role = shows.value === 'stage' ? { kind: 'stage' } : shows.value.startsWith('mirror:') ? { kind: 'mirror', of: shows.value.slice(7) } : { kind: 'own' }
    sync()
  }
  const showsHint = el('div', { className: 'dim sfhint' })

  const display = el<HTMLSelectElement>('select')
  display.append(el<HTMLOptionElement>('option', { value: '', textContent: t('settings.form.noDisplay') }))
  state0.displays.forEach((d: DisplayInfo, i: number) => {
    const other = state0.screens.find((x) => x.id !== existing?.id && x.kind === 'display' && x.displayId === d.id)
    display.append(el<HTMLOptionElement>('option', { value: String(d.id), textContent: t(d.primary ? 'settings.form.displayOptionMain' : 'settings.form.displayOption', { n: i + 1, label: d.label, size: `${d.width}×${d.height}` }) + (other ? t('settings.form.alsoUsedBy', { name: other.name }) : '') }))
  })
  if (displayId !== null && !state0.displays.some((d) => d.id === displayId)) display.append(el<HTMLOptionElement>('option', { value: String(displayId), textContent: t('settings.card.notConnected', { label: existing?.displayLabel ?? t('settings.card.displayWord') }) }))
  display.value = displayId === null ? '' : String(displayId)
  display.onchange = () => { displayId = display.value ? Number(display.value) : null; sync() }
  const displayWarn = el('div', { className: 'warn' })

  const soundRow = () => row(t('settings.form.videoSound'), sound, el('span', { className: 'dim', textContent: t('settings.form.videoSoundHint') }))
  const sound = el<HTMLInputElement>('input', { type: 'checkbox', checked: existing?.look.videoAudio ?? false })
  const ndiSound = el<HTMLSelectElement>('select', { title: t('settings.form.ndiSoundTitle') })
  ndiSound.append(
    el<HTMLOptionElement>('option', { value: 'stream', textContent: t('settings.form.ndiSound.stream') }),
    el<HTMLOptionElement>('option', { value: 'video', textContent: t('settings.form.ndiSound.video') }),
    el<HTMLOptionElement>('option', { value: 'none', textContent: t('settings.form.ndiSound.none') }),
  )
  ndiSound.value = existing?.ndiSound ?? 'stream'

  // Virtual screens
  const w = el<HTMLInputElement>('input', { type: 'number', value: String(existing?.width ?? SIZE_PRESETS[0].width), min: String(SCREEN_LIMITS.width[0]), max: String(SCREEN_LIMITS.width[1]) })
  const h = el<HTMLInputElement>('input', { type: 'number', value: String(existing?.height ?? SIZE_PRESETS[0].height), min: String(SCREEN_LIMITS.height[0]), max: String(SCREEN_LIMITS.height[1]) })
  const preset = el<HTMLSelectElement>('select')
  const sizeNow = () => `${Number(w.value)}×${Number(h.value)}`
  const syncPreset = () => { const i = SIZE_PRESETS.findIndex((p) => `${p.width}×${p.height}` === sizeNow()); preset.value = i >= 0 ? String(i) : '' }
  preset.append(el<HTMLOptionElement>('option', { value: '', textContent: t('settings.form.custom') }), ...SIZE_PRESETS.map((p, i) => el<HTMLOptionElement>('option', { value: String(i), textContent: p.label })))
  preset.onchange = () => { const p = SIZE_PRESETS[Number(preset.value)]; if (p) { w.value = String(p.width); h.value = String(p.height) } sync() }
  w.oninput = h.oninput = () => { syncPreset(); sync() }
  syncPreset()
  const sizeHint = el('div', { className: 'dim sfhint' })
  // The stream is encoded from the first frame's size, so a screen it uses keeps its size until the stream stops.
  const sizeLocked = !!existing && existing.kind === 'virtual' && opts.streaming()
  if (sizeLocked) { w.disabled = true; h.disabled = true; preset.disabled = true }

  const row = (label: string, ...controls: HTMLElement[]) => el('label', { className: 'sdrow' }, el('span', { textContent: label }), el('span', { className: 'inl' }, ...controls))
  const typeRow = el('div', { className: 'sdgroup' }, el('h4', { textContent: t('settings.form.type') }), existing ? kindFixed : el('div', { className: 'kindrow' }, ...kinds.map((k) => k.b)))
  const rolesGroup = el('div', { className: 'sdgroup' }, el('h4', { textContent: t('settings.form.whatItShows') }), row(t('settings.form.shows'), shows), showsHint)
  const displayGroup = el('div', { className: 'sdgroup' }, el('h4', { textContent: t('settings.form.displayGroup') }), row(t('settings.form.displayGroup'), display), displayWarn)
  const soundGroup = el('div', { className: 'sdgroup' }, el('h4', { textContent: t('settings.form.sound') }), soundRow())
  const ndiNote = el('div', { className: 'dim sfhint', textContent: t('settings.form.ndiNote') })
  const ndiSoundRow = row(t('settings.form.sound'), ndiSound)
  const virtualGroup = el('div', { className: 'sdgroup' }, el('h4', { textContent: t('settings.form.size') }), row(t('settings.form.resolution'), preset), row(t('settings.form.widthHeight'), w, el('span', { textContent: '×' }), h), sizeHint, ndiSoundRow, ndiNote)

  const apply = el<HTMLButtonElement>('button', { className: 'primary', textContent: existing ? t('settings.apply') : t('settings.form.addButton') })
  const title = el('h3', { className: 'sdtitle', textContent: existing ? t('settings.form.editTitle', { name: existing.name }) : t('settings.form.addTitle') })

  function sync(): void {
    kinds.forEach(({ k, b }) => { b.classList.toggle('on', k === kind); b.setAttribute('aria-pressed', String(k === kind)) })
    name.placeholder = suggestion()
    rolesGroup.hidden = !hasRoles(kind)
    displayGroup.hidden = kind !== 'display'
    soundGroup.hidden = kind !== 'display'
    virtualGroup.hidden = kind === 'display'
    ndiNote.hidden = ndiSoundRow.hidden = kind !== 'ndi'
    sound.disabled = role.kind !== 'own'
    showsHint.textContent = role.kind === 'stage' ? t('settings.form.hint.stage') : role.kind === 'mirror' ? t('settings.form.hint.mirror') : ''
    const bound = state0.displays.find((d) => d.id === displayId)
    displayWarn.hidden = !bound?.primary
    displayWarn.textContent = bound?.primary ? (state0.displays.length > 1 ? t('settings.form.warn.main') : t('settings.form.warn.only')) : ''
    const size = clampSize(Number(w.value), Number(h.value))
    sizeHint.textContent = sizeLocked ? t('settings.form.sizeLocked') : `${size.width}×${size.height}${size.width !== Number(w.value) || size.height !== Number(h.value) ? t('settings.form.sizeAdjusted') : ''}`
    apply.disabled = false
  }

  async function submit(close: () => void): Promise<void> {
    const finalName = name.value.trim() || suggestion()
    apply.disabled = true
    if (kind === 'virtual') {
      const size = clampSize(Number(w.value), Number(h.value))
      if (existing) await api.updateScreen(existing.id, { name: finalName, ...(sizeLocked ? {} : size) })
      else await api.addVirtual(finalName, size.width, size.height)
    } else if (kind === 'ndi') {
      const size = clampSize(Number(w.value), Number(h.value))
      const cur: ScreenConfig = existing ?? (await api.addNdiScreen(finalName, size) as ScreenConfig)
      const patch = rolePatch(role, cur)
      await api.updateScreen(cur.id, { name: finalName, ...size, ndiSound: ndiSound.value as NdiSound, mirrorOf: patch.mirrorOf, ...(patch.look ? { look: patch.look } : {}) })
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
      el('div', { className: 'sdhead' }, title, el('span', { className: 'grow' }), el('button', { textContent: t('settings.cancel'), onclick: () => close() }), apply),
      el('div', { className: 'sdbody' },
        el('div', { className: 'sdgroup' }, el('h4', { textContent: t('settings.form.name') }), name),
        typeRow, rolesGroup, displayGroup, soundGroup, virtualGroup,
      ),
    )
  })
  sync()
  name.focus()
}

