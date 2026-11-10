import type { PrestreamerApi } from '../preload'
import { mediaUrl, type Background, type MediaEntry } from '../shared/types'
import { showModal } from './dialogs'
import { iconButton } from './icons'
import { t } from '../shared/i18n'

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
              const trash = iconButton('trash', t('settings.picker.deleteTitle', { name: m.name }), (e) => { e.stopPropagation(); askDelete() }, { size: 13, className: 'mtrash' })
              wrap.replaceChildren(
                el('button', { className: `mcard ${picked ? 'picked' : ''}`, title: m.name, onclick: () => answer({ kind: m.kind, file: m.file }, close) }, mediaThumb(m), el('span', { className: 'mname', textContent: m.name })),
                trash,
              )
            }
            // Deleting asks inside the card (a second dialog would replace this one).
            const askDelete = () => wrap.replaceChildren(el('div', { className: 'mask' },
              el('div', { textContent: t('settings.picker.deleteAsk', { name: m.name }) }),
              el('div', { className: 'dim', textContent: t('settings.picker.deleteNote') }),
              el('div', { className: 'btns' },
                el('button', { className: 'danger', textContent: t('settings.delete'), onclick: async () => { if (await api.mediaRemove(m.file)) opts.onDeleted?.(m.file); fill(await api.mediaList()) } }),
                el('button', { textContent: t('settings.picker.keep'), onclick: showCard }))))
            showCard()
            return wrap
          }))
          note.textContent = entries.length ? t('settings.picker.hint') : t('settings.picker.empty')
        }
        void api.mediaList().then(fill)
        const bring = (kind: 'image' | 'video') =>
          iconButton(kind === 'image' ? 'screen' : 'film', kind === 'image' ? t('settings.picker.importPictureTitle') : t('settings.picker.importVideoTitle'), async () => {
            const bg = await api.mediaImport(kind)
            if (bg) answer(bg, close)
          }, { badge: true, label: kind === 'image' ? t('settings.picker.importPicture') : t('settings.picker.importVideo') })
        return el('div', { className: 'dialog pad bgpicker', role: 'dialog' },
          el('h3', { className: 'dhead', textContent: opts.title ?? t('settings.picker.title') }),
          el('div', { className: 'btns' }, bring('image'), bring('video'), el('span', { className: 'grow' }), el('button', { textContent: opts.noneLabel ?? t('settings.picker.none'), title: opts.noneHint ?? t('settings.picker.noneHint'), onclick: () => answer(null, close) })),
          note,
          grid,
          el('div', { className: 'btns end' }, el('button', { textContent: t('settings.cancel'), onclick: () => answer(undefined, close) })),
        )
      },
      () => { if (!answered) resolve(undefined) },
    )
  })
}
