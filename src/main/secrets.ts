import { app, safeStorage } from 'electron'
import { existsSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { t } from '../shared/i18n'

const file = () => join(app.getPath('userData'), 'streamkey.bin')

/** The YouTube stream key is encrypted with the OS keychain (Keychain / DPAPI), never stored as plain text. */
export const streamKey = {
  has: (): boolean => existsSync(file()),
  save(key: string): void {
    if (!safeStorage.isEncryptionAvailable()) throw new Error(t('main.secrets.unavailable'))
    mkdirSync(app.getPath('userData'), { recursive: true })
    writeFileSync(file(), safeStorage.encryptString(key), { mode: 0o600 })
  },
  load(): string | null {
    if (!existsSync(file())) return null
    try {
      return safeStorage.decryptString(readFileSync(file()))
    } catch {
      return null
    }
  },
  forget(): void {
    rmSync(file(), { force: true })
  },
}

const tokenFile = () => join(app.getPath('userData'), 'youtube-auth.bin')

/** The YouTube login (a refresh token) is encrypted the same way. It only lets this app manage broadcasts and is revoked by signing out. */
export const youtubeToken = {
  load(): string | null {
    if (!existsSync(tokenFile()) || !safeStorage.isEncryptionAvailable()) return null
    try {
      return safeStorage.decryptString(readFileSync(tokenFile()))
    } catch {
      return null
    }
  },
  save(token: string | null): void {
    if (token === null) return rmSync(tokenFile(), { force: true })
    if (!safeStorage.isEncryptionAvailable()) throw new Error(t('main.secrets.unavailable'))
    mkdirSync(app.getPath('userData'), { recursive: true })
    writeFileSync(tokenFile(), safeStorage.encryptString(token), { mode: 0o600 })
  },
}
