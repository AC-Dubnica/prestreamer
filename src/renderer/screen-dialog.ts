import type { PrestreamerApi } from '../preload'
import { appliesTo } from '../shared/announce'
import type { Look, PlaybackState, ScreenConfig, ScreenState, Slide, VideoSource } from '../shared/types'
import { mediaThumb, pickBackground } from './background-picker'
import { showModal } from './dialogs'
import { iconButton } from './icons'
import { scaledPreview } from './slideview'
import { t } from '../shared/i18n'

function el<T extends HTMLElement = HTMLElement>(tag: string, props: Partial<T> = {}, ...kids: (Node | string)[]): T {
  const e = Object.assign(document.createElement(tag) as T, props)
  e.append(...kids)
  return e
}

export interface ScreenDialogDeps {
  api: PrestreamerApi
  getState(): ScreenState
  getPlayback(): PlaybackState
  getCameras(): { deviceId: string; label: string }[]
  getOutputs(): { deviceId: string; label: string }[]
  detectCameras(): Promise<void>
  screenSize(sc: ScreenConfig): [number, number]
  backgrounds: string[]
  openSettings(): void
  /** Opens this dialog again (after another dialog was shown in its place). */
  reopen(): void
  /** A picture or video was deleted in the picker. */
  onMediaDeleted(file: string): void
  onClose(): void
}

const SAMPLE: Slide = { label: 'Preview', text: 'Amazing grace, how sweet the sound\nThat saved a wretch like me' }

const SAMPLE_NEXT: Slide = { label: 'Preview', text: 'I once was lost, but now am found\nWas blind, but now I see' }

/** Unapplied changes handed from one screen dialog to the next (see the picture picker). */
let carried: { id: string; draft: Partial<Look> } | null = null

const sourceValue = (s: VideoSource): string => (s.type === 'camera' ? `camera:${s.deviceId}` : s.type)

/**
 * Popup with every look setting of ONE screen (the one whose gear was pressed), with a preview.
 * Changes only show in the preview: Apply sends them to the screen (and so on air), Cancel or Esc throws them away.
 * Only the fields that were changed are sent: the main process merges them into the saved look, so a stale copy
 * here can never overwrite another setting.
 */
