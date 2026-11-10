import type { PrestreamerApi } from '../preload'
import { DMX_CHANNELS, FIXTURE_KINDS, MAX_FIXTURES, MAX_SCENES, kindChannels, newId, nextFreeAddress, patchProblems, sanitizeFade, type DmxSettings, type DmxStatus, type Fixture, type FixtureKind, type Scene } from '../shared/dmx'
import { confirmDialog } from './dialogs'
import { iconButton } from './icons'

function el<T extends HTMLElement = HTMLElement>(tag: string, props: Partial<T> = {}, ...kids: (Node | string)[]): T {
  const e = Object.assign(document.createElement(tag) as T, props)
  e.append(...kids)
  return e
}

/** The Settings → DMX page: switching DMX on, the interface, the lights (the patch) and the scenes. Every change is saved at once. */
export function createDmxSettings(api: PrestreamerApi, initial: DmxStatus) {
  let status = initial
  let stale = false
  const root = el('div', { className: 'setsec' })

  const save = (patch: Partial<DmxSettings>) => api.dmxSetSettings({ ...status.settings, ...patch }).then((s) => { status = s; render() })
  const setFixture = (id: string, patch: Partial<Fixture>) => save({ fixtures: status.settings.fixtures.map((f) => (f.id === id ? { ...f, ...patch } : f)) })
  const setScene = (id: string, patch: Partial<Scene>) => save({ scenes: status.settings.scenes.map((s) => (s.id === id ? { ...s, ...patch } : s)) })
  const labelled = <T extends HTMLElement>(node: T, label: string): T => { node.setAttribute('aria-label', label); return node }

  function lightRow(f: Fixture): HTMLElement {
    const name = labelled(el<HTMLInputElement>('input', { type: 'text', value: f.name, maxLength: 60 }), 'Name of the light')
    name.onchange = () => void setFixture(f.id, { name: name.value.trim() || f.name })
    const kind = labelled(el<HTMLSelectElement>('select', {}, ...FIXTURE_KINDS.map((k) => el<HTMLOptionElement>('option', { value: k.kind, textContent: k.label, selected: k.kind === f.kind }))), 'Kind of light')
    kind.onchange = () => void setFixture(f.id, { kind: kind.value as FixtureKind, channels: kindChannels(kind.value as FixtureKind, f.channels) })
    const address = labelled(el<HTMLInputElement>('input', { type: 'number', min: '1', max: String(DMX_CHANNELS), value: String(f.address) }), 'DMX address')
    address.onchange = () => void setFixture(f.id, { address: Math.min(DMX_CHANNELS, Math.max(1, Math.round(Number(address.value) || 1))) })
    const channels = f.kind === 'raw'
      ? (() => {
          const n = labelled(el<HTMLInputElement>('input', { type: 'number', min: '1', max: '32', value: String(f.channels) }), 'Number of channels')
          n.onchange = () => void setFixture(f.id, { channels: kindChannels('raw', Number(n.value)) })
          return el('label', { className: 'inl' }, n, el('span', { className: 'dim', textContent: 'channels' }))
        })()
      : el('span', { className: 'dim', textContent: `${f.channels} channel${f.channels === 1 ? '' : 's'}` })
    const del = iconButton('trash', `Remove ${f.name}`, async () => {
      if (await confirmDialog({ title: `Remove ${f.name}?`, message: 'It is also removed from every scene.', confirm: 'Remove light', danger: true })) void save({ fixtures: status.settings.fixtures.filter((x) => x.id !== f.id) })
    })
    return el('div', { className: 'dmxrow' }, name, kind, el('label', { className: 'inl' }, el('span', { className: 'dim', textContent: 'address' }), address), channels, del)
  }

  function sceneRow(sc: Scene): HTMLElement {
    const s = status.settings
    const name = labelled(el<HTMLInputElement>('input', { type: 'text', value: sc.name, maxLength: 60 }), 'Name of the scene')
    name.onchange = () => void setScene(sc.id, { name: name.value.trim() || sc.name })
    const fade = labelled(el<HTMLInputElement>('input', { type: 'number', min: '0', max: '60', step: '0.5', value: sc.fadeSec === null ? '' : String(sc.fadeSec), placeholder: `${s.fadeSec}` }), 'Fade time in seconds')
    fade.onchange = () => void setScene(sc.id, { fadeSec: fade.value === '' ? null : sanitizeFade(Number(fade.value), 0) })
    const recall = el('button', { textContent: 'Recall', title: 'Send this scene to the lights now', onclick: () => void api.dmxCommand({ type: 'scene', id: sc.id }) })
    const update = el('button', { textContent: 'Use current levels', title: 'Replace this scene with the levels set now', onclick: () => void setScene(sc.id, { values: status.levels }) })
    const del = iconButton('trash', `Remove ${sc.name}`, async () => {
      if (await confirmDialog({ title: `Remove ${sc.name}?`, message: 'The scene is deleted.', confirm: 'Remove scene', danger: true })) void save({ scenes: s.scenes.filter((x) => x.id !== sc.id), startScene: s.startScene === sc.id ? '' : s.startScene })
    })
    return el('div', { className: 'dmxrow' }, name, el('label', { className: 'inl' }, el('span', { className: 'dim', textContent: 'fade (s)' }), fade), recall, update, del)
  }

  function render(): void {
    stale = false
    const s = status.settings
    const enabled = el<HTMLInputElement>('input', { type: 'checkbox', checked: s.enabled })
    enabled.onchange = () => void save({ enabled: enabled.checked })
    const port = labelled(el<HTMLSelectElement>('select', {},
      el<HTMLOptionElement>('option', { value: '', textContent: status.ports.length ? 'Automatic (the first one found)' : 'Automatic (none found)', selected: s.port === '' }),
      ...status.ports.map((p) => el<HTMLOptionElement>('option', { value: p, textContent: p, selected: p === s.port })),
      ...(s.port && !status.ports.includes(s.port) ? [el<HTMLOptionElement>('option', { value: s.port, textContent: `${s.port} (not plugged in)`, selected: true })] : [])), 'DMX interface')
    port.onchange = () => void save({ port: port.value })
    const rescan = el('button', { textContent: 'Rescan', title: 'Look for interfaces again', onclick: () => void api.dmxCommand({ type: 'rescan' }).then((st) => { status = st; render() }) })
    const fade = labelled(el<HTMLInputElement>('input', { type: 'number', min: '0', max: '60', step: '0.5', value: String(s.fadeSec) }), 'Default fade time in seconds')
    fade.onchange = () => void save({ fadeSec: sanitizeFade(Number(fade.value), s.fadeSec) })
    const dark = el<HTMLInputElement>('input', { type: 'checkbox', checked: s.blackoutOnQuit })
    dark.onchange = () => void save({ blackoutOnQuit: dark.checked })
    const start = labelled(el<HTMLSelectElement>('select', {},
      el<HTMLOptionElement>('option', { value: '', textContent: 'None: leave the lights alone', selected: s.startScene === '' }),
      ...s.scenes.map((sc) => el<HTMLOptionElement>('option', { value: sc.id, textContent: sc.name, selected: sc.id === s.startScene }))), 'Scene at start')
    start.onchange = () => void save({ startScene: start.value })

    const problems = patchProblems(s.fixtures)
    const addLight = el<HTMLButtonElement>('button', { textContent: 'Add light', disabled: s.fixtures.length >= MAX_FIXTURES, onclick: () => {
      const rgb = nextFreeAddress(s.fixtures, 3)
      const kind: FixtureKind = rgb ? 'rgb' : 'dimmer'
      void save({ fixtures: [...s.fixtures, { id: newId('light', s.fixtures), name: `Light ${s.fixtures.length + 1}`, kind, address: rgb ?? nextFreeAddress(s.fixtures, 1) ?? 1, channels: kindChannels(kind) }] })
    } })
    const addScene = el<HTMLButtonElement>('button', { textContent: 'Add scene from current levels', disabled: s.fixtures.length === 0 || s.scenes.length >= MAX_SCENES, onclick: () => void save({ scenes: [...s.scenes, { id: newId('scene', s.scenes), name: `Scene ${s.scenes.length + 1}`, fadeSec: null, values: status.levels }] }) })

    root.replaceChildren(
      el('div', { className: 'sethead2' }, el('h2', { textContent: 'DMX lighting' })),
      el('div', { className: 'setcard' },
        el('div', { className: 'sethead' }, el('span', { className: `dot ${status.state === 'sending' ? 'on' : ''}` }), el('strong', { className: 'scname', textContent: s.enabled ? (status.state === 'sending' ? 'Sending' : status.state === 'error' ? 'Not working' : 'Ready') : 'Switched off' }), el('span', { className: 'grow' })),
        el('div', { className: status.state === 'error' ? 'warn' : 'dim', textContent: status.message }),
        el('label', { className: 'srow2' }, el('span', { textContent: 'Use DMX' }), el('span', { className: 'inl' }, enabled, el('span', { className: 'dim', textContent: 'shows the lighting panel in the Present tab' }))),
        el('label', { className: 'srow2' }, el('span', { textContent: 'Interface' }), el('span', { className: 'inl' }, port, rescan)),
        el('label', { className: 'srow2' }, el('span', { textContent: 'Fade' }), el('span', { className: 'inl' }, fade, el('span', { className: 'dim', textContent: 'seconds, for scenes without their own' }))),
        el('label', { className: 'srow2' }, el('span', { textContent: 'At start' }), el('span', { className: 'inl' }, start)),
        el('label', { className: 'srow2' }, el('span', { textContent: 'On quit' }), el('span', { className: 'inl' }, dark, el('span', { className: 'dim', textContent: 'black out when PreStreamer closes (otherwise the signal just stops)' }))),
      ),
      el('h3', { className: 'sethead3', textContent: 'Lights' }),
      el('div', { className: 'setcard' },
        ...(s.fixtures.length ? s.fixtures.map(lightRow) : [el('div', { className: 'dim', textContent: 'No lights yet. Add each light or group of lights with the address set on the fixture itself.' })]),
        ...problems.map((p) => el('div', { className: 'warn', textContent: p })),
        el('div', { className: 'dmxadd' }, addLight),
      ),
      el('h3', { className: 'sethead3', textContent: 'Scenes' }),
      el('div', { className: 'setcard' },
        ...(s.scenes.length ? s.scenes.map(sceneRow) : [el('div', { className: 'dim', textContent: 'No scenes yet. Set the levels in the Present tab (Levels), then save them as a scene.' })]),
        el('div', { className: 'dmxadd' }, addScene),
      ),
      el('p', { className: 'dim', textContent: 'Connect an Enttec Open DMX USB (or a compatible FTDI interface) and run its DMX cable to the first light. On macOS and Linux no driver is needed. Lights are not touched until you recall a scene or move a fader.' }),
    )
  }

  // A status push must not replace a field being typed in: it waits until the focus leaves.
  root.addEventListener('focusout', () => { if (stale) setTimeout(() => { if (stale && !root.contains(document.activeElement)) render() }, 0) })
  render()
  return {
    root,
    update(next: DmxStatus): void {
      status = next
      const a = document.activeElement
      if (a && root.contains(a) && (a instanceof HTMLInputElement || a instanceof HTMLSelectElement)) stale = true
      else render()
    },
  }
}
