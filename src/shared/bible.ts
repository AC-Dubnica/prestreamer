/**
 * Bible model and the pure logic around it: parsing Zefania XML (the format Quelea uses), finding books by name
 * (diacritics-insensitive, so "jan" finds "Ján"), parsing references such as "Ján 3,16-18", and cutting a passage into slides.
 * No Bible text is part of the app: versions are imported from files the user already has.
 */

export interface BibleVerse { n: number; text: string }
export interface BibleChapter { n: number; verses: BibleVerse[] }
export interface BibleBook { number: number; name: string; shortName: string; chapters: BibleChapter[] }
export interface Bible { id: string; name: string; books: BibleBook[] }

/** Outcome of importing one file, so a bad file does not stop the others. */
export interface BibleImportResult { file: string; name: string; status: 'imported' | 'replaced' | 'failed'; error?: string }

/** What the interface needs to list a version and its books without loading any text. `chapters` is the last chapter number. */
export interface BibleSummary {
  id: string
  name: string
  books: { number: number; name: string; shortName: string; chapters: number }[]
}

export const summarize = (b: Bible): BibleSummary => ({
  id: b.id,
  name: b.name,
  // The highest chapter NUMBER, not the count: a partial file may not start at chapter 1 or may skip chapters.
  books: b.books.map((k) => ({ number: k.number, name: k.name, shortName: k.shortName, chapters: Math.max(...k.chapters.map((c) => c.n)) })),
})

const ENGLISH_BOOKS = [
  'Genesis', 'Exodus', 'Leviticus', 'Numbers', 'Deuteronomy', 'Joshua', 'Judges', 'Ruth', '1 Samuel', '2 Samuel', '1 Kings', '2 Kings',
  '1 Chronicles', '2 Chronicles', 'Ezra', 'Nehemiah', 'Esther', 'Job', 'Psalms', 'Proverbs', 'Ecclesiastes', 'Song of Solomon', 'Isaiah',
  'Jeremiah', 'Lamentations', 'Ezekiel', 'Daniel', 'Hosea', 'Joel', 'Amos', 'Obadiah', 'Jonah', 'Micah', 'Nahum', 'Habakkuk', 'Zephaniah',
  'Haggai', 'Zechariah', 'Malachi', 'Matthew', 'Mark', 'Luke', 'John', 'Acts', 'Romans', '1 Corinthians', '2 Corinthians', 'Galatians',
  'Ephesians', 'Philippians', 'Colossians', '1 Thessalonians', '2 Thessalonians', '1 Timothy', '2 Timothy', 'Titus', 'Philemon', 'Hebrews',
  'James', '1 Peter', '2 Peter', '1 John', '2 John', '3 John', 'Jude', 'Revelation',
]

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' }

function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === '#') {
      const code = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : m
    }
    return ENTITIES[e.toLowerCase()] ?? m
  })
}

/** Verse text: notes, style and Strong's markup removed, entities decoded, whitespace collapsed. */
const cleanVerse = (raw: string): string =>
  decodeEntities(raw.replace(/<NOTE\b[\s\S]*?<\/NOTE>/gi, '').replace(/<[^>]*>/g, ''))
    .replace(/\s+/g, ' ')
    .trim()

