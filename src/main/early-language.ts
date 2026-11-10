import { app } from 'electron'
import { setLanguage } from '../shared/i18n'
import { startupLanguage } from './language'

// Imported first by index.ts: modules that build some of their text when they load (constants such as "no interface found")
// are evaluated after this, so they already use the right language. Electron's own locale is not known before the app is ready,
// so the system's is used for now; the ready handler sets the language again.
setLanguage(startupLanguage(app.getLocale() || Intl.DateTimeFormat().resolvedOptions().locale))
