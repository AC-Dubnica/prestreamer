import { t } from '../shared/i18n'

/** Modal dialogs. Electron has no window.prompt/confirm, and a native dialog would not match the app anyway. */

function el<T extends HTMLElement = HTMLElement>(tag: string, props: Partial<T> = {}, ...kids: (Node | string)[]): T {
  const e = Object.assign(document.createElement(tag) as T, props)
  e.append(...kids)
  return e
}

/**
 * Shows `build()`'s content in the modal layer. Esc or a click on the backdrop closes it.
 * Returns the close function; `onClose` runs however it was closed.
 */
export function showModal(build: (close: () => void) => HTMLElement, onClose?: () => void): () => void {
  const modal = document.getElementById('modal')!
  let closed = false
  const onKey = (e: KeyboardEvent) => {
    if (e.key !== 'Escape') return
    e.stopPropagation()
    close()
  }
  const close = () => {
    if (closed) return
    closed = true
    modal.hidden = true
    modal.replaceChildren()
    modal.onclick = null
    document.removeEventListener('keydown', onKey, true)
    onClose?.()
  }
  document.addEventListener('keydown', onKey, true)
  modal.onclick = (e) => { if (e.target === modal) close() }
  modal.replaceChildren(build(close))
  modal.hidden = false
  return close
}

const dialog = (title: string, body: HTMLElement[], footer: HTMLElement[]): HTMLElement =>
  el('div', { className: 'dialog pad', role: 'dialog' }, el('h3', { className: 'dhead', textContent: title }), el('div', { className: 'dbody' }, ...body), el('div', { className: 'dfoot' }, ...footer))

export interface AskTextOptions {
  title: string
  label: string
  value?: string
  placeholder?: string
  confirm?: string
}

/** Asks for a line of text. Resolves with the trimmed text, or null if cancelled. An empty answer cannot be confirmed. */
export function askText(o: AskTextOptions): Promise<string | null> {
  return new Promise((resolve) => {
    let answered = false
    const input = el<HTMLInputElement>('input', { type: 'text', value: o.value ?? '', placeholder: o.placeholder ?? '', maxLength: 80 })
    const ok = el<HTMLButtonElement>('button', { className: 'primary', textContent: o.confirm ?? t('operator.dialog.ok') })
    const refresh = () => { ok.disabled = !input.value.trim() }
    const close = showModal(
      (close) => {
        const submit = () => {
          const v = input.value.trim()
          if (!v) return
          answered = true
          resolve(v)
          close()
        }
        ok.onclick = submit
        input.oninput = refresh
        input.onkeydown = (e) => { if (e.key === 'Enter') submit() }
        return dialog(o.title, [el('label', { className: 'dlabel', textContent: o.label }), input], [el('button', { textContent: t('operator.dialog.cancel'), onclick: () => close() }), ok])
      },
      () => { if (!answered) resolve(null) },
    )
    refresh()
    input.focus()
    input.select()
  })
}

export interface ConfirmOptions {
  title: string
  message: string
  confirm?: string
  /** Style the confirm button as destructive. */
  danger?: boolean
}

/** Asks a yes/no question. Resolves true only if the confirm button was pressed. */
export function confirmDialog(o: ConfirmOptions): Promise<boolean> {
  return new Promise((resolve) => {
    let answered = false
    showModal(
      (close) => {
        const ok = el('button', { className: o.danger ? 'danger' : 'primary', textContent: o.confirm ?? t('operator.dialog.ok'), onclick: () => { answered = true; resolve(true); close() } })
        const cancel = el('button', { textContent: t('operator.dialog.cancel'), onclick: () => close() })
        queueMicrotask(() => (o.danger ? cancel : ok).focus()) // a destructive action is never the default
        return dialog(o.title, [el('p', { className: 'dmsg', textContent: o.message })], [cancel, ok])
      },
      () => { if (!answered) resolve(false) },
    )
  })
}
