import { describe, expect, it } from 'vitest'
import { bibleId, buildSlides, findBook, formatReference, normalizeName, parseReference, parseZefania, sliceVerses, summarize } from '../src/shared/bible'

// Invented fixture in the Zefania layout (the format Quelea uses). It contains no real Scripture text.
const XML = `<?xml version="1.0" encoding="utf-8"?>
<XMLBIBLE xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" biblename="Test &amp; Sample" type="x-bible">
  <INFORMATION><title>ignored</title></INFORMATION>
  <BIBLEBOOK bnumber="1" bname="1. Mojžišova" bsname="1Moj">
    <CHAPTER cnumber="1">
      <VERS vnumber="1">First verse &amp; more &#233;&#x151;.</VERS>
      <VERS vnumber="2">Second <NOTE type="x-footnote">a note</NOTE>verse <STYLE css="x">styled</STYLE> <gr str="G1">word</gr>.</VERS>
      <VERS vnumber="3"></VERS>
      <VERS vnumber="4"/>
    </CHAPTER>
    <CHAPTER cnumber="2"><VERS vnumber="1">Chapter two.</VERS></CHAPTER>
  </BIBLEBOOK>
  <BIBLEBOOK bnumber="43" bname="Ján" bsname="Jn">
    <CHAPTER cnumber="3">
      <VERS vnumber="16">Sixteen.</VERS><VERS vnumber="17">Seventeen.</VERS><VERS vnumber="18">Eighteen.</VERS>
    </CHAPTER>
  </BIBLEBOOK>
  <BIBLEBOOK bnumber="46">
    <CHAPTER cnumber="13"><VERS vnumber="4">Love is patient.</VERS></CHAPTER>
  </BIBLEBOOK>
  <BIBLEBOOK bnumber="47" bname="Empty"><CHAPTER cnumber="1"></CHAPTER></BIBLEBOOK>
</XMLBIBLE>`

