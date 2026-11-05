import type { MediaBackground, Slide } from './types'

/** Look settings that belong to the whole app rather than to one screen or song. */
export interface Appearance {
  /** A picture or looping video behind every song that has none of its own. */
  songBackground: MediaBackground | null
  /** The same for Bible readings. */
  scriptureBackground: MediaBackground | null
  /** The picture the Logo button puts on every screen (a file of the media library). */
  logo: string | null
}

export const defaultAppearance: Appearance = { songBackground: null, scriptureBackground: null, logo: null }

/** Library files are plain names (no folders), so nothing in a saved file can point outside the media folder. */
const PLAIN_NAME = /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/
const plain = (v: unknown): v is string => typeof v === 'string' && PLAIN_NAME.test(v) && !v.includes('..')

function mediaOf(raw: unknown): MediaBackground | null {
  const r = raw as { kind?: unknown; file?: unknown } | null
  return r && (r.kind === 'image' || r.kind === 'video') && plain(r.file) ? { kind: r.kind, file: r.file } : null
}

export function sanitizeAppearance(raw: unknown): Appearance {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  return { songBackground: mediaOf(r.songBackground), scriptureBackground: mediaOf(r.scriptureBackground), logo: plain(r.logo) ? r.logo : null }
}

/** The settings without a file that was deleted from the library. Returns the same object if nothing used it. */
export function forgetAppearanceMedia(a: Appearance, file: string): Appearance {
  if (a.songBackground?.file !== file && a.scriptureBackground?.file !== file && a.logo !== file) return a
  return {
    songBackground: a.songBackground?.file === file ? null : a.songBackground,
    scriptureBackground: a.scriptureBackground?.file === file ? null : a.scriptureBackground,
    logo: a.logo === file ? null : a.logo,
  }
}

/**
 * Gives slides that have no picture or video of their own the app-wide one. A slide's own picture or video wins (set on
 * the slide, or for the whole song), then this, then the screen's own background, then the colour.
 */
export function applyDefaultBackground(slides: Slide[], bg: MediaBackground | null): Slide[] {
  if (!bg) return slides
  return slides.map((s) => (s.video || s.picture || (s.background && s.background.kind !== 'css') ? s : { ...s, background: bg }))
}

/** The slide that puts the logo on every screen, or null while no logo is chosen. It is a picture slide, so camera-only hides it. */
export function logoSlide(a: Appearance): Slide | null {
  return a.logo ? { label: 'Logo', text: '', picture: { file: a.logo } } : null
}

/** True while the logo is what is on air. */
export function isLogoSlide(slide: Slide | null, a: Appearance): boolean {
  return !!slide && !!a.logo && slide.label === 'Logo' && slide.picture?.file === a.logo
}
