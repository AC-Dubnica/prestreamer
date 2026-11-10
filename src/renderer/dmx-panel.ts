import type { PrestreamerApi } from '../preload'
import { channelLabels, idleDmx, newId, type DmxStatus } from '../shared/dmx'
import { askText } from './dialogs'

function el<T extends HTMLElement = HTMLElement>(tag: string, props: Partial<T> = {}, ...kids: (Node | string)[]): T {
  const e = Object.assign(document.createElement(tag) as T, props)
  e.append(...kids)
  return e
}

/**
 * The lighting controls of the Present tab: scene buttons, Blackout, the grand master and (folded away) a fader per channel of
 * every light. The whole section (`host`) is shown only once DMX is switched on in Settings → DMX. The structure is rebuilt only
 * when the lights or scenes change, so a fader being dragged is never replaced under the pointer.
 */
export function createDmxPanel(body: HTMLElement, api: PrestreamerApi, host: HTMLElement) {
  let status: DmxStatus = idleDmx
  let signature = ''

  const dot = el('span', { className: 'hdot' })
  const label = el('b', { textContent: 'DMX lighting' })
  const sub = el('span', { className: 'hsub' })
  const scenes = el('div', { className: 'atemrow' })
  const blackout = el<HTMLButtonElement>('button', { textContent: 'Blackout', title: 'All lights off at once (the scene and levels are kept; press again to bring them back)' })
  const masterValue = el('span', { className: 'dim dmxval' })
  const master = el<HTMLInputElement>('input', { type: 'range', min: '0', max: '100', step: '1', value: '100', title: 'Grand master: scales every light', ariaLabel: 'Grand master' } as Partial<HTMLInputElement>)
  const save = el<HTMLButtonElement>('button', { textContent: 'Save as scene…', title: 'Keep the levels set now as a new scene' })
  const levels = el('div', { className: 'dmxlevels' })
  const details = el<HTMLDetailsElement>('details', { className: 'dmxdetails' }, el('summary', { textContent: 'Levels' }), levels)
  const note = el('div', { className: 'status' })
  const mixrow = el('div', { className: 'dmxmix' }, blackout, el('span', { className: 'dim', textContent: 'Master' }), master, masterValue)
  const panel = el('div', { className: 'panelbox dmx' }, el('div', { className: 'hhead' }, dot, label, sub), scenes, mixrow, el('div', { className: 'dmxsave' }, save), details, note)
  body.replaceChildren(panel)

  const sliders = new Map<string, HTMLInputElement>() // `${fixture}:${channel}`
  const sceneButtons = new Map<string, HTMLButtonElement>()

  blackout.onclick = () => void api.dmxCommand({ type: 'blackout', on: !status.blackout })
  master.oninput = () => { masterValue.textContent = `${master.value}%`; void api.dmxCommand({ type: 'master', value: Number(master.value) }) }
  save.onclick = async () => {
    const name = await askText({ title: 'Save as scene', label: 'Name of the scene (for example “Worship” or “Prayer”)', placeholder: 'Worship', confirm: 'Save' })
    if (name === null) return
    const s = status.settings
    await api.dmxSetSettings({ ...s, scenes: [...s.scenes, { id: newId('scene', s.scenes), name, fadeSec: null, values: status.levels }] })
  }

  function build(): void {
    const s = status.settings
    sceneButtons.clear()
    scenes.replaceChildren(...s.scenes.map((sc) => {
      const b = el<HTMLButtonElement>('button', { textContent: sc.name, className: 'atembtn program', title: `Recall “${sc.name}”${sc.fadeSec === null ? '' : ` (fades in ${sc.fadeSec} s)`}` })
      b.onclick = () => void api.dmxCommand({ type: 'scene', id: sc.id })
      sceneButtons.set(sc.id, b)
      return b
    }))
    sliders.clear()
    levels.replaceChildren(...s.fixtures.map((f) => {
      const labels = channelLabels(f)
      return el('div', { className: 'dmxfix' },
        el('div', { className: 'dmxname', textContent: f.name, title: `${f.name}: channels ${f.address}–${f.address + f.channels - 1}` }),
        ...labels.map((name, i) => {
          const slider = el<HTMLInputElement>('input', { type: 'range', min: '0', max: '255', step: '1', value: '0', title: `${f.name} ${name}`, ariaLabel: `${f.name} ${name}` } as Partial<HTMLInputElement>)
          const val = el('span', { className: 'dim dmxval' })
          slider.oninput = () => { val.textContent = slider.value; void api.dmxCommand({ type: 'level', fixture: f.id, channel: i, value: Number(slider.value) }) }
          sliders.set(`${f.id}:${i}`, slider)
          return el('label', { className: 'dmxch' }, el('span', { className: 'dim', textContent: name }), slider, val)
        }))
    }))
  }

  function render(): void {
    host.hidden = status.state === 'off'
    const s = status.settings
    const sig = JSON.stringify([s.scenes.map((x) => [x.id, x.name, x.fadeSec]), s.fixtures.map((f) => [f.id, f.name, f.kind, f.channels, f.address])])
    if (sig !== signature) { signature = sig; build() }
    dot.className = `hdot ${status.state === 'sending' ? 'good' : status.state === 'starting' ? 'warn' : status.state === 'error' ? 'poor' : ''}`
    sub.textContent = status.state === 'sending' ? status.port.replace('/dev/', '') : ''
    for (const [id, b] of sceneButtons) { b.classList.toggle('on', status.scene === id); b.setAttribute('aria-pressed', String(status.scene === id)) }
    blackout.classList.toggle('danger', status.blackout)
    blackout.setAttribute('aria-pressed', String(status.blackout))
    if (document.activeElement !== master) master.value = String(status.master)
    masterValue.textContent = `${status.master}%`
    for (const f of s.fixtures) {
      channelLabels(f).forEach((_n, i) => {
        const slider = sliders.get(`${f.id}:${i}`)
        if (!slider || document.activeElement === slider) return
        const v = status.levels[f.id]?.[i] ?? 0
        slider.value = String(v)
        const val = slider.parentElement?.querySelector('.dmxval')
        if (val) val.textContent = String(v)
      })
    }
    save.disabled = s.fixtures.length === 0
    scenes.hidden = s.scenes.length === 0
    details.hidden = s.fixtures.length === 0
    note.textContent = status.message
  }

  api.onDmx((s) => { status = s; render() })
  void api.dmxGet().then((s) => { status = s; render() })
  render()
}
