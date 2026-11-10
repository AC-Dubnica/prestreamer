import { describe, expect, it } from 'vitest'
import { LANGUAGES, allMessages, formatMessage, resolveLanguage, sanitizeLanguageSetting, t } from '../src/shared/i18n'

const placeholders = (m: unknown): string[] => [...new Set(JSON.stringify(m).match(/\{\w+\}/g) ?? [])].sort()

describe('language choice', () => {
  it('follows the computer when set to automatic, with English for what has no translation', () => {
    expect(resolveLanguage('auto', 'sk-SK')).toBe('sk')
    expect(resolveLanguage('auto', 'sk')).toBe('sk')
    expect(resolveLanguage('auto', 'en_US')).toBe('en')
    expect(resolveLanguage('auto', 'cs-CZ')).toBe('en')
    expect(resolveLanguage('auto', '')).toBe('en')
  })

  it('an explicit choice wins over the computer', () => {
    expect(resolveLanguage('en', 'sk-SK')).toBe('en')
    expect(resolveLanguage('sk', 'en-US')).toBe('sk')
  })

  it('accepts only known settings', () => {
    expect(sanitizeLanguageSetting('sk')).toBe('sk')
    expect(sanitizeLanguageSetting('auto')).toBe('auto')
    for (const bad of ['de', '', null, 5, {}]) expect(sanitizeLanguageSetting(bad)).toBe('auto')
  })
})

describe('messages', () => {
  const [reference, ...others] = LANGUAGES.map((l) => l.id)

  it('every language has exactly the keys of English, with the same placeholders', () => {
    for (const lang of others) {
      expect(Object.keys(allMessages[lang]).sort(), lang).toEqual(Object.keys(allMessages[reference]).sort())
      for (const [key, msg] of Object.entries(allMessages[reference])) {
        expect(placeholders(allMessages[lang][key]), `${lang} ${key}`).toEqual(placeholders(msg))
      }
    }
  })

  it('every key starts with the name of the file that defines it, so files never clash', async () => {
    const files = import.meta.glob('../src/shared/i18n/messages/*.ts', { eager: true }) as Record<string, { default: { en: Record<string, unknown> } }>
    for (const [path, mod] of Object.entries(files)) {
      const ns = /\/(\w+)\.ts$/.exec(path)![1]
      for (const key of Object.keys(mod.default.en)) expect(key.startsWith(`${ns}.`), `${path}: ${key}`).toBe(true)
    }
  })

  it('no message is empty, and plural messages always have an "other" form', () => {
    for (const lang of [reference, ...others]) {
      for (const [key, msg] of Object.entries(allMessages[lang])) {
        if (typeof msg === 'string') expect(msg.trim(), `${lang} ${key}`).not.toBe('')
        else expect(typeof msg.other, `${lang} ${key}`).toBe('string')
      }
    }
  })

  it('fills in placeholders and leaves unknown ones', () => {
    expect(formatMessage('Hello {name}, {x}', 'en', { name: 'Ann' })).toBe('Hello Ann, {x}')
  })

  it('picks the plural form of the language: Slovak has one, few and other', () => {
    const songs = { one: '{n} pieseň', few: '{n} piesne', other: '{n} piesní' }
    expect(formatMessage(songs, 'sk', { n: 1 })).toBe('1 pieseň')
    expect(formatMessage(songs, 'sk', { n: 3 })).toBe('3 piesne')
    expect(formatMessage(songs, 'sk', { n: 5 })).toBe('5 piesní')
    expect(formatMessage(songs, 'sk', { n: 0 })).toBe('0 piesní')
    expect(formatMessage({ one: '{n} song', other: '{n} songs' }, 'en', { n: 2 })).toBe('2 songs')
  })

  it('English is the language of the tests, and an unknown key shows itself', () => {
    expect(t('settings.language.title')).toBe('Language')
    expect(t('nope.missing' as never)).toBe('nope.missing')
  })
})
