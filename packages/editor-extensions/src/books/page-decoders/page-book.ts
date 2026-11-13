import type { ReaderBook } from '../types'
import { IMAGE_PAGE_STYLE } from '../image-page-style'
import { BOOK_CONTENT_CSP } from '../security'

/** A fixed-page consumer retains one rendered page, never all pages visited. */
export function pageBook(name: string, pages: { id: string; size: number }[], controller: AbortController,
  render: (index: number, signal: AbortSignal) => Promise<Blob>, dispose: () => void = () => {}): ReaderBook {
  let resident: { index: number; document: string; image: string } | undefined
  let pending: { index: number; controller: AbortController; result: Promise<string> } | undefined
  const clear = () => {
    if (resident) { URL.revokeObjectURL(resident.document); URL.revokeObjectURL(resident.image); resident = undefined }
  }
  const stop = () => { pending?.controller.abort(); pending = undefined; clear() }
  controller.signal.addEventListener('abort', stop, { once: true })
  const sections = pages.map((page, index) => ({
    id: page.id, size: page.size,
    load(): Promise<string> {
      controller.signal.throwIfAborted()
      if (resident?.index === index) {
        pending?.controller.abort(); pending = undefined
        return Promise.resolve(resident.document)
      }
      if (pending?.index === index) return pending.result
      pending?.controller.abort()
      const job = new AbortController()
      const abort = () => job.abort(controller.signal.reason)
      controller.signal.addEventListener('abort', abort, { once: true })
      const result = render(index, job.signal).then(blob => {
        job.signal.throwIfAborted()
        clear()
        const image = URL.createObjectURL(blob)
        const document = URL.createObjectURL(new Blob([
          '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">',
          `<meta http-equiv="Content-Security-Policy" content="${BOOK_CONTENT_CSP}">`,
          `<style>${IMAGE_PAGE_STYLE}</style>`,
          `<img alt="Page ${index + 1}" src="${image}">`,
        ], { type: 'text/html' }))
        resident = { index, document, image }
        return document
      }).finally(() => {
        controller.signal.removeEventListener('abort', abort)
        if (pending?.controller === job) pending = undefined
      })
      pending = { index, controller: job, result }
      return result
    },
    unload() {
      if (pending?.index === index) { pending.controller.abort(); pending = undefined }
      if (resident?.index === index) clear()
    },
  }))
  return {
    metadata: { title: name }, layout: 'pre-paginated', direction: 'ltr', sections,
    toc: pages.map((_, index) => ({ label: `Page ${index + 1}`, href: `page:${index}` })),
    resolveHref(href) { const match = /^page:(\d+)$/.exec(href); const index = match ? Number(match[1]) : -1; return index >= 0 && index < pages.length ? { index } : null },
    destroy() { controller.abort(); stop(); dispose() },
  }
}
