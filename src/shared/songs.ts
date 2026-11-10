import type { Background, Service, Slide, Song } from './types'
import { t } from './i18n'
import { isChordLine } from './song-import'

/**
 * Song text format:
 *   [Verse 1]
 *   First line
 *   Second line
 *
 *   Next slide of the same section
 *
 *   [Chorus]
 *   ...
 * A blank line starts a new slide; text before any [Label] gets the label "Slide".
 * Lines of chord names only (G  Em  C/G) may stand above the lyrics: `text` leaves them out, `chords` keeps them.
 */
export function parseSong(song: Song): Slide[] {
  const slides: Slide[] = []
  let label = 'Slide'
  let lines: string[] = []

  const flush = () => {
    const lyrics = lines.filter((l) => !isChordLine(l))
    const text = lyrics.join('\n').trim()
    const withChords = lyrics.length < lines.length ? lines.join('\n').replace(/\s+$/, '') : undefined
    if (text) slides.push({ label, text, ...(withChords ? { chords: withChords } : {}), background: song.slideBackgrounds?.[slides.length] ?? song.background })
    lines = []
  }

  for (const raw of song.body.replace(/\r\n/g, '\n').split('\n')) {
    const header = /^\s*\[([^\]]+)\]\s*$/.exec(raw)
    if (header) {
      flush()
      label = header[1].trim()
    } else if (raw.trim() === '') {
      flush()
    } else {
      lines.push(raw)
    }
  }
  flush()
  return slides
}

/** Text reduced for searching: lower case and without accents, so "jezis" finds "Ježiš" and "Cervena" finds "červená". */
export const fold = (text: string): string => text.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()

const noZeros = (n: string): string => n.replace(/^0+(?=\d)/, '')

/** Whether what was typed in a search box finds a song: part of its title, or the start of its number (053 is found by 53 too). Empty matches everything. */
export const songMatches = (song: { title: string; number?: string }, query: string): boolean => {
  const q = fold(query.trim())
  if (!q) return true
  if (fold(song.title).includes(q)) return true
  const n = fold((song.number ?? '').trim())
  return n !== '' && (n.startsWith(q) || noZeros(n).startsWith(noZeros(q)))
}

export const SEED_SONGS: Song[] = [
  {
    id: 'amazing-grace',
    title: 'Amazing Grace',
    background: { kind: 'css', css: 'linear-gradient(135deg,#1b2a49,#0b1020)' },
    body: `[Verse 1]
Amazing grace, how sweet the sound
That saved a wretch like me

I once was lost, but now am found
Was blind, but now I see

[Verse 2]
'Twas grace that taught my heart to fear
And grace my fears relieved

How precious did that grace appear
The hour I first believed

[Chorus]
Sing it loud, sing it clear
Heaven hears us here
`,
  },
  {
    id: 'how-great',
    title: 'How Great Thou Art',
    background: { kind: 'css', css: 'linear-gradient(135deg,#3b0764,#0f172a)' },
    body: `[Verse 1]
O Lord my God, when I in awesome wonder
Consider all the worlds Thy hands have made

[Chorus]
Then sings my soul, my Saviour God, to Thee
How great Thou art, how great Thou art
`,
  },
]

export const SEED_SERVICES: Service[] = [
  {
    id: 'sunday-sample',
    name: 'Sunday service',
    items: [
      { id: 'i1', kind: 'song', songId: 'amazing-grace' },
      { id: 'i2', kind: 'song', songId: 'how-great' },
    ],
  },
]

/**
 * The slides of a reading with its backgrounds: a slide's own picture or video first, then the one for all slides.
 * (Songs do the same inside parseSong.)
 */
export function readingSlides(slides: { label: string; text: string }[], all: Background | null | undefined, perSlide: (Background | null)[] | undefined): Slide[] {
  return slides.map((s, i) => ({ ...s, ...(perSlide?.[i] ?? all ? { background: perSlide?.[i] ?? all } : {}) }))
}

/** The extra details a song can carry (the same ones Quelea has), in the order the editor lists them. */
export const SONG_DETAIL_FIELDS = [
  { key: 'number', label: t('songs.detail.number') },
  { key: 'author', label: t('songs.detail.author') },
  { key: 'copyright', label: t('songs.detail.copyright') },
  { key: 'ccli', label: t('songs.detail.ccli') },
  { key: 'year', label: t('songs.detail.year') },
  { key: 'publisher', label: t('songs.detail.publisher') },
  { key: 'key', label: t('songs.detail.key') },
  { key: 'capo', label: t('songs.detail.capo') },
  { key: 'notes', label: t('songs.detail.notes') },
] as const

/** The per-slide pictures without entries for slides that no longer exist (the text was shortened) and without trailing blanks. */
export function trimSlideBackgrounds(list: (Background | null)[] | undefined, slideCount: number): (Background | null)[] {
  const next = (list ?? []).slice(0, Math.max(0, slideCount))
  while (next.length && next[next.length - 1] === null) next.pop()
  return next
}

/** A copy of a per-slide list with slide `index` set to `bg` (null = back to the shared background). Trailing nulls are dropped. */
export function withSlideBackground(list: (Background | null)[] | undefined, index: number, bg: Background | null): (Background | null)[] {
  const next = [...(list ?? [])]
  while (next.length <= index) next.push(null)
  next[index] = bg
  while (next.length && next[next.length - 1] === null) next.pop()
  return next
}
