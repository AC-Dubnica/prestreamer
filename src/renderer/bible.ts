import type { PrestreamerApi } from '../preload'
import { buildSlides, formatReference, parseReference, sliceVerses, type BibleImportResult, type BibleSummary, type BibleVerse, type ScriptureSlide } from '../shared/bible'
import type { Look, Slide } from '../shared/types'
import { confirmDialog } from './dialogs'
import { iconButton } from './icons'
import { scaledPreview, type ScaledPreview } from './slideview'

function el<T extends HTMLElement = HTMLElement>(tag: string, props: Partial<T> = {}, ...kids: (Node | string)[]): T {
  const e = Object.assign(document.createElement(tag) as T, props)
  e.append(...kids)
  return e
}

export interface BibleViewDeps {
  api: PrestreamerApi
  /** The look slide thumbnails are drawn with (the selected screen's). */
  getLook(): Look
  present(slide: Slide): void
  /** The background a reading gets on air (the one chosen for all readings in Settings), so the thumbnails show the same. */
  background(): Slide['background']
  /** Adds a reading to the current service. Resolves with the service's name, or null if there is no service. */
  addReading(title: string, slides: ScriptureSlide[]): Promise<string | null>
}

const PER_SLIDE: { value: string; text: string }[] = [
  { value: 'auto', text: 'Fit to the slide' },
  { value: '1', text: '1 verse' },
  { value: '2', text: '2 verses' },
  { value: '3', text: '3 verses' },
  { value: '4', text: '4 verses' },
]

/**
 * The Bible tab: pick a version, type or choose a passage, see it (optionally next to a second version), turn it into
 * slides, show them, or add the reading to the service. Versions come from Zefania XML files (Quelea's format).
 */
