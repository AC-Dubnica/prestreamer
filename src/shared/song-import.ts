import type { Song } from './types'

/** One line of text read from a PDF page: `y` is its baseline (PDF points, larger = higher on the page). */
export interface PdfLine {
  y: number
  height: number
  text: string
}

export interface ImportedSong {
  title: string
  body: string
  key?: string
  number?: string
  author?: string
  copyright?: string
  ccli?: string
  year?: string
  publisher?: string
  capo?: string
  notes?: string
}

/** The default look of a new song (the first of the editor's backgrounds). */
export const IMPORT_BACKGROUND: Song['background'] = { kind: 'css', css: 'linear-gradient(135deg,#1b2a49,#0b1020)' }

const CHORD = /^[A-H](?:#|b)?(?:m|mi|min|maj|M|dim|aug|sus|add|\+|-)?\d*(?:\(?[#b]?\d+\)?)?(?:\/[A-H](?:#|b)?)?$/
const NEUTRAL = /^(?:\||\/|-|–|x\d+|\d+x|\(|\))$/i

/** A line of chord names only (G, Em, C/G, A7, Hm ...): the singer does not read it. */
export function isChordLine(text: string): boolean {
  const tokens = text.split(/\s+/).filter(Boolean)
  return tokens.length > 0 && tokens.some((t) => CHORD.test(t)) && tokens.every((t) => CHORD.test(t) || NEUTRAL.test(t))
}

const LABELS: Record<string, string> = { v: 'Verse', verse: 'Verse', sloha: 'Verse', c: 'Chorus', ch: 'Chorus', chorus: 'Chorus', refren: 'Chorus', 'refrén': 'Chorus', b: 'Bridge', bridge: 'Bridge', mostik: 'Bridge', p: 'Pre-chorus', pre: 'Pre-chorus', prechorus: 'Pre-chorus', i: 'Intro', intro: 'Intro', o: 'Outro', outro: 'Outro', e: 'Ending', end: 'Ending', ending: 'Ending', t: 'Tag', tag: 'Tag' }

/** "v2" → "Verse 2", "Chorus" → "Chorus"; null when the text is not a section marker. */
export function sectionLabel(text: string, height: number, bodyHeight: number): string | null {
  const t = text.trim()
  const m = /^([A-Za-zÀ-ž-]+)\s*\.?\s*(\d*)\s*:?$/.exec(t)
  if (m) {
    const word = LABELS[m[1].toLowerCase()]
    if (word) return m[2] ? `${word} ${m[2]}` : word
  }
  // Anything short set in a larger size than the lyrics is a heading ("Refrén 2", "Zakončenie" ...).
  if (height > bodyHeight + 0.5 && t.length <= 30) return t.replace(/:$/, '')
  return null
}

/** Joins the text items of a page into lines, top to bottom. */
export function groupLines(items: { str: string; x: number; y: number; height: number }[]): PdfLine[] {
  const lines: (PdfLine & { parts: { x: number; s: string }[] })[] = []
  for (const it of items) {
    if (!it.str) continue
    let line = lines.find((l) => Math.abs(l.y - it.y) < 2)
    if (!line) { line = { y: it.y, height: 0, text: '', parts: [] }; lines.push(line) }
    line.parts.push({ x: it.x, s: it.str })
    line.height = Math.max(line.height, it.height)
  }
  return lines
    .sort((a, b) => b.y - a.y)
    .map((l) => ({ y: l.y, height: l.height, text: l.parts.sort((a, b) => a.x - b.x).map((p) => p.s).join('').replace(/\s+/g, ' ').trim() }))
    .filter((l) => l.text !== '')
}

const median = (xs: number[]): number => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : 0 }

/** The "053" songbook number some titles start with ("053 Hosanna", "306_ Pastier"), if any. */
export const numberOf = (title: string): string | undefined => /^\s*(\d+)\s*[._)-]*\s+\S/.exec(title)?.[1]

/** Strips the "053 " songbook number some titles start with. */
export const withoutNumber = (title: string): string => title.replace(/^\s*\d+\s*[._)-]*\s+/, '').trim()

/**
 * Turns the lines of a chord-sheet PDF (the kind Quelea exports) into a song: the biggest line is the title, "Key: X" is the key,
 * chord lines are dropped, markers such as "v1" or "Chorus" become [Verse 1] / [Chorus], and an empty line between lyrics starts a new slide.
 */
export function songFromPdfLines(lines: PdfLine[], fallbackTitle: string): ImportedSong {
  const bodyHeight = median(lines.map((l) => l.height).filter((h) => h > 0)) || 12
  const titleLine = lines.find((l) => l.height >= bodyHeight * 1.6 && !/^key\s*:/i.test(l.text))
  const title = withoutNumber(titleLine?.text ?? fallbackTitle) || withoutNumber(fallbackTitle)
  let key: string | undefined
  const rest = lines.filter((l) => {
    const k = /^key\s*:\s*(.+)$/i.exec(l.text)
    if (k) { key = k[1].trim(); return false }
    return l !== titleLine
  })
  const spacings = rest.slice(1).map((l, i) => rest[i].y - l.y).filter((d) => d > 0)
  const blankFrom = median(spacings) * 1.5

  const out: string[] = []
  let started = false
  const blank = () => { if (out.length && out[out.length - 1] !== '') out.push('') }
  rest.forEach((l, i) => {
    const gap = i > 0 ? rest[i - 1].y - l.y : 0
    if (isChordLine(l.text)) { if (gap > blankFrom && started) blank(); return }
    const label = sectionLabel(l.text, l.height, bodyHeight)
    if (label) {
      blank()
      out.push(`[${label}]`)
      started = true
      return
    }
    // The title repeated as a heading line right before the first marker ("Abba Otče" above "v1") adds nothing; as a lyric it stays.
    if (!started && out.length === 0 && normalizeTitle(l.text) === normalizeTitle(title)) {
      const next = rest.slice(i + 1).find((n) => !isChordLine(n.text))
      if (next && sectionLabel(next.text, next.height, bodyHeight)) { started = true; return }
    }
    if (gap > blankFrom && started) blank()
    out.push(l.text)
    started = true
  })
  while (out.length && out[out.length - 1] === '') out.pop()
  // A label with nothing under it carries no slide.
  const body = out.join('\n').replace(/\[[^\]]+\]\n(?=\n|\[|$)/g, '').replace(/\n{3,}/g, '\n\n').trim()
  const number = numberOf(titleLine?.text ?? fallbackTitle) ?? numberOf(fallbackTitle)
  return { title, body, ...(key ? { key } : {}), ...(number ? { number } : {}) }
}

/** A title reduced to what identifies a song: no case, accents, songbook number or punctuation. */
export function normalizeTitle(title: string): string {
  return withoutNumber(title).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '')
}

/** Splits imported songs into the new ones and the titles skipped because the library (or an earlier file) already has them. */
export function planSongImport(imported: ImportedSong[], existingTitles: string[]): { fresh: ImportedSong[]; skipped: string[] } {
  const seen = new Set(existingTitles.map(normalizeTitle))
  const fresh: ImportedSong[] = []
  const skipped: string[] = []
  for (const s of imported) {
    const n = normalizeTitle(s.title)
    if (!n || seen.has(n)) { skipped.push(s.title); continue }
    seen.add(n)
    fresh.push(s)
  }
  return { fresh, skipped }
}
