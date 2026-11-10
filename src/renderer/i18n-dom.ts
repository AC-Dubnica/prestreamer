import { t, type MessageKey } from '../shared/i18n'

/**
 * Fills in the text that is written in an HTML page, from attributes (the page cannot call t()):
 *   data-i18n="key"          the element's text
 *   data-i18n-title="key"    its tooltip         data-i18n-placeholder="key"  its placeholder      data-i18n-aria="key"  its aria-label
 * Call it once when the page starts.
 */
export function translateDocument(root: ParentNode = document): void {
  const each = (attr: string, apply: (el: HTMLElement, text: string) => void) => {
    for (const el of root.querySelectorAll<HTMLElement>(`[${attr}]`)) apply(el, t(el.getAttribute(attr) as MessageKey))
  }
  each('data-i18n', (el, text) => { el.textContent = text })
  each('data-i18n-title', (el, text) => { el.title = text })
  each('data-i18n-placeholder', (el, text) => el.setAttribute('placeholder', text))
  each('data-i18n-aria', (el, text) => el.setAttribute('aria-label', text))
}
