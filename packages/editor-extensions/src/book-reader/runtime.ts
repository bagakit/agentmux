import { openBook } from '../books'
import type { ReaderBook } from '../books/types'
import type { RandomAccessSource } from '../bytes'
import type { BookOpenRequest, BookSnapshot, BookBytesPort } from './protocol'

declare global { interface Window { bookBytes: BookBytesPort; __agentmuxBookRuntime: typeof runtime } }
let book: ReaderBook | undefined
const cancelled = () => new DOMException('The original book read was cancelled', 'AbortError')
async function operation<T>(signal: AbortSignal | undefined, perform: (id: string) => Promise<T>): Promise<T> {
  signal?.throwIfAborted()
  const id = crypto.randomUUID(), cancel = () => { void window.bookBytes.cancel(id) }
  signal?.addEventListener('abort', cancel, { once: true })
  try { const result = await perform(id); signal?.throwIfAborted(); return result }
  finally { signal?.removeEventListener('abort', cancel) }
}
function ready<T extends {status: string}>(result: T): Extract<T, { status: 'read' }> {
  if (result.status !== 'read') throw Object.assign(new Error((result as {message?: string}).message ?? 'The original file is unavailable'), { code: (result as {code?: string}).code })
  return result as Extract<T, {status: 'read'}>
}
const runtime = {
  async open(options: BookOpenRequest): Promise<BookSnapshot> {
    book?.destroy(); book = undefined
    const source: RandomAccessSource = { size: options.size, async read(offset, length, signal) {
      signal?.throwIfAborted()
      const count = Math.min(length, Math.max(0, options.size - offset)), bytes = new Uint8Array(count)
      for (let at = 0; at < count;) {
        const length = Math.min(1024 * 1024, count - at)
        const result = ready(await operation(signal, id => window.bookBytes.read(id, offset + at, length)))
        if (result.bytes.length !== length) throw new Error('The original file returned an incomplete span')
        bytes.set(result.bytes, at); at += length
      }
      return bytes
    } }
    book = await openBook(source, { name: options.name, format: options.format, archiveSource: {
      entries: signal => operation(signal, async id => ready(await window.bookBytes.entries(id)).value),
      loadEntry: (path, signal) => operation(signal, async id => ready(await window.bookBytes.entry(id, path)).value)
    } })
    return { metadata: book.metadata, toc: book.toc, sections: book.sections.map(({id,size}) => ({id,size})), layout: book.layout, direction: book.direction }
  },
  async load(index: number) { if (!book) throw cancelled(); const section = book.sections[index]; if (!section) throw new RangeError('This book section is unavailable'); return section.load() },
  unload(index: number) { book?.sections[index]?.unload() },
  resolve(href: string, fromSection?: number) { return book?.resolveHref(href, fromSection) ?? null },
  destroy() { book?.destroy(); book = undefined },
}
window.__agentmuxBookRuntime = runtime
