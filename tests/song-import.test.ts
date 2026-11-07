import { deflateRawSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { groupLines, isChordLine, normalizeTitle, planSongImport, sectionLabel, songFromPdfLines, type PdfLine } from '../src/shared/song-import'
import { readZip, writeZip } from '../src/main/zip'
import { queleaSongXml, songFromQueleaXml } from '../src/shared/quelea'
import { numberOf } from '../src/shared/song-import'
import type { Song } from '../src/shared/types'

const L = (y: number, text: string, height = 12): PdfLine => ({ y, height, text })

describe('isChordLine', () => {
  it('recognises chord names, including Slovak H and slash chords', () => {
    for (const t of ['G', 'Em', 'C D G', 'Hm A7', 'D/F#', 'Am Dm G C', 'G | D', 'Csus4 Gadd9']) expect(isChordLine(t), t).toBe(true)
  })
  it('does not take lyrics for chords', () => {
    for (const t of ['A moje kroky', 'Hosanna', 'Dôverujem Ti.', 'Em amen', '']) expect(isChordLine(t), t).toBe(false)
  })
})

describe('sectionLabel', () => {
  it('expands short markers and keeps numbers', () => {
    expect(sectionLabel('v2', 12, 12)).toBe('Verse 2')
    expect(sectionLabel('Chorus', 14, 12)).toBe('Chorus')
    expect(sectionLabel('c', 12, 12)).toBe('Chorus')
    expect(sectionLabel('b1', 12, 12)).toBe('Bridge 1')
  })
  it('takes a short heading in a larger size as a label, but not a lyric line', () => {
    expect(sectionLabel('Zakončenie', 14, 12)).toBe('Zakončenie')
    expect(sectionLabel('Ty si môj Pastier,', 12, 12)).toBeNull()
  })
})

describe('songFromPdfLines', () => {
  it('reads title and key, drops chords, and splits slides at the empty lines', () => {
    const song = songFromPdfLines([
      L(790, '067 Ty si môj Pastier', 22), L(799, 'Key: D', 14),
      L(754, 'D'), L(741, 'Ty si môj Pastier,'), L(725, 'Hm'), L(712, 'v Tebe všetko mám,'),
      L(678, 'Em A7'), L(665, 'A moje kroky vedieš'), L(649, 'D'), L(636, 'a ma chrániš.'),
      L(600, 'Chorus', 14),
      L(578, 'D A7'), L(565, 'A jak som sa bránil'),
    ], 'x')
    expect(song).toEqual({
      title: 'Ty si môj Pastier',
      number: '067',
      key: 'D',
      body: 'Ty si môj Pastier,\nv Tebe všetko mám,\n\nA moje kroky vedieš\na ma chrániš.\n\n[Chorus]\nA jak som sa bránil',
    })
  })

  it('turns v1/v2 markers into sections and drops the title repeated as the first line', () => {
    const song = songFromPdfLines([
      L(790, 'Stojím tu', 22), L(799, 'Key: A', 14),
      L(754, 'Stojím tu'), L(738, 'v1'), L(722, 'Stojím tu pred Tebou,'), L(706, 'na svätom mieste stojím,'), L(690, 'v2'), L(674, 'A kladiem seba na oltár,'),
    ], 'x')
    expect(song.body).toBe('[Verse 1]\nStojím tu pred Tebou,\nna svätom mieste stojím,\n\n[Verse 2]\nA kladiem seba na oltár,')
  })

  it('falls back to the file name when the page has no title, and gives an empty body for a page without lyrics', () => {
    expect(songFromPdfLines([L(700, 'Words here')], '012 Some song')).toMatchObject({ title: 'Some song', number: '012' })
    expect(songFromPdfLines([], 'x').body).toBe('')
  })
})

describe('groupLines', () => {
  it('joins items on one baseline left to right and orders lines top down', () => {
    const lines = groupLines([
      { str: 'world', x: 60, y: 700, height: 12 }, { str: 'Hello ', x: 10, y: 700, height: 12 },
      { str: 'Top', x: 10, y: 750, height: 12 }, { str: '', x: 0, y: 720, height: 0 },
    ])
    expect(lines.map((l) => l.text)).toEqual(['Top', 'Hello world'])
  })
})

describe('planSongImport', () => {
  it('skips songs already in the library, ignoring case, accents, numbers and punctuation, and repeats within the import', () => {
    const song = (title: string) => ({ title, body: 'x' })
    const { fresh, skipped } = planSongImport(
      [song('053 Ty mojou silou si'), song('Hosanna!'), song('Brand new'), song('brand NEW'), song('Môj Pán')],
      ['Ty mojou silou si', 'hosanna', 'Moj pan'],
    )
    expect(fresh.map((s) => s.title)).toEqual(['Brand new'])
    expect(skipped).toEqual(['053 Ty mojou silou si', 'Hosanna!', 'brand NEW', 'Môj Pán'])
  })
  it('normalizes titles', () => {
    expect(normalizeTitle('001 Chcem oslavovať!')).toBe('chcemoslavovat')
    expect(normalizeTitle('306_ Dobrý Pastier')).toBe('dobrypastier')
  })
})

/** A minimal zip (one stored, one deflated entry) built by hand. */
function makeZip(files: [string, Buffer, boolean][]): Buffer {
  const locals: Buffer[] = []
  const central: Buffer[] = []
  let offset = 0
  for (const [name, data, deflate] of files) {
    const body = deflate ? deflateRawSync(data) : data
    const nameBuf = Buffer.from(name, 'utf8')
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(deflate ? 8 : 0, 8); local.writeUInt32LE(body.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(nameBuf.length, 26)
    const cd = Buffer.alloc(46)
    cd.writeUInt32LE(0x02014b50, 0); cd.writeUInt16LE(0x800, 8); cd.writeUInt16LE(deflate ? 8 : 0, 10); cd.writeUInt32LE(body.length, 20); cd.writeUInt32LE(data.length, 24); cd.writeUInt16LE(nameBuf.length, 28); cd.writeUInt32LE(offset, 42)
    locals.push(local, nameBuf, body)
    central.push(cd, nameBuf)
    offset += 30 + nameBuf.length + body.length
  }
  const cdBuf = Buffer.concat(central)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10); end.writeUInt32LE(cdBuf.length, 12); end.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, cdBuf, end])
}

