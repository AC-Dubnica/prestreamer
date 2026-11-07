import { numberOf, withoutNumber, type ImportedSong } from './song-import'
import { parseSong } from './songs'
import type { Song } from './types'

/**
 * Quelea's own song file: a song pack (.qsp) is a ZIP with one XML file per song, written like this by Quelea's SongDisplayable.getXML
 * and TextSection.getXML. A Quelea section (title + lines) is one slide here. Pictures and videos are not exported: Quelea keeps those in themes.
 */
const escapeXml = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;')
const unescapeXml = (s: string): string =>
  s.replace(/&#x([0-9a-f]+);/gi, (_, h: string) => String.fromCodePoint(parseInt(h, 16))).replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(Number(d)))
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&')

/** The XML of one song. The number goes in front of the title ("053 Hosanna"), as songbooks print it, since Quelea has no number field. */
export function queleaSongXml(song: Song): string {
  const tag = (name: string, value: string | undefined) => `<${name}>${escapeXml(value ?? '')}</${name}>`
  const sections = parseSong(song).map((sl) => {
    const title = sl.label === 'Slide' ? '' : sl.label
    return `<section title="${escapeXml(title)}" capitalise="true"><lyrics>${sl.text.split('\n').map((l) => `${escapeXml(l)}\n`).join('')}</lyrics></section>`
  })
  return `<song><updateInDB>true</updateInDB>${tag('title', song.number ? `${song.number} ${song.title}` : song.title)}${tag('author', song.author)}${tag('ccli', song.ccli)}${tag('copyright', song.copyright)}${tag('year', song.year)}${tag('publisher', song.publisher)}${tag('key', song.key)}${tag('capo', song.capo)}${tag('notes', song.notes)}<sequence></sequence><lyrics>${sections.join('')}</lyrics><translation></translation><translationoptions></translationoptions></song>`
}

const field = (xml: string, name: string): string => {
  const m = new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(xml)
  return m ? unescapeXml(m[1]).trim() : ''
}

/** A song from the XML of one Quelea song file; null when the text is not a Quelea song. */
export function songFromQueleaXml(xml: string): ImportedSong | null {
  const song = /<song\b[^>]*>([\s\S]*)<\/song>/.exec(xml)?.[1]
  if (song === undefined) return null
  const rawTitle = field(song.replace(/<lyrics>[\s\S]*<\/lyrics>/, ''), 'title')
  const blocks: string[] = []
  let last: string | null = null
  for (const m of song.matchAll(/<section\b([^>]*?)(?:\/>|>([\s\S]*?)<\/section>)/g)) {
    const title = unescapeXml(/\btitle="([^"]*)"/.exec(m[1])?.[1] ?? '').trim()
    const lines = unescapeXml(/<lyrics>([\s\S]*?)<\/lyrics>/.exec(m[2] ?? '')?.[1] ?? '').split('\n').map((l) => l.trimEnd()).filter(Boolean)
    if (!lines.length) continue
    // Neighbouring sections with the same title are slides of one section here.
    if (title !== last && title) blocks.push(`[${title}]\n${lines.join('\n')}`)
    else if (!blocks.length || title === '') blocks.push(lines.join('\n'))
    else blocks[blocks.length - 1] += `\n\n${lines.join('\n')}`
    last = title
  }
  const body = blocks.join('\n\n')
  if (!rawTitle && !body) return null
  const meta = song.replace(/<lyrics>[\s\S]*<\/lyrics>/, '')
  const out: ImportedSong = { title: withoutNumber(rawTitle) || rawTitle, body }
  const number = numberOf(rawTitle)
  if (number) out.number = number
  for (const k of ['author', 'copyright', 'ccli', 'year', 'publisher', 'key', 'capo', 'notes'] as const) {
    const v = field(meta, k)
    if (v) out[k] = v
  }
  return out
}
