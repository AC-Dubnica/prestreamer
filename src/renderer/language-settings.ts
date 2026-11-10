import type { PrestreamerApi } from '../preload'
import { LANGUAGES, resolveLanguage, t, type LanguageSetting } from '../shared/i18n'

function el<T extends HTMLElement = HTMLElement>(tag: string, props: Partial<T> = {}, ...kids: (Node | string)[]): T {
  const e = Object.assign(document.createElement(tag) as T, props)
  e.append(...kids)
  return e
}

/** The Settings → Language page. Changing the language reloads the window, which builds every text again. */
export function createLanguageSettings(api: PrestreamerApi) {
  const root = el('div', { className: 'setsec' })
  async function render(): Promise<void> {
    const { setting } = await api.languageGet()
    const computer = LANGUAGES.find((l) => l.id === resolveLanguage('auto', navigator.language))?.name ?? LANGUAGES[0].name
    const select = el<HTMLSelectElement>('select', {},
      el<HTMLOptionElement>('option', { value: 'auto', textContent: t('settings.language.auto', { name: computer }), selected: setting === 'auto' }),
      ...LANGUAGES.map((l) => el<HTMLOptionElement>('option', { value: l.id, textContent: l.name, selected: setting === l.id })))
    select.setAttribute('aria-label', t('settings.language.label'))
    select.onchange = () => void api.languageSet(select.value as LanguageSetting)
    root.replaceChildren(
      el('div', { className: 'sethead2' }, el('h2', { textContent: t('settings.language.title') })),
      el('div', { className: 'setcard' }, el('label', { className: 'srow2' }, el('span', { textContent: t('settings.language.label') }), el('span', { className: 'inl' }, select))),
      el('p', { className: 'dim', textContent: t('settings.language.hint') }),
    )
  }
  void render()
  return { root, refresh: () => void render() }
}
