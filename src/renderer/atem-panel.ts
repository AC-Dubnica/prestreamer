import type { PrestreamerApi } from '../preload'
import { t } from '../shared/i18n'
import { canSend, idleAtem, type AtemCommand, type AtemStatus } from '../shared/atem'

function el<T extends HTMLElement = HTMLElement>(tag: string, props: Partial<T> = {}, ...kids: (Node | string)[]): T {
  const e = Object.assign(document.createElement(tag) as T, props)
  e.append(...kids)
  return e
}

/**
 * The ATEM controls: program and preview rows, Cut and Auto. The whole section (`host`) is shown only while a switcher is
 * connected, so nobody without one sees it; the address and which buttons to show are in Settings → ATEM. Control is over Ethernet.
 */
export function createAtemPanel(body: HTMLElement, api: PrestreamerApi, host: HTMLElement) {
  let status: AtemStatus = idleAtem

  const dot = el('span', { className: 'hdot' })
  const label = el('b')
  const title = el('div', { className: 'hhead' }, dot, label)
  const program = el('div', { className: 'atemrow' })
  const preview = el('div', { className: 'atemrow' })
  const cut = el<HTMLButtonElement>('button', { textContent: t('devices.atem.cut'), title: t('devices.atem.cutHint') })
  const auto = el<HTMLButtonElement>('button', { textContent: t('devices.atem.auto'), title: t('devices.atem.autoHint') })
  const note = el('div', { className: 'status' })
  const group = (caption: string, row: HTMLElement) => el('div', { className: 'atemgrp' }, el('div', { className: 'atemcap', textContent: caption }), row)
  const previewGroup = group(t('devices.atem.preview'), preview)
  const go = el('div', { className: 'form atemgo' }, cut, auto)
  const panel = el('div', { className: 'panelbox atem' }, title, el('div', { className: 'atemgrid' }, group(t('devices.atem.program'), program), previewGroup, go), note)
  body.replaceChildren(panel)

  const send = (cmd: AtemCommand) => { if (canSend(status, cmd)) void api.atemSend(cmd) }
  cut.onclick = () => send({ type: 'cut' })
  auto.onclick = () => send({ type: 'auto' })

  function inputButtons(row: HTMLElement, kind: 'program' | 'preview'): void {
    const cmdFor = (input: number): AtemCommand => ({ type: kind, input })
    row.replaceChildren(...status.inputs.map((i) => {
      const on = (kind === 'program' ? status.program : status.preview) === i.id
      const b = el<HTMLButtonElement>('button', { textContent: i.name, title: t(kind === 'program' ? 'devices.atem.inputHintProgram' : 'devices.atem.inputHintPreview', { name: i.longName }), className: `atembtn ${kind}${on ? ' on' : ''}` })
      b.disabled = !canSend(status, cmdFor(i.id))
      b.setAttribute('aria-pressed', String(on))
      b.onclick = () => send(cmdFor(i.id))
      return b
    }))
  }

  function render(): void {
    const on = status.state === 'connected'
    host.hidden = !on
    dot.className = 'hdot good'
    label.textContent = status.model
    inputButtons(program, 'program')
    inputButtons(preview, 'preview')
    // What the operator chose to show (Settings → ATEM).
    previewGroup.hidden = !status.buttons.preview
    cut.hidden = !status.buttons.cut
    auto.hidden = !status.buttons.auto
    go.hidden = !status.buttons.cut && !status.buttons.auto
    cut.disabled = !canSend(status, { type: 'cut' })
    auto.disabled = !canSend(status, { type: 'auto' })
    note.textContent = status.message
  }

  api.onAtem((s) => { status = s; render() })
  void api.atemGet().then((s) => { status = s; render() })
  render()
}