describe('readZip', () => {
  it('reads stored and deflated entries and keeps accented names', () => {
    const zip = readZip(makeZip([['001 Hosanna.pdf', Buffer.from('stored'), false], ['Ježiš.pdf', Buffer.from('deflated '.repeat(50)), true]]))
    expect(zip.map((e) => e.name)).toEqual(['001 Hosanna.pdf', 'Ježiš.pdf'])
    expect(zip[0].read().toString()).toBe('stored')
    expect(zip[1].read().toString()).toBe('deflated '.repeat(50))
  })
  it('rejects a file that is not a zip', () => {
    expect(() => readZip(Buffer.from('definitely not a zip file at all'))).toThrow(/not a ZIP/)
  })
})

describe('numberOf', () => {
  it('reads the songbook number in front of a title', () => {
    expect(numberOf('053 Ty mojou silou si')).toBe('053')
    expect(numberOf('306_ Dobrý Pastier')).toBe('306')
    expect(numberOf('Hosanna')).toBeUndefined()
    expect(numberOf('1000 miles')).toBe('1000')
    expect(numberOf('123')).toBeUndefined()
  })
  it('is kept by the PDF importer', () => {
    expect(songFromPdfLines([L(790, '053 Ty mojou silou si', 22), L(740, 'Words'), L(724, 'More words'), L(708, 'Last words')], 'x')).toMatchObject({ title: 'Ty mojou silou si', number: '053' })
  })
})

const sample: Song = { id: 'a', title: 'Ježiš & <friends>', number: '053', author: 'A. Author', key: 'G', background: null, body: '[Verse 1]\nLine "one"\nLine two\n\nLine three\n\n[Chorus]\nSing it\n\nUnlabelled' }

describe('Quelea song XML', () => {
  it('writes the structure of Quelea song files: one section per slide', () => {
    const xml = queleaSongXml(sample)
    expect(xml.startsWith('<song><updateInDB>true</updateInDB><title>053 Ježiš &amp; &lt;friends&gt;</title><author>A. Author</author>')).toBe(true)
    expect(xml).toContain('<section title="Verse 1" capitalise="true"><lyrics>Line &quot;one&quot;\nLine two\n</lyrics></section><section title="Verse 1" capitalise="true"><lyrics>Line three\n</lyrics></section><section title="Chorus"')
    expect(xml).toContain('<key>G</key>')
    expect(xml.endsWith('<translation></translation><translationoptions></translationoptions></song>')).toBe(true)
  })
  it('reads back what it wrote, including the number, details and special characters', () => {
    const back = songFromQueleaXml(queleaSongXml(sample))!
    expect(back).toMatchObject({ title: 'Ježiš & <friends>', number: '053', author: 'A. Author', key: 'G' })
    expect(back.body).toBe('[Verse 1]\nLine "one"\nLine two\n\nLine three\n\n[Chorus]\nSing it\n\nUnlabelled')
  })
  it('reads a song file written by Quelea (translation blocks, theme, numeric entities)', () => {
    const xml = '<?xml version="1.0"?><song><updateInDB>true</updateInDB><title>Amazing &#x47;race</title><author></author><ccli>123</ccli><lyrics><section title="Verse 1" capitalise="true"><theme>x</theme><lyrics>Amazing grace\nhow sweet\n</lyrics></section></lyrics><translation><name>sk</name><tlyrics>Úžasná</tlyrics></translation><translationoptions><lang>sk</lang><lyrics>Úžasná</lyrics></translationoptions></song>'
    expect(songFromQueleaXml(xml)).toEqual({ title: 'Amazing Grace', ccli: '123', body: '[Verse 1]\nAmazing grace\nhow sweet' })
  })
  it('refuses text that is not a song', () => {
    expect(songFromQueleaXml('hello')).toBeNull()
  })
})

describe('writeZip', () => {
  it('makes a zip readZip (and so any unzip tool) can read, with accented names', () => {
    const zip = readZip(writeZip([{ name: 'Ježiš.xml', data: Buffer.from('<song>a</song>') }, { name: 'b.xml', data: Buffer.from('x'.repeat(5000)) }]))
    expect(zip.map((e) => e.name)).toEqual(['Ježiš.xml', 'b.xml'])
    expect(zip[0].read().toString()).toBe('<song>a</song>')
    expect(zip[1].read().length).toBe(5000)
  })
})
