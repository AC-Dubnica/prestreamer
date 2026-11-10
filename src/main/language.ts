import { app } from 'electron'
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { resolveLanguage, sanitizeLanguageSetting, type Lang, type LanguageSetting } from '../shared/i18n'

/** Where the data folder is: the same rule as at the top of index.ts (a scratch folder for tests), which cannot be used this early. */
const dataFolder = (): string => (process.env.PRESTREAMER_USER_DATA ? resolve(process.env.PRESTREAMER_USER_DATA) : join(app.getPath('appData'), 'prestreamer'))

/** What the operator chose in Settings → Language ('auto' when nothing is saved). */
export function savedLanguageSetting(): LanguageSetting {
  try { return sanitizeLanguageSetting(JSON.parse(readFileSync(join(dataFolder(), 'language.json'), 'utf8')).language) } catch { return 'auto' }
}

/**
 * The language to run in. Tests and the dev hooks stay in English unless PRESTREAMER_LANG says otherwise; otherwise the saved
 * choice, and for 'auto' the computer's language.
 */
export function startupLanguage(locale: string, setting: LanguageSetting = savedLanguageSetting()): Lang {
  if (process.env.PRESTREAMER_LANG) return resolveLanguage(sanitizeLanguageSetting(process.env.PRESTREAMER_LANG), 'en')
  if (process.env.PRESTREAMER_USER_DATA) return 'en'
  return resolveLanguage(setting, locale)
}
