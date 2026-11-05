import type { PrestreamerApi } from '../preload'
import { AUDIO_KBPS_CHOICES, ENCODER_CHOICES, FPS_CHOICES, MAX_KEYFRAME_SEC, PRESETS, RESOLUTIONS, dataPerHourMB, recommendedKbps, sanitizeStreamSettings, settingsWarnings, youtubeRange, type StreamSettings } from '../shared/stream-settings'
import { showModal } from './dialogs'

function el<T extends HTMLElement = HTMLElement>(tag: string, props: Partial<T> = {}, ...kids: (Node | string)[]): T {
  const e = Object.assign(document.createElement(tag) as T, props)
  e.append(...kids)
  return e
}

export interface StreamDialogDeps {
  api: PrestreamerApi
  getSettings(): StreamSettings
  setSettings(s: StreamSettings): void
  isStreaming(): boolean
}

/**
 * How the outgoing stream is encoded: picture size, frame rate, bitrates, keyframes and encoder. Changes are saved at once;
 * a stream in progress keeps the settings it started with, so they apply from the next start.
 */
export function openStreamSettings(deps: StreamDialogDeps): void {
  let s = deps.getSettings()

  const apply = async (patch: Partial<StreamSettings>) => {
    const before = s
    s = sanitizeStreamSettings({ ...s, ...patch })
    // Following a size or frame-rate change, a bitrate that was the old suggestion moves to the new suggestion.
    if (('height' in patch || 'fps' in patch) && !('videoKbps' in patch) && before.videoKbps === recommendedKbps(before.height, before.fps)) s = { ...s, videoKbps: recommendedKbps(s.height, s.fps) }
    s = await deps.api.streamSettingsSet(s)
    deps.setSettings(s)
    sync()
  }

  const select = <T extends string | number>(options: { value: T; label: string }[], onChange: (v: string) => void) => {
    const sel = el<HTMLSelectElement>('select')
    sel.append(...options.map((o) => el<HTMLOptionElement>('option', { value: String(o.value), textContent: o.label })))
    sel.onchange = () => onChange(sel.value)
    return sel
  }
  const resolution = select(RESOLUTIONS.map((r) => ({ value: `${r.width}x${r.height}`, label: r.label })), (v) => { const [width, height] = v.split('x').map(Number); void apply({ width, height }) })
  const fps = select(FPS_CHOICES.map((f) => ({ value: f, label: `${f} fps` })), (v) => void apply({ fps: Number(v) }))
  const kbps = el<HTMLInputElement>('input', { type: 'number', min: '500', max: '20000', step: '100' })
  kbps.onchange = () => void apply({ videoKbps: Number(kbps.value) })
  const suggest = el('button', { textContent: 'Use suggested', title: "The bitrate YouTube suggests for this picture size and frame rate", onclick: () => void apply({ videoKbps: recommendedKbps(s.height, s.fps) }) })
  const key = select(Array.from({ length: MAX_KEYFRAME_SEC }, (_, i) => ({ value: i + 1, label: `${i + 1} second${i ? 's' : ''}` })), (v) => void apply({ keyframeSec: Number(v) }))
  const encoder = select(ENCODER_CHOICES, (v) => void apply({ encoder: v as StreamSettings['encoder'] }))
  const preset = select(PRESETS.map((p) => ({ value: p, label: p })), (v) => void apply({ preset: v as StreamSettings['preset'] }))
  const audio = select(AUDIO_KBPS_CHOICES.map((a) => ({ value: a, label: `${a} kb/s` })), (v) => void apply({ audioKbps: Number(v) }))

  const hint = el('div', { className: 'dim sshint' })
  const warnings = el('div', { className: 'swarn' })
  const live = el('div', { className: 'annlive sslive', textContent: 'A stream is running. Changes apply the next time you start streaming.' })

  const row = (name: string, ...controls: HTMLElement[]) => el('label', { className: 'sdrow' }, el('span', { textContent: name }), el('span', { className: 'inl' }, ...controls))
  const group = (title: string, ...rows: HTMLElement[]) => el('div', { className: 'sdgroup' }, el('h4', { textContent: title }), ...rows)

  function sync(): void {
    resolution.value = `${s.width}x${s.height}`
    fps.value = String(s.fps)
    if (document.activeElement !== kbps) kbps.value = String(s.videoKbps)
    key.value = String(s.keyframeSec)
    encoder.value = s.encoder
    preset.value = s.preset
    preset.disabled = s.encoder !== 'auto' && s.encoder !== 'libx264'
    audio.value = String(s.audioKbps)
    const r = youtubeRange(s.height, s.fps)
    hint.textContent = `YouTube suggests ${r.min.toLocaleString()}-${r.max.toLocaleString()} kb/s for ${s.height}p at ${s.fps} fps. This stream uses ${(s.videoKbps + s.audioKbps).toLocaleString()} kb/s in total, about ${dataPerHourMB(s.videoKbps, s.audioKbps).toLocaleString()} MB of upload per hour: your internet upload speed should be at least twice that.`
    warnings.replaceChildren(...settingsWarnings(s).map((w) => el('div', { textContent: w })))
    live.hidden = !deps.isStreaming()
  }

  showModal((close) => {
    const dialog = el('div', { className: 'dialog sd', role: 'dialog' },
      el('div', { className: 'sdhead' }, el('h3', { className: 'sdtitle', textContent: 'Stream settings' }), el('button', { className: 'primary', textContent: 'Done', onclick: () => close() })),
      el('div', { className: 'sdbody' },
        live,
        group('Picture', row('Resolution', resolution), row('Frame rate', fps), row('Video bitrate', kbps, el('span', { textContent: 'kb/s' }), suggest)),
        hint,
        group('Encoding', row('Encoder', encoder), row('x264 speed', preset), row('Keyframe every', key)),
        group('Sound', row('Audio bitrate', audio)),
        warnings,
      ),
    )
    return dialog
  })
  sync()
}
