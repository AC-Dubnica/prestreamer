import { app, safeStorage } from 'electron'
import { existsSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

const file = () => join(app.getPath('userData'), 'streamkey.bin')

/** The YouTube stream key is encrypted with the OS keychain (Keychain / DPAPI), never stored as plain text. */
export const streamKey = {
  has: (): boolean => existsSync(file()),
  save(key: string): void {
    if (!safeStorage.isEncryptionAvailable()) throw new Error('OS secure storage is not available; key not saved')
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
