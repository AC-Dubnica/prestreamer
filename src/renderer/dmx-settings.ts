import type { PrestreamerApi } from '../preload'
import { DMX_CHANNELS, FIXTURE_KINDS, MAX_FIXTURES, MAX_SCENES, kindChannels, newId, nextFreeAddress, patchProblems, sanitizeFade, type DmxSettings, type DmxStatus, type Fixture, type FixtureKind, type Scene } from '../shared/dmx'
import { t } from '../shared/i18n'
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
    const name = labelled(el<HTMLInputElement>('input', { type: 'text', value: f.name, maxLength: 60 }), t('devices.dmxSet.lightName'))
    name.onchange = () => void setFixture(f.id, { name: name.value.trim() || f.name })
    const kind = labelled(el<HTMLSelectElement>('select', {}, ...FIXTURE_KINDS.map((k) => el<HTMLOptionElement>('option', { value: k.kind, textContent: k.label, selected: k.kind === f.kind }))), t('devices.dmxSet.lightKind'))
    kind.onchange = () => void setFixture(f.id, { kind: kind.value as FixtureKind, channels: kindChannels(kind.value as FixtureKind, f.channels) })
    const address = labelled(el<HTMLInputElement>('input', { type: 'number', min: '1', max: String(DMX_CHANNELS), value: String(f.address) }), t('devices.dmxSet.address'))
    address.onchange = () => void setFixture(f.id, { address: Math.min(DMX_CHANNELS, Math.max(1, Math.round(Number(address.value) || 1))) })
    const channels = f.kind === 'raw'
      ? (() => {
          const n = labelled(el<HTMLInputElement>('input', { type: 'number', min: '1', max: '32', value: String(f.channels) }), t('devices.dmxSet.channelCount'))
          n.onchange = () => void setFixture(f.id, { channels: kindChannels('raw', Number(n.value)) })
          return el('label', { className: 'inl' }, n, el('span', { className: 'dim', textContent: t('devices.dmxSet.channels') }))
        })()
      : el('span', { className: 'dim', textContent: t('devices.dmxSet.nChannels', { n: f.channels }) })
    const del = iconButton('trash', t('devices.dmxSet.removeThing', { name: f.name }), async () => {
      if (await confirmDialog({ title: t('devices.dmxSet.removeAsk', { name: f.name }), message: t('devices.dmxSet.removeLightMsg'), confirm: t('devices.dmxSet.removeLight'), danger: true })) void save({ fixtures: status.settings.fixtures.filter((x) => x.id !== f.id) })
    })
    return el('div', { className: 'dmxrow' }, name, kind, el('label', { className: 'inl' }, el('span', { className: 'dim', textContent: t('devices.dmxSet.addressShort') }), address), channels, del)
  }

  function sceneRow(sc: Scene): HTMLElement {
    const s = status.settings
    const name = labelled(el<HTMLInputElement>('input', { type: 'text', value: sc.name, maxLength: 60 }), t('devices.dmxSet.sceneName'))
    name.onchange = () => void setScene(sc.id, { name: name.value.trim() || sc.name })
    const fade = labelled(el<HTMLInputElement>('input', { type: 'number', min: '0', max: '60', step: '0.5', value: sc.fadeSec === null ? '' : String(sc.fadeSec), placeholder: `${s.fadeSec}` }), t('devices.dmxSet.fadeSecLabel'))
    fade.onchange = () => void setScene(sc.id, { fadeSec: fade.value === '' ? null : sanitizeFade(Number(fade.value), 0) })
    const recall = el('button', { textContent: t('devices.dmxSet.recall'), title: t('devices.dmxSet.recallHint'), onclick: () => void api.dmxCommand({ type: 'scene', id: sc.id }) })
    const update = el('button', { textContent: t('devices.dmxSet.useCurrent'), title: t('devices.dmxSet.useCurrentHint'), onclick: () => void setScene(sc.id, { values: status.levels }) })
    const del = iconButton('trash', t('devices.dmxSet.removeThing', { name: sc.name }), async () => {
      if (await confirmDialog({ title: t('devices.dmxSet.removeAsk', { name: sc.name }), message: t('devices.dmxSet.removeSceneMsg'), confirm: t('devices.dmxSet.removeScene'), danger: true })) void save({ scenes: s.scenes.filter((x) => x.id !== sc.id), startScene: s.startScene === sc.id ? '' : s.startScene })
    })
    return el('div', { className: 'dmxrow' }, name, el('label', { className: 'inl' }, el('span', { className: 'dim', textContent: t('devices.dmxSet.fadeShort') }), fade), recall, update, del)
  }

  function render(): void {
    stale = false
    const s = status.settings
    const enabled = el<HTMLInputElement>('input', { type: 'checkbox', checked: s.enabled })
    enabled.onchange = () => void save({ enabled: enabled.checked })
    const port = labelled(el<HTMLSelectElement>('select', {},
      el<HTMLOptionElement>('option', { value: '', textContent: status.ports.length ? t('devices.dmxSet.autoFound') : t('devices.dmxSet.autoNone'), selected: s.port === '' }),
      ...status.ports.map((p) => el<HTMLOptionElement>('option', { value: p, textContent: p, selected: p === s.port })),
      ...(s.port && !status.ports.includes(s.port) ? [el<HTMLOptionElement>('option', { value: s.port, textContent: t('devices.dmxSet.notPlugged', { port: s.port }), selected: true })] : [])), t('devices.dmxSet.interface'))
    port.onchange = () => void save({ port: port.value })
    const rescan = el('button', { textContent: t('devices.dmxSet.rescan'), title: t('devices.dmxSet.rescanHint'), onclick: () => void api.dmxCommand({ type: 'rescan' }).then((st) => { status = st; render() }) })
    const fade = labelled(el<HTMLInputElement>('input', { type: 'number', min: '0', max: '60', step: '0.5', value: String(s.fadeSec) }), t('devices.dmxSet.defaultFade'))
    fade.onchange = () => void save({ fadeSec: sanitizeFade(Number(fade.value), s.fadeSec) })
    const dark = el<HTMLInputElement>('input', { type: 'checkbox', checked: s.blackoutOnQuit })
    dark.onchange = () => void save({ blackoutOnQuit: dark.checked })
    const start = labelled(el<HTMLSelectElement>('select', {},
      el<HTMLOptionElement>('option', { value: '', textContent: t('devices.dmxSet.noneStart'), selected: s.startScene === '' }),
      ...s.scenes.map((sc) => el<HTMLOptionElement>('option', { value: sc.id, textContent: sc.name, selected: sc.id === s.startScene }))), t('devices.dmxSet.sceneAtStart'))
    start.onchange = () => void save({ startScene: start.value })

    const problems = patchProblems(s.fixtures)
    const addLight = el<HTMLButtonElement>('button', { textContent: t('devices.dmxSet.addLight'), disabled: s.fixtures.length >= MAX_FIXTURES, onclick: () => {
      const rgb = nextFreeAddress(s.fixtures, 3)
      const kind: FixtureKind = rgb ? 'rgb' : 'dimmer'
      void save({ fixtures: [...s.fixtures, { id: newId('light', s.fixtures), name: t('devices.dmxSet.newLight', { n: s.fixtures.length + 1 }), kind, address: rgb ?? nextFreeAddress(s.fixtures, 1) ?? 1, channels: kindChannels(kind) }] })
    } })
    const addScene = el<HTMLButtonElement>('button', { textContent: t('devices.dmxSet.addScene'), disabled: s.fixtures.length === 0 || s.scenes.length >= MAX_SCENES, onclick: () => void save({ scenes: [...s.scenes, { id: newId('scene', s.scenes), name: t('devices.dmxSet.newScene', { n: s.scenes.length + 1 }), fadeSec: null, values: status.levels }] }) })

    root.replaceChildren(
      el('div', { className: 'sethead2' }, el('h2', { textContent: t('devices.dmx.title') })),
      el('div', { className: 'setcard' },
        el('div', { className: 'sethead' }, el('span', { className: `dot ${status.state === 'sending' ? 'on' : ''}` }), el('strong', { className: 'scname', textContent: s.enabled ? (status.state === 'sending' ? t('devices.dmxSet.sending') : status.state === 'error' ? t('devices.dmxSet.notWorking') : t('devices.dmxSet.ready')) : t('devices.dmxSet.switchedOff') }), el('span', { className: 'grow' })),
        el('div', { className: status.state === 'error' ? 'warn' : 'dim', textContent: status.message }),
        el('label', { className: 'srow2' }, el('span', { textContent: t('devices.dmxSet.useDmx') }), el('span', { className: 'inl' }, enabled, el('span', { className: 'dim', textContent: t('devices.dmxSet.useDmxHint') }))),
        el('label', { className: 'srow2' }, el('span', { textContent: t('devices.dmxSet.interfaceRow') }), el('span', { className: 'inl' }, port, rescan)),
        el('label', { className: 'srow2' }, el('span', { textContent: t('devices.dmxSet.fade') }), el('span', { className: 'inl' }, fade, el('span', { className: 'dim', textContent: t('devices.dmxSet.fadeHint') }))),
        el('label', { className: 'srow2' }, el('span', { textContent: t('devices.dmxSet.atStart') }), el('span', { className: 'inl' }, start)),
        el('label', { className: 'srow2' }, el('span', { textContent: t('devices.dmxSet.onQuit') }), el('span', { className: 'inl' }, dark, el('span', { className: 'dim', textContent: t('devices.dmxSet.onQuitHint') }))),
      ),
      el('h3', { className: 'sethead3', textContent: t('devices.dmxSet.lights') }),
      el('div', { className: 'setcard' },
        ...(s.fixtures.length ? s.fixtures.map(lightRow) : [el('div', { className: 'dim', textContent: t('devices.dmxSet.noLights') })]),
        ...problems.map((p) => el('div', { className: 'warn', textContent: p })),
        el('div', { className: 'dmxadd' }, addLight),
      ),
      el('h3', { className: 'sethead3', textContent: t('devices.dmxSet.scenes') }),
      el('div', { className: 'setcard' },
        ...(s.scenes.length ? s.scenes.map(sceneRow) : [el('div', { className: 'dim', textContent: t('devices.dmxSet.noScenes') })]),
        el('div', { className: 'dmxadd' }, addScene),
      ),
      el('p', { className: 'dim', textContent: t('devices.dmxSet.intro') }),
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
