import type { PrestreamerApi } from '../preload'
import { AUDIO_KBPS_CHOICES, ENCODER_CHOICES, FPS_CHOICES, MAX_KEYFRAME_SEC, PRESETS, RESOLUTIONS, STREAM_MODES, dataPerHourMB, recommendedKbps, sanitizeStreamSettings, settingsWarnings, youtubeRange, type StreamSettings } from '../shared/stream-settings'
import type { ScreenConfig, StreamMode } from '../shared/types'
import { formatNumber, t } from '../shared/i18n'

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
  /** The screens that exist now (the stream sends one of the virtual ones). */
  getScreens(): ScreenConfig[]
  /** The stream key was saved or forgotten. */
  onKeyChanged(saved: boolean): void
}

/**
 * The Stream page of Settings, the one place for everything about the outgoing stream: where it goes (YouTube or a file), which screen, the stream key, and how it is encoded
 * (picture size, frame rate, bitrates, keyframes, encoder). Changes are saved at once;
 * a stream in progress keeps the settings it started with, so they apply from the next start.
 */
export function createStreamSettings(deps: StreamDialogDeps): { root: HTMLElement; refresh(): void } {
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

  // Destination
  let keySaved = false
  const mode = el<HTMLSelectElement>('select')
  mode.append(...STREAM_MODES.map((m) => el<HTMLOptionElement>('option', { value: m.value, textContent: m.label })))
  mode.onchange = () => void apply({ mode: mode.value as StreamMode })
  const virtuals = () => deps.getScreens().filter((x) => x.kind === 'virtual')
  const screenSel = el<HTMLSelectElement>('select', { title: t('stream.screen.title') })
  screenSel.onchange = () => void apply({ screenId: screenSel.value })
  const screenOnly = el('span', { className: 'dim' }) // with a single virtual screen there is nothing to choose
  const keyInput = el<HTMLInputElement>('input', { type: 'password', placeholder: t('stream.key.placeholder'), autocomplete: 'off' })
  const keyNote = el('div', { className: 'dim sshint' })
  let keyError = ''
  const forgetKey = el<HTMLButtonElement>('button', { textContent: t('stream.key.forget') })
  const saveKey = async () => {
    const value = keyInput.value.trim()
    if (!value) return
    try {
      await deps.api.streamKeySet(value)
      keyInput.value = ''
      keySaved = true
      deps.onKeyChanged(true)
    } catch (err) {
      keyError = (err as Error).message.replace(/^Error invoking remote method '[^']*': (Error: )?/, '')
      sync()
      return
    }
    keyError = ''
    sync()
  }
  keyInput.onchange = () => void saveKey()
  forgetKey.onclick = async () => { await deps.api.streamKeyForget(); keySaved = false; deps.onKeyChanged(false); sync() }
  const destHint = el('div', { className: 'dim sshint' })

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
  const suggest = el('button', { textContent: t('stream.bitrate.suggested'), title: t('stream.bitrate.suggestedTitle'), onclick: () => void apply({ videoKbps: recommendedKbps(s.height, s.fps) }) })
  const key = select(Array.from({ length: MAX_KEYFRAME_SEC }, (_, i) => ({ value: i + 1, label: t('stream.keyframe.seconds', { n: i + 1 }) })), (v) => void apply({ keyframeSec: Number(v) }))
  const encoder = select(ENCODER_CHOICES, (v) => void apply({ encoder: v as StreamSettings['encoder'] }))
  const preset = select(PRESETS.map((p) => ({ value: p, label: p })), (v) => void apply({ preset: v as StreamSettings['preset'] }))
  const audio = select(AUDIO_KBPS_CHOICES.map((a) => ({ value: a, label: `${a} kb/s` })), (v) => void apply({ audioKbps: Number(v) }))

  const hint = el('div', { className: 'dim sshint' })
  const keyRow = el('label', { className: 'sdrow' }, el('span', { textContent: t('stream.key.label') }), el('span', { className: 'inl' }, keyInput, forgetKey))
  const warnings = el('div', { className: 'swarn' })
  const live = el('div', { className: 'annlive sslive', textContent: t('stream.running') })

  const row = (name: string, ...controls: HTMLElement[]) => el('label', { className: 'sdrow' }, el('span', { textContent: name }), el('span', { className: 'inl' }, ...controls))
  const group = (title: string, ...rows: HTMLElement[]) => el('div', { className: 'sdgroup' }, el('h4', { textContent: title }), ...rows)

  function sync(): void {
    const youtube = s.mode === 'youtube'
    const running = deps.isStreaming()
    mode.value = s.mode
    const list = virtuals()
    screenSel.replaceChildren(...list.map((x) => el<HTMLOptionElement>('option', { value: x.id, textContent: `${x.name} · ${x.width}×${x.height}` })))
    screenSel.value = list.some((x) => x.id === s.screenId) ? s.screenId : list[0]?.id ?? ''
    screenSel.hidden = list.length < 2
    screenOnly.hidden = list.length > 1
    screenOnly.textContent = list[0] ? `${list[0].name} · ${list[0].width}×${list[0].height}` : t('stream.screen.none')
    mode.disabled = screenSel.disabled = keyInput.disabled = forgetKey.disabled = running
    keyRow.hidden = !youtube
    keyNote.hidden = !youtube
    forgetKey.hidden = !youtube || !keySaved
    keyInput.placeholder = keySaved ? t('stream.key.placeholderSaved') : t('stream.key.placeholder')
    keyNote.textContent = keyError ? keyError : youtube ? (keySaved ? t('stream.key.noteSaved') : t('stream.key.noteNone')) : ''
    destHint.textContent = youtube ? '' : t('stream.dest.fileHint')
    resolution.value = `${s.width}x${s.height}`
    fps.value = String(s.fps)
    if (document.activeElement !== kbps) kbps.value = String(s.videoKbps)
    key.value = String(s.keyframeSec)
    encoder.value = s.encoder
    preset.value = s.preset
    preset.disabled = s.encoder !== 'auto' && s.encoder !== 'libx264'
    audio.value = String(s.audioKbps)
    const r = youtubeRange(s.height, s.fps)
    hint.textContent = t('stream.hint.bitrate', { min: formatNumber(r.min), max: formatNumber(r.max), height: s.height, fps: s.fps, total: formatNumber(s.videoKbps + s.audioKbps), mb: formatNumber(dataPerHourMB(s.videoKbps, s.audioKbps)) })
    warnings.replaceChildren(...settingsWarnings(s).map((w) => el('div', { textContent: w })))
    live.hidden = !deps.isStreaming()
  }

  const root = el('div', { className: 'streamset' },
    live,
    group(t('stream.group.destination'), row(t('stream.row.sendTo'), mode), row(t('stream.row.screen'), screenSel, screenOnly), keyRow, keyNote, destHint),
    group(t('stream.group.picture'), row(t('stream.row.resolution'), resolution), row(t('stream.row.frameRate'), fps), row(t('stream.row.videoBitrate'), kbps, el('span', { textContent: 'kb/s' }), suggest)),
    hint,
    group(t('stream.group.encoding'), row(t('stream.row.encoder'), encoder), row(t('stream.row.x264Speed'), preset), row(t('stream.row.keyframe'), key)),
    group(t('stream.group.sound'), row(t('stream.row.audioBitrate'), audio)),
    warnings,
  )
  /** Brings the page up to date with the saved settings, the screens and the stream's state (also when they changed elsewhere). */
  const refresh = () => {
    s = deps.getSettings()
    void deps.api.streamKeySaved().then((saved) => { keySaved = saved; sync() })
    sync()
  }
  refresh()
  return { root, refresh }
}
