import type { PrestreamerApi } from '../preload'
import { canSend, idleAtem, type AtemCommand, type AtemStatus } from '../shared/atem'
import { askText } from './dialogs'
import { iconButton } from './icons'

function el<T extends HTMLElement = HTMLElement>(tag: string, props: Partial<T> = {}, ...kids: (Node | string)[]): T {
  const e = Object.assign(document.createElement(tag) as T, props)
  e.append(...kids)
  return e
}

/**
 * The ATEM section of the Present tab: program and preview rows, Cut and Auto. While no switcher answers the whole
 * panel is shown greyed out with the reason; only the address button stays usable. Control is over Ethernet.
 */
export function createAtemPanel(head: HTMLElement, body: HTMLElement, api: PrestreamerApi) {
  let status: AtemStatus = idleAtem

  const dot = el('span', { className: 'hdot' })
  const label = el('b')
  const title = el('div', { className: 'hhead' }, dot, label)
  const program = el('div', { className: 'atemrow' })
  const preview = el('div', { className: 'atemrow' })
  const cut = el<HTMLButtonElement>('button', { textContent: 'Cut', title: 'Swap preview and program at once' })
  const auto = el<HTMLButtonElement>('button', { textContent: 'Auto', title: 'Swap preview and program with the switcher\'s transition' })
  const note = el('div', { className: 'status' })
  const panel = el('div', { className: 'panelbox atem' }, title, el('div', { className: 'atemcap', textContent: 'Program' }), program, el('div', { className: 'atemcap', textContent: 'Preview' }), preview, el('div', { className: 'form atemgo' }, cut, auto), note)
  body.replaceChildren(panel)

  const send = (cmd: AtemCommand) => { if (canSend(status, cmd)) void api.atemSend(cmd) }
  cut.onclick = () => send({ type: 'cut' })
  auto.onclick = () => send({ type: 'auto' })

  const settingsButton = iconButton('gear', 'ATEM address: the switcher is controlled over Ethernet (its USB port is only a webcam)', async () => {
    const value = await askText({ title: 'ATEM address', label: 'IP address of the switcher (ATEM Software Control shows it; factory setting 192.168.10.240)', value: status.address, placeholder: '192.168.10.240', confirm: 'Connect' })
    if (value !== null) { status = await api.atemSetAddress(value); render() }
  }, { size: 15 })
  head.append(settingsButton)

  function inputButtons(row: HTMLElement, kind: 'program' | 'preview'): void {
    const cmdFor = (input: number): AtemCommand => ({ type: kind, input })
    row.replaceChildren(...status.inputs.map((i) => {
      const on = (kind === 'program' ? status.program : status.preview) === i.id
      const b = el<HTMLButtonElement>('button', { textContent: i.name, title: `${i.longName}: put on ${kind}`, className: `atembtn ${kind}${on ? ' on' : ''}` })
      b.disabled = !canSend(status, cmdFor(i.id))
      b.setAttribute('aria-pressed', String(on))
      b.onclick = () => send(cmdFor(i.id))
      return b
    }))
  }

  function render(): void {
    const on = status.state === 'connected'
    panel.classList.toggle('off', !on)
    panel.setAttribute('aria-disabled', String(!on))
    dot.className = `hdot ${on ? 'good' : ''}`
    label.textContent = on ? status.model : 'ATEM not connected'
    inputButtons(program, 'program')
    inputButtons(preview, 'preview')
    if (!on) {
      // Placeholder buttons so the disabled panel still shows what it will offer.
      for (const [row, kind] of [[program, 'program'], [preview, 'preview']] as const) {
        row.replaceChildren(...[1, 2, 3, 4].map((n) => Object.assign(el<HTMLButtonElement>('button', { textContent: `CAM ${n}`, className: `atembtn ${kind}` }), { disabled: true })))
      }
    }
    cut.disabled = !canSend(status, { type: 'cut' })
    auto.disabled = !canSend(status, { type: 'auto' })
    note.textContent = status.message
  }

  api.onAtem((s) => { status = s; render() })
  void api.atemGet().then((s) => { status = s; render() })
  render()
}
