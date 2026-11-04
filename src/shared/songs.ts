import type { Service, Slide, Song } from './types'

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
 */
export function parseSong(song: Song): Slide[] {
  const slides: Slide[] = []
  let label = 'Slide'
  let lines: string[] = []

  const flush = () => {
    const text = lines.join('\n').trim()
    if (text) slides.push({ label, text, background: song.background })
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
