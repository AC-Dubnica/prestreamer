import type { PrestreamerApi } from '../preload'
import { mediaUrl, type Background, type MediaEntry } from '../shared/types'
import { showModal } from './dialogs'
import { iconButton } from './icons'

function el<T extends HTMLElement = HTMLElement>(tag: string, props: Partial<T> = {}, ...kids: (Node | string)[]): T {
  const e = Object.assign(document.createElement(tag) as T, props)
  e.append(...kids)
  return e
}

/** A small still of a library picture or video (a video shows its first frame, with a film mark). */
export function mediaThumb(entry: { kind: 'image' | 'video'; file: string }): HTMLElement {
  const box = el('div', { className: 'mthumb' })
  if (entry.kind === 'image') {
    box.append(el<HTMLImageElement>('img', { src: mediaUrl(entry.file), loading: 'lazy' }))
  } else {
    box.append(el<HTMLVideoElement>('video', { src: `${mediaUrl(entry.file)}#t=0.5`, muted: true, preload: 'metadata' }), el('span', { className: 'mfilm', textContent: '▶' }))
  }
  return box
}

/**
 * The background picker: everything imported so far as thumbnails (nothing is imported twice), plus buttons to bring in a
 * new picture or video. Resolves with the chosen background, `null` for "no picture or video", or `undefined` if cancelled.
 */
export interface PickOptions {
  /** Heading of the dialog, and the label of the "none" button (for a slide it means "use the song's background"). */
  title?: string
  noneLabel?: string
  noneHint?: string
  /** Told when a file is deleted from the library, so whatever used it can let go of it. */
  onDeleted?: (file: string) => void
}

export function pickBackground(api: PrestreamerApi, current: Background | null, opts: PickOptions = {}): Promise<Background | null | undefined> {
  return new Promise((resolve) => {
    let answered = false
    const answer = (value: Background | null | undefined, close: () => void) => { answered = true; resolve(value); close() }
    showModal(
      (close) => {
        const grid = el('div', { className: 'mgrid' })
        const note = el('div', { className: 'dim' })
        const fill = (entries: MediaEntry[]) => {
          grid.replaceChildren(...entries.map((m) => {
            const picked = current && current.kind !== 'css' && current.file === m.file
            const wrap = el('div', { className: 'mwrap' })
            const showCard = () => {
              const trash = iconButton('trash', `Delete "${m.name}" from the library`, (e) => { e.stopPropagation(); askDelete() }, { size: 13, className: 'mtrash' })
              wrap.replaceChildren(
                el('button', { className: `mcard ${picked ? 'picked' : ''}`, title: m.name, onclick: () => answer({ kind: m.kind, file: m.file }, close) }, mediaThumb(m), el('span', { className: 'mname', textContent: m.name })),
                trash,
              )
            }
            // Deleting asks inside the card (a second dialog would replace this one).
            const askDelete = () => wrap.replaceChildren(el('div', { className: 'mask' },
              el('div', { textContent: `Delete "${m.name}"?` }),
              el('div', { className: 'dim', textContent: 'Songs and screens that use it go back to plain colour.' }),
              el('div', { className: 'btns' },
                el('button', { className: 'danger', textContent: 'Delete', onclick: async () => { if (await api.mediaRemove(m.file)) opts.onDeleted?.(m.file); fill(await api.mediaList()) } }),
                el('button', { textContent: 'Keep', onclick: showCard }))))
            showCard()
            return wrap
          }))
          note.textContent = entries.length ? 'Click a picture or video to use it. The bin deletes it from the library.' : 'Nothing imported yet. Bring in a picture or a looping video below.'
        }
        void api.mediaList().then(fill)
        const bring = (kind: 'image' | 'video') =>
          iconButton(kind === 'image' ? 'screen' : 'film', kind === 'image' ? 'Import a picture from your computer' : 'Import a video from your computer', async () => {
            const bg = await api.mediaImport(kind)
            if (bg) answer(bg, close)
          }, { badge: true, label: kind === 'image' ? 'Import picture…' : 'Import video…' })
        return el('div', { className: 'dialog pad bgpicker', role: 'dialog' },
          el('h3', { className: 'dhead', textContent: opts.title ?? 'Choose a background' }),
          el('div', { className: 'btns' }, bring('image'), bring('video'), el('span', { className: 'grow' }), el('button', { textContent: opts.noneLabel ?? 'No picture or video', title: opts.noneHint ?? 'Plain colour or gradient only', onclick: () => answer(null, close) })),
          note,
          grid,
          el('div', { className: 'btns end' }, el('button', { textContent: 'Cancel', onclick: () => answer(undefined, close) })),
        )
      },
      () => { if (!answered) resolve(undefined) },
    )
  })
}