export function createBibleView(root: HTMLElement, d: BibleViewDeps) {
  let bibles: BibleSummary[] = []
  let versionId = ''
  let compareId = ''
  let bookIdx = 0
  let chapter = 1
  let from: number | null = null
  let to: number | null = null
  let verses: BibleVerse[] = []
  let compareVerses: BibleVerse[] = []
  let perSlide = 'auto'
  let numbers = true
  let showReference = true
  let refText = ''
  let note: { text: string; error: boolean } | null = null
  let previews: ScaledPreview[] = []
  /** Set when a passage was just opened, so the list scrolls to the chosen verses once it is drawn. */
  let scrollToSelection = false

  const version = (): BibleSummary | undefined => bibles.find((b) => b.id === versionId)
  const book = () => version()?.books[bookIdx]

  async function loadList(): Promise<void> {
    bibles = await d.api.bibleList()
    if (!bibles.some((b) => b.id === versionId)) versionId = bibles[0]?.id ?? ''
    if (!bibles.some((b) => b.id === compareId) || compareId === versionId) compareId = ''
    bookIdx = Math.min(bookIdx, Math.max(0, (version()?.books.length ?? 1) - 1))
  }

  async function loadChapter(): Promise<void> {
    const v = version()
    const b = book()
    verses = []
    compareVerses = []
    if (!v || !b) return
    chapter = Math.min(Math.max(1, chapter), b.chapters)
    verses = (await d.api.bibleChapter(v.id, b.number, chapter)) ?? []
    if (compareId) compareVerses = (await d.api.bibleChapter(compareId, b.number, chapter)) ?? []
  }

  async function openPassage(bookIndex: number, ch: number, f: number | null, t: number | null): Promise<void> {
    bookIdx = bookIndex
    chapter = ch
    from = f
    to = t
    scrollToSelection = true
    await loadChapter()
    refText = book() ? formatReference(book()!.name, chapter, from, to) : ''
    render()
  }

  const say = (text: string, error = false) => { note = { text, error } }

  async function runImport(task: Promise<BibleImportResult[]>, nothingFound?: string): Promise<void> {
    const results = await task
    if (!results.length) { say(nothingFound ?? 'Nothing was imported.', Boolean(nothingFound)); return render() }
    const ok = results.filter((r) => r.status !== 'failed')
    const failed = results.filter((r) => r.status === 'failed')
    say([ok.length ? `Imported: ${ok.map((r) => r.name).join(', ')}.` : '', ...failed.map((r) => `${r.file}: ${r.error}`)].filter(Boolean).join(' '), failed.length > 0 && ok.length === 0)
    await loadList()
    await loadChapter()
    render()
  }

  async function importFromQuelea(): Promise<void> {
    const { folders, results } = await d.api.bibleImportQuelea()
    if (!folders.length) {
      say("Quelea's Bible folder was not found on this computer. Use \"Choose files…\" and pick the .xml Bible files from your Quelea Bible folder (usually a folder named \"bibles\" inside \".quelea\" in your user folder).", true)
      return render()
    }
    await runImport(Promise.resolve(results), 'No Bible files were found in the Quelea folder.')
  }

  const activeRange = () => ({ a: sliceVerses(verses, from, to), b: sliceVerses(compareVerses, from, to) })

  function slidesNow(): ScriptureSlide[] {
    const v = version()
    const b = book()
    if (!v || !b) return []
    const { a, b: other } = activeRange()
    const compare = bibles.find((x) => x.id === compareId)
    const columns = [{ version: v.name, verses: a }, ...(compare ? [{ version: compare.name, verses: other }] : [])]
    return buildSlides(columns, b.name, chapter, { versesPerSlide: perSlide === 'auto' ? 'auto' : Number(perSlide), maxChars: compare ? 150 : 260, numbers, reference: showReference })
  }

  function aside(): HTMLElement {
    const list = bibles.length
      ? bibles.map((b) => el('div', { className: `item ${b.id === versionId ? 'sel' : ''}`, onclick: async () => { versionId = b.id; if (compareId === b.id) compareId = ''; await loadChapter(); render() } },
          el('span', { className: 't', textContent: b.name }),
          iconButton('trash', `Remove ${b.name}`, async (e) => {
            e.stopPropagation()
            if (await confirmDialog({ title: `Remove "${b.name}"?`, message: 'It is only removed from PreStreamer. You can import it again from its file.', confirm: 'Remove', danger: true })) {
              bibles = await d.api.bibleRemove(b.id)
              await loadList()
              await loadChapter()
              render()
            }
          }, { size: 14 })))
      : [el('div', { className: 'emptystate' }, el('p', { textContent: 'No Bible versions yet. Import the Bible files you use in Quelea (Zefania XML), for example Roháček or Ekumenický preklad.' }))]
    return el('aside', {},
      el('div', { className: 'head' }, 'Versions'),
      ...list,
      el('div', { className: 'bimport' },
        el('button', { className: bibles.length ? '' : 'primary', textContent: 'Import from Quelea', title: "Find Quelea's Bible folder and import every Bible in it", onclick: () => void importFromQuelea() }),
        iconButton('book', 'Choose Bible files (Zefania XML)…', () => void runImport(d.api.bibleImportDialog()), { badge: true, label: 'Choose files…' })),
      note ? el('div', { className: `status ${note.error ? 'error' : 'running'}`, textContent: note.text }) : el('span'),
    )
  }

  function main(): HTMLElement {
    const v = version()
    const b = book()
    if (!v || !b) return el('div', { className: 'bmain' }, el('div', { className: 'row', textContent: 'Import a Bible version to start reading.' }))

    const ref = el<HTMLInputElement>('input', { type: 'text', value: refText, placeholder: 'Type a reference, e.g. Ján 3,16-18', title: 'Book, chapter and verses: Ján 3,16-18 · Jn 3:16 · 1 Kor 13' })
    ref.onkeydown = async (e) => {
      if (e.key !== 'Enter') return
      refText = ref.value
      const parsed = parseReference(ref.value, v.books)
      if (!parsed) { say(`Could not understand "${ref.value}". Try a book name, a chapter and verses, like Ján 3,16-18.`, true); return render() }
      if (parsed.chapter > v.books[parsed.bookIndex].chapters) { say(`${v.books[parsed.bookIndex].name} has only ${v.books[parsed.bookIndex].chapters} chapter${v.books[parsed.bookIndex].chapters === 1 ? '' : 's'}.`, true); return render() }
      note = null
      await openPassage(parsed.bookIndex, parsed.chapter, parsed.from, parsed.to)
    }
    const bookSel = el<HTMLSelectElement>('select')
    bookSel.append(...v.books.map((k, i) => el<HTMLOptionElement>('option', { value: String(i), textContent: k.name, selected: i === bookIdx })))
    bookSel.onchange = () => void openPassage(Number(bookSel.value), 1, null, null)
    const chapterSel = el<HTMLSelectElement>('select')
    for (let c = 1; c <= b.chapters; c++) chapterSel.append(el<HTMLOptionElement>('option', { value: String(c), textContent: `Chapter ${c}`, selected: c === chapter }))
    chapterSel.onchange = () => void openPassage(bookIdx, Number(chapterSel.value), null, null)
    const step = (delta: number) => {
      const next = chapter + delta
      if (next >= 1 && next <= b.chapters) void openPassage(bookIdx, next, null, null)
      else if (delta > 0 && bookIdx + 1 < v.books.length) void openPassage(bookIdx + 1, 1, null, null)
      else if (delta < 0 && bookIdx > 0) void openPassage(bookIdx - 1, v.books[bookIdx - 1].chapters, null, null)
    }
    const compareSel = el<HTMLSelectElement>('select', { title: 'Show a second version next to this one' })
    compareSel.append(el<HTMLOptionElement>('option', { value: '', textContent: 'Compare with: none' }), ...bibles.filter((x) => x.id !== versionId).map((x) => el<HTMLOptionElement>('option', { value: x.id, textContent: x.name, selected: x.id === compareId })))
    compareSel.onchange = async () => { compareId = compareSel.value; scrollToSelection = true; await loadChapter(); render() } // extra lines shift the verses: keep the selection in view

    const inRange = (n: number) => (from === null || n >= from) && (to === null || n <= to)
    const compareByNumber = new Map(compareVerses.map((x) => [x.n, x.text]))
    const verseRows = verses.map((vs) =>
      el('div', {
        className: `bverse ${inRange(vs.n) ? 'sel' : ''}`,
        title: 'Click to choose a verse, Shift+click to extend the selection',
        onclick: (e: MouseEvent) => { if (e.shiftKey && from !== null) to = Math.max(vs.n, from); else { from = vs.n; to = vs.n } refText = formatReference(b.name, chapter, from, to); render() },
      }, el('span', { className: 'bnum', textContent: String(vs.n) }), el('span', {}, el('span', { textContent: vs.text }), compareByNumber.has(vs.n) ? el('span', { className: 'bcmp', textContent: compareByNumber.get(vs.n)! }) : el('span'))))

    const perSel = el<HTMLSelectElement>('select')
    perSel.append(...PER_SLIDE.map((o) => el<HTMLOptionElement>('option', { value: o.value, textContent: o.text, selected: o.value === perSlide })))
    perSel.onchange = () => { perSlide = perSel.value; render() }
    const numBox = el<HTMLInputElement>('input', { type: 'checkbox', checked: numbers })
    numBox.onchange = () => { numbers = numBox.checked; render() }
    const refBox = el<HTMLInputElement>('input', { type: 'checkbox', checked: showReference })
    refBox.onchange = () => { showReference = refBox.checked; render() }

    const slides = slidesNow()
    previews.forEach((p) => p.dispose())
    previews = []
    const look = d.getLook()
    const grid = el('div', { className: 'grid' }, ...slides.map((sl) => {
      const pv = scaledPreview()
      previews.push(pv)
      pv.update(look, { label: sl.label, text: sl.text, background: d.background() ?? null }, 1920, 1080, false)
      const tag = el('div', { className: 'tag', textContent: sl.label })
      tag.style.background = '#0f766e'
      return el('div', { className: 'card', title: 'Click to show on the screens', onclick: () => d.present({ label: sl.label, text: sl.text }) }, tag, pv.box)
    }))

    const first = sliceVerses(verses, from, to)
    const title = first.length ? `${formatReference(b.name, chapter, first[0].n, first[first.length - 1].n)} · ${[v.name, bibles.find((x) => x.id === compareId)?.name].filter(Boolean).join(' / ')}` : ''
    const addBtn = iconButton('book', 'Add this reading to the current service', async () => {
      const service = await d.addReading(title, slides)
      say(service ? `Added "${title}" to ${service}.` : 'Create a service in the Present tab first.', !service)
      render()
    }, { badge: true, label: 'Add to service', className: 'primary', disabled: !slides.length })

    return el('div', { className: 'bmain' },
      el('div', { className: 'bbar' }, ref, bookSel, chapterSel, compareSel),
      el('div', { className: 'bbar' },
        el('button', { textContent: '‹ Previous chapter', onclick: () => step(-1) }),
        el('button', { textContent: 'Next chapter ›', onclick: () => step(1) }),
        el('button', { textContent: 'Whole chapter', onclick: () => { from = null; to = null; refText = formatReference(b.name, chapter, null, null); render() } }),
        el('span', { className: 'dim', textContent: from === null ? 'Whole chapter selected' : `Verses ${from}${to !== from ? `–${to}` : ''} selected` })),
      el('div', { className: 'bverses' }, ...(verseRows.length ? verseRows : [el('div', { className: 'row', textContent: 'This chapter has no text in this version.' })])),
      el('div', { className: 'bopts' },
        el('label', {}, 'Slides: ', perSel), el('label', {}, numBox, ' verse numbers'), el('label', {}, refBox, ' reference on slide'), el('span', { className: 'grow' }), addBtn),
      el('div', { className: 'head' }, `Slides (${slides.length})`),
      grid,
    )
  }

  function render(): void {
    // A redraw rebuilds the lists: keep where the user had scrolled to, unless a passage was just opened.
    const verseScroll = root.querySelector<HTMLElement>('.bverses')?.scrollTop ?? 0
    const pageScroll = root.querySelector<HTMLElement>('.bmain')?.scrollTop ?? 0
    root.replaceChildren(aside(), main())
    const box = root.querySelector<HTMLElement>('.bverses')
    const page = root.querySelector<HTMLElement>('.bmain')
    if (scrollToSelection) {
      scrollToSelection = false
      const first = from !== null ? box?.querySelector<HTMLElement>('.bverse.sel') : null
      if (box) box.scrollTop = first ? Math.max(0, first.offsetTop - 8) : 0 // .bverses is positioned, so offsetTop is relative to it
    } else if (box) {
      box.scrollTop = verseScroll
    }
    if (page) page.scrollTop = pageScroll
  }

  return {
    async show(): Promise<void> {
      await loadList()
      await loadChapter()
      render()
    },
    /** Test and scripting hook: lets the UI be driven without a file dialog. */
    async reload(): Promise<void> {
      await loadList()
      await loadChapter()
      render()
    },
  }
}
