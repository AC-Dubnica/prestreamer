import type { Msg } from './define'
import devices from './messages/devices'
import bible from './messages/bible'
import main from './messages/main'
import mixer from './messages/mixer'
import operator from './messages/operator'
import settings from './messages/settings'
import shared from './messages/shared'
import songs from './messages/songs'
import stream from './messages/stream'

/**
 * Languages of the interface. To add one: add it here, give `defineMessages` a column for it (define.ts) and fill it in every
 * file of messages/ (the compiler lists what is missing), then add a name for it in `LANGUAGES`.
 */
export type Lang = 'en' | 'sk'
export const LANGUAGES: { id: Lang; name: string; /** BCP 47 tag for dates and numbers */ tag: string }[] = [
  { id: 'en', name: 'English', tag: 'en-US' },
  { id: 'sk', name: 'Slovenčina', tag: 'sk-SK' },
]
export const DEFAULT_LANGUAGE: Lang = 'en'

/** What the operator chose: a language, or 'auto' = the one of the computer when there is a translation for it. */
export type LanguageSetting = 'auto' | Lang

export const isLang = (v: unknown): v is Lang => typeof v === 'string' && LANGUAGES.some((l) => l.id === v)
export const sanitizeLanguageSetting = (raw: unknown): LanguageSetting => (raw === 'auto' || isLang(raw) ? raw : 'auto')

/** The language to use for a setting and the computer's locale ("sk-SK", "cs", "en_US"…). Unknown locales get English. */
export function resolveLanguage(setting: LanguageSetting, locale: string): Lang {
  if (setting !== 'auto') return setting
  const primary = locale.toLowerCase().split(/[-_]/)[0]
  return LANGUAGES.find((l) => l.id === primary)?.id ?? DEFAULT_LANGUAGE
}

const catalogs = [bible, devices, main, mixer, operator, settings, shared, songs, stream]
type Catalog = (typeof catalogs)[number]
export type MessageKey = keyof (typeof bible.en & typeof devices.en & typeof main.en & typeof mixer.en & typeof operator.en & typeof settings.en & typeof shared.en & typeof songs.en & typeof stream.en)

const table: Record<Lang, Record<string, Msg>> = { en: {}, sk: {} }
for (const c of catalogs as Catalog[]) for (const lang of Object.keys(table) as Lang[]) Object.assign(table[lang], (c as Record<Lang, Record<string, Msg>>)[lang])

/** The windows get the language from their preload; the main process and the tests set it (or keep English). */
let current: Lang = ((): Lang => {
  const g = globalThis as { prestreamer?: { language?: unknown }; audioBridge?: { language?: unknown } }
  const fromPreload = g.prestreamer?.language ?? g.audioBridge?.language
  return isLang(fromPreload) ? fromPreload : DEFAULT_LANGUAGE
})()

export const getLanguage = (): Lang => current
export function setLanguage(lang: Lang): void { current = lang }

export type Params = Record<string, string | number>

/**
 * The text for a key in the current language, with {placeholders} filled in. A message with plural forms picks one by `n`
 * (Slovak has one / few / many / other). A key missing in the language falls back to English, then to the key itself.
 */
export function t(key: MessageKey, params?: Params): string {
  const msg = table[current][key] ?? table[DEFAULT_LANGUAGE][key]
  return msg === undefined ? key : formatMessage(msg, current, params)
}

/** Picks the plural form (by `n`) and fills in the {placeholders}. */
export function formatMessage(msg: Msg, lang: Lang, params?: Params): string {
  let text: string
  if (typeof msg === 'string') text = msg
  else {
    const form = new Intl.PluralRules(LANGUAGES.find((l) => l.id === lang)?.tag).select(Number(params?.n ?? 0))
    text = (msg as Record<string, string | undefined>)[form] ?? msg.other
  }
  return params ? text.replace(/\{(\w+)\}/g, (m, name: string) => (name in params ? String(params[name]) : m)) : text
}

/** The messages of every language, for the tests that check they agree. */
export const allMessages = table

/** Numbers and dates the way the current language writes them. */
export const localeTag = (): string => LANGUAGES.find((l) => l.id === current)?.tag ?? 'en-US'
export const formatNumber = (n: number, options?: Intl.NumberFormatOptions): string => n.toLocaleString(localeTag(), options)
export const formatTime = (d: Date, options?: Intl.DateTimeFormatOptions): string => d.toLocaleTimeString(localeTag(), options)
export const formatDate = (d: Date, options?: Intl.DateTimeFormatOptions): string => d.toLocaleDateString(localeTag(), options)