function attrs(source: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const m of source.matchAll(/([A-Za-z_:][\w:.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) out[m[1].toLowerCase()] = decodeEntities(m[2] ?? m[3] ?? '')
  return out
}

export const bibleId = (name: string): string =>
  name.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'bible'

/**
 * Parses a Zefania XML Bible. Tolerant of attribute order, notes and markup inside verses, and missing book names
 * (English names are used for those). Throws if the file contains no books.
 */
export function parseZefania(xml: string, fallbackName: string): Bible {
  const root = /<XMLBIBLE\b([^>]*)>/i.exec(xml)
  const name = (root && attrs(root[1]).biblename?.trim()) || fallbackName
  const books: BibleBook[] = []
  let book: BibleBook | null = null
  let chapter: BibleChapter | null = null

  const token = /<BIBLEBOOK\b([^>]*)>|<CHAPTER\b([^>]*)>|<VERS\b([^>]*?)(?:\/>|>([\s\S]*?)<\/VERS>)/gi
  for (const m of xml.matchAll(token)) {
    if (m[1] !== undefined) {
      const a = attrs(m[1])
      const number = Number(a.bnumber) || books.length + 1
      const fallback = ENGLISH_BOOKS[number - 1] ?? `Book ${number}`
      book = { number, name: a.bname?.trim() || a.bsname?.trim() || fallback, shortName: a.bsname?.trim() || a.bname?.trim() || fallback, chapters: [] }
      books.push(book)
      chapter = null
    } else if (m[2] !== undefined) {
      if (!book) continue
      chapter = { n: Number(attrs(m[2]).cnumber) || book.chapters.length + 1, verses: [] }
      book.chapters.push(chapter)
    } else if (m[4] !== undefined && chapter) {
      const n = Number(attrs(m[3]).vnumber) || chapter.verses.length + 1
      const text = cleanVerse(m[4])
      if (text) chapter.verses.push({ n, text })
    }
  }
  const usable = books.filter((b) => b.chapters.some((c) => c.verses.length))
  if (!usable.length) throw new Error('No Bible books found. Expected a Zefania XML file.')
  return { id: bibleId(name), name, books: usable }
}

/** Lower case, accents and punctuation removed: "1. Korinťanom" → "1korintanom". */
export const normalizeName = (s: string): string => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '')

type BookName = { number: number; name: string; shortName: string }

/**
 * Best match for a typed book name: exact name, exact abbreviation, name prefix, abbreviation prefix, and finally a word
 * inside the name ("jan" finds "Evanjelium podľa Jána", "1 kor" finds "1. list Korinťanom"). Returns -1 for no match.
 */
export function findBook(books: BookName[], query: string): number {
  const q = normalizeName(query)
  if (!q) return -1
  const numbered = /^(\d+)(\D.*)$/.exec(q) // "1kor": the number must match the book's own number
  const rank = (b: BookName): number => {
    const full = normalizeName(b.name)
    const short = normalizeName(b.shortName)
    if (full === q) return 0
    if (short === q) return 1
    if (full.startsWith(q)) return 2
    if (short.startsWith(q)) return 3
    const words = b.name.split(/\s+/).map(normalizeName).filter(Boolean)
    if (numbered) return words[0] === numbered[1] && words.slice(1).some((w) => w.startsWith(numbered[2])) ? 4 : 5
    return words.some((w) => w.startsWith(q)) ? 4 : 5
  }
  let best = -1
  let bestRank = 5
  books.forEach((b, i) => {
    const r = rank(b)
    if (r < bestRank) { best = i; bestRank = r }
  })
  return best
}

export interface Reference {
  bookIndex: number
  chapter: number
  /** null = from the start / to the end of the chapter. */
  from: number | null
  to: number | null
}

/**
 * Parses "Ján 3,16-18", "Jn 3:16", "1 Kor 13", "1. Korinťanom 13:4-7", "Gen 1:1–3". The chapter/verse separator may be
 * a colon or (Slovak style) a comma. Returns null when the book or chapter cannot be understood.
 */
export function parseReference(input: string, books: BookName[]): Reference | null {
  const m = /^\s*(.+?)\s+(\d+)\s*(?:[:,]\s*(\d+)\s*(?:[-–—]\s*(\d+))?)?\s*$/.exec(input)
  if (!m) return null
  const bookIndex = findBook(books, m[1])
  if (bookIndex < 0) return null
  const chapter = Number(m[2])
  const from = m[3] ? Number(m[3]) : null
  const to = m[4] ? Number(m[4]) : from
  if (chapter < 1 || (from !== null && from < 1)) return null
  return { bookIndex, chapter, from, to: from !== null && to !== null && to < from ? from : to }
}

/** "Ján 3:16", "Ján 3:16–18" (en dash), or "Ján 3" for a whole chapter. */
export function formatReference(bookName: string, chapter: number, from: number | null, to: number | null): string {
  if (from === null) return `${bookName} ${chapter}`
  return to === null || to === from ? `${bookName} ${chapter}:${from}` : `${bookName} ${chapter}:${from}–${to}`
}

/** Verses of a chapter between `from` and `to` (inclusive; null = open end), in order. */
export function sliceVerses(verses: BibleVerse[], from: number | null, to: number | null): BibleVerse[] {
  return verses.filter((v) => (from === null || v.n >= from) && (to === null || v.n <= to))
}

export interface SlideOptions {
  /** A fixed number of verses per slide, or 'auto' to fill each slide up to `maxChars`. */
  versesPerSlide: number | 'auto'
  maxChars: number
  /** Put the verse number in front of each verse. */
  numbers: boolean
  /** Add the reference (and version names) as a last line. */
  reference: boolean
}

export interface ScriptureColumn { version: string; verses: BibleVerse[] }
export interface ScriptureSlide { label: string; text: string }

/**
 * Cuts a passage into slides. The first column decides where slides break; other columns (a second version shown
 * alongside) contribute the same verse numbers to each slide.
 */
export function buildSlides(columns: ScriptureColumn[], bookName: string, chapter: number, o: SlideOptions): ScriptureSlide[] {
  const [primary] = columns
  if (!primary || !primary.verses.length) return []

  const groups: BibleVerse[][] = []
  let current: BibleVerse[] = []
  let chars = 0
  for (const v of primary.verses) {
    const full = typeof o.versesPerSlide === 'number' ? current.length >= Math.max(1, o.versesPerSlide) : current.length > 0 && chars + v.text.length > o.maxChars
    if (full) { groups.push(current); current = []; chars = 0 }
    current.push(v)
    chars += v.text.length
  }
  if (current.length) groups.push(current)

  const versions = columns.map((c) => c.version).join(' / ')
  return groups.map((group) => {
    const first = group[0].n
    const last = group[group.length - 1].n
    const ref = formatReference(bookName, chapter, first, last)
    const block = (col: ScriptureColumn): string =>
      col.verses.filter((v) => v.n >= first && v.n <= last).map((v) => (o.numbers ? `${v.n} ${v.text}` : v.text)).join(' ')
    const body = columns.map(block).filter(Boolean).join('\n\n')
    return { label: ref, text: o.reference ? `${body}\n\n${ref} · ${versions}` : body }
  })
}