export function openScreenDialog(id: string, deps: ScreenDialogDeps): { refresh(): void; close(): void } {
  const { api } = deps
  const screen = () => deps.getState().screens.find((s) => s.id === id)
  // The changes not applied yet. The picture picker replaces this dialog for a moment, so they are carried over to the next one.
  const draft: Partial<Look> = carried?.id === id ? carried.draft : {}
  carried = null
  const shown = (): Look | undefined => { const sc = screen(); return sc && { ...sc.look, ...draft } }
  const patch = (look: Partial<Look>) => { Object.assign(draft, look); refresh() }

  const pv = scaledPreview()
  const previewBox = el('div', { className: 'sdprev' }, pv.box)

  // Background
  const swatches = el('div', { className: 'sw nopad' })
  const swatchButtons = deps.backgrounds.map((bg) => {
    const b = el('button', { title: bg, onclick: () => patch({ background: bg }) })
    b.style.background = bg
    swatches.append(b)
    return { b, bg }
  })
  const customColor = el<HTMLInputElement>('input', { type: 'color', title: t('settings.dialog.anyColour'), value: '#000000' })
  customColor.oninput = () => patch({ background: customColor.value })
  swatches.append(customColor)

  // A picture or looping video behind the text of this screen
  const bgNow = el('span', { className: 'bgcur' })
  const chooseBg = iconButton('screen', t('settings.dialog.pictureTitle'), async () => {
    const current = shown()?.backgroundMedia ?? null
    carried = { id, draft }
    close() // one dialog at a time: the picker takes its place, and this one comes back after
    const picked = await pickBackground(api, current, { title: t('settings.dialog.pickTitle', { name: screen()?.name ?? t('settings.dialog.thisScreen') }), onDeleted: deps.onMediaDeleted })
    if (picked !== undefined && carried) carried.draft.backgroundMedia = picked as Look['backgroundMedia']
    deps.reopen()
  }, { badge: true, label: t('settings.dialog.pictureOrVideoButton') })
  const clearBg = el('button', { textContent: t('settings.remove'), title: t('settings.dialog.backToColour'), onclick: () => patch({ backgroundMedia: null }) })

  // Text
  const size = el<HTMLInputElement>('input', { type: 'number', min: '16', max: '200' })
  size.onchange = () => patch({ fontSize: Number(size.value) })
  const color = el<HTMLInputElement>('input', { type: 'color' })
  color.oninput = () => patch({ textColor: color.value })
  const layout = el<HTMLSelectElement>('select')
  layout.append(
    el<HTMLOptionElement>('option', { value: 'full', textContent: t('settings.dialog.layout.full') }),
    el<HTMLOptionElement>('option', { value: 'lower-third', textContent: t('settings.dialog.layout.lowerThird') }),
    el<HTMLOptionElement>('option', { value: 'stage', textContent: t('settings.dialog.layout.stage') }),
  )
  layout.onchange = () => {
    const sc = shown()
    // A caption needs a box to stay readable over a moving picture: give it one the first time it is chosen.
    patch({ layout: layout.value as Look['layout'], ...(layout.value === 'lower-third' && sc?.textBoxOpacity === 0 ? { textBoxOpacity: 0.55 } : {}) })
  }
  const box = el<HTMLInputElement>('input', { type: 'range', min: '0', max: '1', step: '0.05', title: t('settings.dialog.boxTitle') })
  box.oninput = () => patch({ textBoxOpacity: Number(box.value) })
  const badge = el<HTMLInputElement>('input', { type: 'checkbox' })
  badge.onchange = () => patch({ liveBadge: badge.checked })
  const label = el<HTMLInputElement>('input', { type: 'checkbox' })
  label.onchange = () => patch({ showLabel: label.checked })

  // Media
  const media = el<HTMLInputElement>('input', { type: 'checkbox' })
  media.onchange = () => patch({ showMedia: media.checked })
  const source = el<HTMLSelectElement>('select')
  let sourceOptions: { value: string; source: VideoSource }[] = []
  source.onchange = () => {
    const picked = sourceOptions.find((o) => o.value === source.value)
    if (picked) patch({ source: picked.source })
  }
  const detect = el('button', { textContent: t('settings.dialog.detect'), onclick: () => void deps.detectCameras() })

  // Sound
  const sound = el<HTMLInputElement>('input', { type: 'checkbox' })
  sound.onchange = () => patch({ videoAudio: sound.checked })
  const output = el<HTMLSelectElement>('select')
  output.onchange = () => patch({ audioOutput: output.value })

  const row = (name: string, ...controls: HTMLElement[]) => el('label', { className: 'sdrow' }, el('span', { textContent: name }), el('span', { className: 'inl' }, ...controls))
  const group = (title: string, ...rows: HTMLElement[]) => el('div', { className: 'sdgroup' }, el('h4', { textContent: title }), ...rows)

  const apply = el<HTMLButtonElement>('button', { className: 'primary', textContent: t('settings.apply'), title: t('settings.dialog.applyTitle') })
  apply.onclick = async () => {
    if (Object.keys(draft).length) await api.updateScreen(id, { look: draft as Look })
    carried = null
    close()
  }

  const dialogEl = (close: () => void) =>
    el('div', { className: 'dialog sd', role: 'dialog' },
      el('div', { className: 'sdhead' }, el('h3', { className: 'sdtitle' }), el('span', { className: 'grow' }), el('button', { textContent: t('settings.cancel'), title: t('settings.dialog.cancelTitle'), onclick: () => close() }), apply),
      el('div', { className: 'sdbody' },
        previewBox,
        group(t('settings.dialog.background'), swatches, row(t('settings.dialog.pictureOrVideo'), chooseBg, bgNow, clearBg)),
        group(t('settings.dialog.text'), row(t('settings.dialog.layout'), layout), row(t('settings.dialog.textBox'), box), row(t('settings.dialog.fontSize'), size), row(t('settings.dialog.colour'), color), row(t('settings.dialog.sectionLabel'), label), row(t('settings.dialog.liveBadge'), badge, el('span', { className: 'dim', textContent: t('settings.dialog.liveBadgeHint') }))),
        group(t('settings.dialog.video'), row(t('settings.dialog.slideBackgrounds'), media, el('span', { className: 'dim', textContent: t('settings.dialog.slideBackgroundsHint') })), row(t('settings.dialog.liveSource'), source), row('', detect)),
        group(t('settings.form.sound'), row(t('settings.form.videoSound'), sound, el('span', { className: 'dim', textContent: t('settings.form.videoSoundHint') })), row(t('settings.dialog.output'), output)),
      ),
    )

  const close = showModal(dialogEl, () => { pv.dispose(); deps.onClose() })

  let lastCameraCount = -1
  function refresh(): void {
    const sc = screen()
    if (!sc) return close() // removed while open
    const look = shown()!
    apply.disabled = !Object.keys(draft).length
    document.querySelector<HTMLElement>('.sdtitle')!.textContent = t('settings.dialog.title', { name: sc.name })

    const [w, h] = deps.screenSize(sc)
    pv.update(look, deps.getState().slide ?? SAMPLE, w, h, true)
    pv.setNext(deps.getState().next ?? SAMPLE_NEXT)
    pv.setPlayback(deps.getPlayback())
    const announcement = deps.getState().announcement
    pv.setAnnouncement(appliesTo(announcement, id) ? announcement : null)

    const active = document.activeElement
    const set = (input: HTMLInputElement | HTMLSelectElement, value: string) => { if (active !== input) input.value = value }
    swatchButtons.forEach(({ b, bg }) => b.classList.toggle('picked', bg === look.background))
    bgNow.replaceChildren(...(look.backgroundMedia ? [mediaThumb(look.backgroundMedia)] : [el('span', { className: 'dim', textContent: t('settings.dialog.none') })]))
    clearBg.hidden = !look.backgroundMedia
    if (/^#[0-9a-f]{6}$/i.test(look.background)) set(customColor, look.background)
    set(size, String(look.fontSize))
    set(color, /^#[0-9a-f]{6}$/i.test(look.textColor) ? look.textColor : '#ffffff')
    set(layout, look.layout)
    set(box, String(look.textBoxOpacity))
    label.checked = look.showLabel
    badge.checked = look.liveBadge
    pv.setStreamLive(true) // the preview always shows the badge as it will look on air
    media.checked = look.showMedia
    sound.checked = look.videoAudio

    // Live source choices: none, the simulated camera, detected cameras, and the saved one even if it is unplugged.
    const cameras = deps.getCameras()
    const cur = look.source
    const options: { value: string; text: string; source: VideoSource }[] = [
      { value: 'none', text: t('settings.look.none'), source: { type: 'none' } },
      { value: 'testpattern', text: t('settings.dialog.testPattern'), source: { type: 'testpattern' } },
      ...cameras.map((c) => ({ value: `camera:${c.deviceId}`, text: c.label || c.deviceId, source: { type: 'camera', ...c } as VideoSource })),
    ]
    if (cur.type === 'camera' && !options.some((o) => o.value === sourceValue(cur))) options.push({ value: sourceValue(cur), text: t('settings.dialog.notDetected', { label: cur.label }), source: cur })
    if (cameras.length !== lastCameraCount || active !== source) {
      sourceOptions = options
      source.replaceChildren(...options.map((o) => el<HTMLOptionElement>('option', { value: o.value, textContent: o.text })))
      lastCameraCount = cameras.length
    }
    set(source, sourceValue(cur))

    const outputs = deps.getOutputs()
    if (active !== output) {
      output.replaceChildren(el<HTMLOptionElement>('option', { value: '', textContent: t('settings.dialog.systemDefault') }), ...outputs.map((d) => el<HTMLOptionElement>('option', { value: d.deviceId, textContent: d.label || d.deviceId })))
    }
    set(output, look.audioOutput)
  }

  refresh()
  return { refresh, close }
}