describe('parseZefania', () => {
  const bible = parseZefania(XML, 'fallback.xml')

  it('reads the version name and builds an id from it', () => {
    expect(bible.name).toBe('Test & Sample')
    expect(bible.id).toBe('test-sample')
  })
  it('keeps books, chapters and verses in order, dropping books with no text', () => {
    expect(bible.books.map((b) => b.number)).toEqual([1, 43, 46])
    expect(bible.books[0].chapters.map((c) => c.n)).toEqual([1, 2])
    expect(bible.books[1].chapters[0].verses.map((v) => v.n)).toEqual([16, 17, 18])
  })
  it('cleans verse text: entities decoded, notes and markup removed, spaces collapsed', () => {
    const verses = bible.books[0].chapters[0].verses
    expect(verses[0].text).toBe('First verse & more éő.')
    expect(verses[1].text).toBe('Second verse styled word.')
  })
  it('skips empty and self-closing verses', () => expect(bible.books[0].chapters[0].verses).toHaveLength(2))
  it('uses the abbreviation as the short name, and falls back to English names when a book has none', () => {
    expect(bible.books[0]).toMatchObject({ name: '1. Mojžišova', shortName: '1Moj' })
    expect(bible.books[2].name).toBe('1 Corinthians')
  })
  it('falls back to the given name when the file does not state one', () => expect(parseZefania(XML.replace(/biblename="[^"]*"/, ''), 'Roháček').name).toBe('Roháček'))
  it('accepts single-quoted and reordered attributes', () => {
    const b = parseZefania(`<XMLBIBLE biblename='X'><BIBLEBOOK bname='B' bnumber='5'><CHAPTER cnumber='2'><VERS vnumber='7'>t</VERS></CHAPTER></BIBLEBOOK></XMLBIBLE>`, 'f')
    expect(b.books[0]).toMatchObject({ number: 5, name: 'B' })
    expect(b.books[0].chapters[0]).toMatchObject({ n: 2, verses: [{ n: 7, text: 't' }] })
  })
  it('rejects a file that is not a Bible', () => {
    expect(() => parseZefania('<html><body>nope</body></html>', 'x')).toThrow(/Zefania/)
    expect(() => parseZefania('', 'x')).toThrow()
  })
  it('summarises without any text', () => {
    const s = summarize(bible)
    expect(s.books[1]).toEqual({ number: 43, name: 'Ján', shortName: 'Jn', chapters: 3 }) // its only chapter is numbered 3
    expect(JSON.stringify(s)).not.toContain('Sixteen')
  })
  it('reports the last chapter number, so a file that skips chapters still works', () => {
    const sparse = parseZefania('<XMLBIBLE biblename="S"><BIBLEBOOK bnumber="1"><CHAPTER cnumber="2"><VERS vnumber="1">a</VERS></CHAPTER><CHAPTER cnumber="5"><VERS vnumber="1">b</VERS></CHAPTER></BIBLEBOOK></XMLBIBLE>', 'S')
    expect(summarize(sparse).books[0].chapters).toBe(5)
  })
  it('makes safe ids', () => {
    expect(bibleId('Slovenský Roháček (1936)')).toBe('slovensky-rohacek-1936')
    expect(bibleId('???')).toBe('bible')
  })
})

describe('book lookup (diacritics-insensitive)', () => {
  const books = parseZefania(XML, 'x').books
  const withMore = [...books, { number: 7, name: '2. Korinťanom', shortName: '2Kor' }, { number: 8, name: '1. Korinťanom', shortName: '1Kor' }]

  it('normalises accents, case and punctuation', () => {
    expect(normalizeName('1. Korinťanom')).toBe('1korintanom')
    expect(normalizeName('Ján')).toBe('jan')
  })
  it('finds a book without typing the accents', () => {
    expect(findBook(books, 'jan')).toBe(1)
    expect(findBook(books, 'JÁN')).toBe(1)
    expect(findBook(books, 'Jn')).toBe(1)
  })
  it('tells numbered books apart', () => {
    expect(withMore[findBook(withMore, '1 Kor')].name).toBe('1. Korinťanom')
    expect(withMore[findBook(withMore, '2kor')].name).toBe('2. Korinťanom')
  })
  it('prefers an exact name over a prefix match', () => {
    const list = [{ number: 1, name: 'Jonáš', shortName: 'Jon' }, { number: 2, name: 'Jonatán', shortName: 'Jnt' }]
    expect(findBook(list, 'jonas')).toBe(0)
    expect(findBook(list, 'jon')).toBe(0)
  })
  it('finds a book by a word inside its name (long Slovak names)', () => {
    const long = [
      { number: 43, name: 'Evanjelium podľa Jána', shortName: 'Jn' },
      { number: 46, name: '1. list Korinťanom', shortName: '1Kor' },
      { number: 47, name: '2. list Korinťanom', shortName: '2Kor' },
      { number: 51, name: '1. Jánov list', shortName: '1Jn' },
    ]
    expect(long[findBook(long, 'jana')].number).toBe(43)
    expect(long[findBook(long, 'Ján')].number).toBe(43)
    expect(long[findBook(long, '1 kor')].number).toBe(46)
    expect(long[findBook(long, '2 korintanom')].number).toBe(47)
    expect(long[findBook(long, '1 jan')].number).toBe(51)
    expect(findBook(long, '3 kor')).toBe(-1) // the number has to match
  })
  it('prefers an exact or prefix match over a word inside another name', () => {
    const list = [{ number: 1, name: 'Evanjelium podľa Jána', shortName: 'Ev' }, { number: 2, name: 'Ján', shortName: 'J' }]
    expect(findBook(list, 'jan')).toBe(1)
  })
  it('returns -1 for no match or an empty query', () => {
    expect(findBook(books, 'zzz')).toBe(-1)
    expect(findBook(books, '  ')).toBe(-1)
  })
})

describe('parseReference', () => {
  const books = parseZefania(XML, 'x').books
  const jan = 1
  it('understands Slovak comma notation and colon notation', () => {
    expect(parseReference('Ján 3,16', books)).toEqual({ bookIndex: jan, chapter: 3, from: 16, to: 16 })
    expect(parseReference('Ján 3:16', books)).toEqual({ bookIndex: jan, chapter: 3, from: 16, to: 16 })
  })
  it('reads verse ranges with a hyphen or an en dash', () => {
    expect(parseReference('Jn 3,16-18', books)).toEqual({ bookIndex: jan, chapter: 3, from: 16, to: 18 })
    expect(parseReference('jan 3:16–18', books)).toEqual({ bookIndex: jan, chapter: 3, from: 16, to: 18 })
  })
  it('treats a bare chapter as the whole chapter', () => expect(parseReference('Ján 3', books)).toEqual({ bookIndex: jan, chapter: 3, from: null, to: null }))
  it('handles numbered books with a dot or a space', () => {
    expect(parseReference('1. Mojžišova 1,1-2', books)).toMatchObject({ bookIndex: 0, chapter: 1, from: 1, to: 2 })
    expect(parseReference('1Moj 2', books)).toMatchObject({ bookIndex: 0, chapter: 2 })
  })
  it('corrects a reversed range', () => expect(parseReference('Ján 3,18-16', books)).toMatchObject({ from: 18, to: 18 }))
  it('rejects what it cannot understand', () => {
    for (const bad of ['', 'Ján', 'Ján x', 'Nothing 3,16', 'Ján 0', 'Ján 3,0']) expect(parseReference(bad, books), bad).toBeNull()
  })
})

describe('formatReference and sliceVerses', () => {
  it('formats single verses, ranges and whole chapters', () => {
    expect(formatReference('Ján', 3, 16, 16)).toBe('Ján 3:16')
    expect(formatReference('Ján', 3, 16, 18)).toBe('Ján 3:16–18')
    expect(formatReference('Ján', 3, null, null)).toBe('Ján 3')
  })
  const verses = [1, 2, 3, 4, 5].map((n) => ({ n, text: `v${n}` }))
  it('slices inclusively and supports open ends', () => {
    expect(sliceVerses(verses, 2, 4).map((v) => v.n)).toEqual([2, 3, 4])
    expect(sliceVerses(verses, null, 2).map((v) => v.n)).toEqual([1, 2])
    expect(sliceVerses(verses, 4, null).map((v) => v.n)).toEqual([4, 5])
    expect(sliceVerses(verses, null, null)).toHaveLength(5)
  })
})

describe('buildSlides', () => {
  const verses = [16, 17, 18, 19].map((n) => ({ n, text: `Text ${n}.` }))
  const base = { versesPerSlide: 1 as number | 'auto', maxChars: 40, numbers: true, reference: true }

  it('makes one slide per verse, with number and reference', () => {
    const s = buildSlides([{ version: 'RK', verses }], 'Ján', 3, base)
    expect(s).toHaveLength(4)
    expect(s[0]).toEqual({ label: 'Ján 3:16', text: '16 Text 16.\n\nJán 3:16 · RK' })
  })
  it('groups a fixed number of verses per slide', () => {
    const s = buildSlides([{ version: 'RK', verses }], 'Ján', 3, { ...base, versesPerSlide: 2 })
    expect(s.map((x) => x.label)).toEqual(['Ján 3:16–17', 'Ján 3:18–19'])
    expect(s[0].text).toContain('16 Text 16. 17 Text 17.')
  })
  it('fills slides up to the character budget in auto mode, never splitting a verse', () => {
    const long = [{ n: 1, text: 'x'.repeat(100) }, { n: 2, text: 'short' }, { n: 3, text: 'short' }]
    const s = buildSlides([{ version: 'V', verses: long }], 'B', 1, { ...base, versesPerSlide: 'auto', maxChars: 50 })
    expect(s.map((x) => x.label)).toEqual(['B 1:1', 'B 1:2–3'])
  })
  it('can leave out numbers and the reference line', () => {
    const [s] = buildSlides([{ version: 'RK', verses }], 'Ján', 3, { ...base, numbers: false, reference: false })
    expect(s.text).toBe('Text 16.')
  })
  it('puts a second version under the first, aligned by verse number', () => {
    const b = [16, 17, 18, 19].map((n) => ({ n, text: `Druhý ${n}.` }))
    const [s] = buildSlides([{ version: 'RK', verses }, { version: 'EP', verses: b }], 'Ján', 3, base)
    expect(s.text).toBe('16 Text 16.\n\n16 Druhý 16.\n\nJán 3:16 · RK / EP')
  })
  it('returns nothing for an empty passage', () => expect(buildSlides([{ version: 'V', verses: [] }], 'B', 1, base)).toEqual([]))
})
