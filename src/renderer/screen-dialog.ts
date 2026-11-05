import type { PrestreamerApi } from '../preload'
import { appliesTo } from '../shared/announce'
import type { Look, PlaybackState, ScreenConfig, ScreenState, Slide, VideoSource } from '../shared/types'
import { mediaThumb, pickBackground } from './background-picker'
import { showModal } from './dialogs'
import { iconButton } from './icons'
import { scaledPreview } from './slideview'

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

const sourceValue = (s: VideoSource): string => (s.type === 'camera' ? `camera:${s.deviceId}` : s.type)

/**
 * Popup with every look setting of ONE screen (the one whose gear was pressed), with a live preview.
 * Changes apply immediately. Each patch carries only the field that changed: the main process merges it
 * into the saved look, so a stale copy here can never overwrite another setting.
 */
export function openScreenDialog(id: string, deps: ScreenDialogDeps): { refresh(): void; close(): void } {
  const { api } = deps
  const screen = () => deps.getState().screens.find((s) => s.id === id)
  const patch = (look: Partial<Look>) => void api.updateScreen(id, { look: look as Look })

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
  const customColor = el<HTMLInputElement>('input', { type: 'color', title: 'Any solid colour', value: '#000000' })
  customColor.oninput = () => patch({ background: customColor.value })
  swatches.append(customColor)

  // A picture or looping video behind the text of this screen
  const bgNow = el('span', { className: 'bgcur' })
  const chooseBg = iconButton('screen', 'A picture or looping video behind the text on this screen, from your library or imported', async () => {
    const current = screen()?.look.backgroundMedia ?? null
    close() // one dialog at a time: the picker takes its place, and this one comes back after
    const picked = await pickBackground(api, current, { title: `Background for ${screen()?.name ?? 'this screen'}`, onDeleted: deps.onMediaDeleted })
    if (picked !== undefined) await api.updateScreen(id, { look: { backgroundMedia: picked } as Look })
    deps.reopen()
  }, { badge: true, label: 'Picture or video…' })
  const clearBg = el('button', { textContent: 'Remove', title: 'Back to the plain colour', onclick: () => patch({ backgroundMedia: null }) })

  // Text
  const size = el<HTMLInputElement>('input', { type: 'number', min: '16', max: '200' })
  size.onchange = () => patch({ fontSize: Number(size.value) })
  const color = el<HTMLInputElement>('input', { type: 'color' })
  color.oninput = () => patch({ textColor: color.value })
  const layout = el<HTMLSelectElement>('select')
  layout.append(
    el<HTMLOptionElement>('option', { value: 'full', textContent: 'Full screen (centred)' }),
    el<HTMLOptionElement>('option', { value: 'lower-third', textContent: 'Lower third (caption over video)' }),
    el<HTMLOptionElement>('option', { value: 'stage', textContent: 'Stage monitor (current, next, clock)' }),
  )
  layout.onchange = () => {
    const sc = screen()
    // A caption needs a box to stay readable over a moving picture: give it one the first time it is chosen.
    patch({ layout: layout.value as Look['layout'], ...(layout.value === 'lower-third' && sc?.look.textBoxOpacity === 0 ? { textBoxOpacity: 0.55 } : {}) })
  }
  const box = el<HTMLInputElement>('input', { type: 'range', min: '0', max: '1', step: '0.05', title: 'Opacity of the dark box behind the text' })
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
  const detect = el('button', { textContent: 'Detect cameras', onclick: () => void deps.detectCameras() })

  // Sound
  const sound = el<HTMLInputElement>('input', { type: 'checkbox' })
  sound.onchange = () => patch({ videoAudio: sound.checked })
  const output = el<HTMLSelectElement>('select')
  output.onchange = () => patch({ audioOutput: output.value })

  const row = (name: string, ...controls: HTMLElement[]) => el('label', { className: 'sdrow' }, el('span', { textContent: name }), el('span', { className: 'inl' }, ...controls))
  const group = (title: string, ...rows: HTMLElement[]) => el('div', { className: 'sdgroup' }, el('h4', { textContent: title }), ...rows)

  const dialogEl = (close: () => void) =>
    el('div', { className: 'dialog sd', role: 'dialog' },
      el('div', { className: 'sdhead' }, el('h3', { className: 'sdtitle' }), el('button', { className: 'primary', textContent: 'Done', onclick: () => close() })),
      el('div', { className: 'sdbody' },
        previewBox,
        group('Background', swatches, row('Picture or video', chooseBg, bgNow, clearBg)),
        group('Text', row('Layout', layout), row('Text box', box), row('Font size', size), row('Colour', color), row('Section label', label), row('LIVE badge', badge, el('span', { className: 'dim', textContent: 'show "LIVE" while the stream is on air' }))),
        group('Video', row('Slide backgrounds', media, el('span', { className: 'dim', textContent: 'show images and videos behind the text' })), row('Live source', source), row('', detect)),
        group('Sound', row('Video sound', sound, el('span', { className: 'dim', textContent: 'play the sound of video cues from this screen' })), row('Output', output)),
      ),
    )

  const close = showModal(dialogEl, () => { pv.dispose(); deps.onClose() })

  let lastCameraCount = -1
  function refresh(): void {
    const sc = screen()
    if (!sc) return close() // removed while open
    const look = sc.look
    document.querySelector<HTMLElement>('.sdtitle')!.textContent = `${sc.name} · screen settings`

    const [w, h] = deps.screenSize(sc)
    pv.update(look, deps.getState().slide ?? SAMPLE, w, h, true)
    pv.setNext(deps.getState().next ?? SAMPLE_NEXT)
    pv.setPlayback(deps.getPlayback())
    const announcement = deps.getState().announcement
    pv.setAnnouncement(appliesTo(announcement, id) ? announcement : null)

    const active = document.activeElement
    const set = (input: HTMLInputElement | HTMLSelectElement, value: string) => { if (active !== input) input.value = value }
    swatchButtons.forEach(({ b, bg }) => b.classList.toggle('picked', bg === look.background))
    bgNow.replaceChildren(...(look.backgroundMedia ? [mediaThumb(look.backgroundMedia)] : [el('span', { className: 'dim', textContent: 'none' })]))
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
      { value: 'none', text: 'None', source: { type: 'none' } },
      { value: 'testpattern', text: 'Test pattern (simulated camera)', source: { type: 'testpattern' } },
      ...cameras.map((c) => ({ value: `camera:${c.deviceId}`, text: c.label || c.deviceId, source: { type: 'camera', ...c } as VideoSource })),
    ]
    if (cur.type === 'camera' && !options.some((o) => o.value === sourceValue(cur))) options.push({ value: sourceValue(cur), text: `${cur.label} (not detected)`, source: cur })
    if (cameras.length !== lastCameraCount || active !== source) {
      sourceOptions = options
      source.replaceChildren(...options.map((o) => el<HTMLOptionElement>('option', { value: o.value, textContent: o.text })))
      lastCameraCount = cameras.length
    }
    set(source, sourceValue(cur))

    const outputs = deps.getOutputs()
    if (active !== output) {
      output.replaceChildren(el<HTMLOptionElement>('option', { value: '', textContent: 'System default' }), ...outputs.map((d) => el<HTMLOptionElement>('option', { value: d.deviceId, textContent: d.label || d.deviceId })))
    }
    set(output, look.audioOutput)
  }

  refresh()
  return { refresh, close }
}
