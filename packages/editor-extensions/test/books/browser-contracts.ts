import { openBook } from '@agentmux/editor-extensions/books'
import { BOOK_CONTENT_CSP } from '../../src/books/security'
import { epub, fb2, mobi, png, source, zip, entryDataOffset } from './fixtures'
import type { ReaderBook } from '@agentmux/editor-extensions/books'

declare const __KF8_BASE64__: string

type Case = { checks: number; failure?: string; facts?: Record<string, unknown> }

export async function runBookContracts() {
  const results: Record<string, Case> = {}, activeURLs = new Set<string>(), issued = URL.createObjectURL.bind(URL), revoke = URL.revokeObjectURL.bind(URL)
  URL.createObjectURL = blob => { const url = issued(blob); activeURLs.add(url); return url }
  URL.revokeObjectURL = url => { activeURLs.delete(url); revoke(url) }
  const page = async (url: string) => new DOMParser().parseFromString(await (await fetch(url)).text(), 'text/html')
  async function run(name: string, body: (check: (value: unknown, label: string) => void, keep: (book: ReaderBook) => ReaderBook) => Promise<Record<string, unknown> | void>) {
    let checks = 0
    const books: ReaderBook[] = []
    const check = (value: unknown, label: string) => { checks++; if (!value) throw new Error(label) }
    try {
      const facts = await body(check, book => { books.push(book); return book })
      for (const book of books) book.destroy()
      check(activeURLs.size === 0, 'The case releases all actual browser object URLs')
      results[name] = { checks, ...(facts ? { facts } : {}) }
    } catch (error) { results[name] = { checks, failure: error instanceof Error ? error.message + '\n' + error.stack : String(error) } }
    finally { for (const book of books) book.destroy() }
  }
  try {
    await run('epub', async (check, keep) => {
      const bytes = await epub(), input = source(bytes), reader = keep(await openBook(input.value, { name: 'sample.epub', format: 'epub' }))
      check(reader.metadata.title === 'Two Chapters' && reader.metadata.author === 'Sample Author' && reader.metadata.language === 'en', 'EPUB metadata comes from its actual package document')
      check(reader.sections.length === 2 && reader.toc.map(item => item.label).join('|') === 'One|Two', 'The actual EPUB spine and navigation contain two chapters')
      check(activeURLs.size === 0, 'Opening EPUB does not materialize chapter documents')
      const openingBytes = input.reads.reduce((sum, item) => sum + item.length, 0)
      check(openingBytes < bytes.length / 2, 'EPUB metadata does not read the unreferenced archive body')
      const first = await reader.sections[0]!.load(), firstPage = await page(first), requested = input.reads.length
      check(firstPage.body.textContent?.includes('First chapter'), 'Loading chapter one returns its actual document')
      check(await reader.sections[0]!.load() === first && input.reads.length === requested, 'Repeated section reads reuse the live section')
      const location = await reader.resolveHref('book/two.xhtml#second')
      check(location?.index === 1 && location.fragment === 'second', 'Navigation resolves the original chapter and anchor')
      check((await reader.resolveHref('two.xhtml#second', 0))?.index === 1, 'A relative content link uses the original section path')
      check((await reader.resolveHref('#opening', 0))?.fragment === 'opening', 'A fragment-only content link stays in its original section')
      const second = await reader.sections[1]!.load()
      check((await page(second)).body.textContent?.includes('Second chapter'), 'Loading chapter two reads its document')
      reader.sections[0]!.unload()
      let released = false
      try { await fetch(first) } catch { released = true }
      check(released && activeURLs.has(second), 'Unloading one chapter revokes its actual URL and preserves the other')
      return { fileBytes: bytes.length, openingBytes, reads: input.reads.length, sections: reader.sections.length }
    })
    await run('epub-concurrent', async (check, keep) => {
      const bytes = await epub(0, false, true), marker = await entryDataOffset(bytes, 'book/art/cover.png'), input = source(bytes)
      let block = false, resume!: () => void, begin!: () => void, imageReads = 0
      const started = new Promise<void>(resolve => { begin = resolve }), original = input.value.read.bind(input.value)
      input.value.read = async (offset, length, signal) => {
        if (offset <= marker && offset + length > marker) {
          imageReads++; if (block) { block = false; begin(); await new Promise<void>(resolve => { resume = resolve }) }
        }
        return original(offset, length, signal)
      }
      const reader = keep(await openBook(input.value, { name: 'concurrent.epub', format: 'epub' }))
      block = true
      const a = reader.sections[0]!.load(), b = reader.sections[1]!.load()
      await started; await new Promise(resolve => setTimeout(resolve, 0)); resume()
      const [first, second] = await Promise.all([page(await a), page(await b)]), one = first.querySelector('img[src^="blob:"]')!.getAttribute('src')!, two = second.querySelector('img[src^="blob:"]')!.getAttribute('src')!
      check(one === two && imageReads === 1, 'Concurrent EPUB section loads share the original asset read and URL')
      reader.sections[0]!.unload(); check((await fetch(two)).ok, 'Unloading either concurrent section preserves the remaining shared asset')
    })
    await run('css-cycle', async (check, keep) => {
      const bytes = await epub(0, false, false, true), markers = await Promise.all(['book/x.css', 'book/y.css'].map(name => entryDataOffset(bytes, name))), input = source(bytes)
      const waiting = new Set<number>(), resume: (() => void)[] = []
      let begin!: () => void
      const bothStarted = new Promise<void>(resolve => { begin = resolve }), original = input.value.read.bind(input.value)
      const reader = keep(await openBook(input.value, { name: 'cycle.epub', format: 'epub' }))
      input.value.read = async (offset, length, signal) => {
        const marker = markers.find(marker => offset <= marker && offset + length > marker)
        if (marker !== undefined && !waiting.has(marker)) {
          waiting.add(marker)
          await new Promise<void>(resolve => { resume.push(resolve); if (waiting.size === 2) begin() })
        }
        return original(offset, length, signal)
      }
      const loading = Promise.all([reader.sections[0]!.load(), reader.sections[1]!.load()])
      await bothStarted; for (const resolve of resume) resolve()
      let complete = false
      const resolved = loading.then(value => { complete = true; return value })
      await Promise.race([resolved, new Promise(resolve => setTimeout(resolve, 1500))])
      check(complete, 'Concurrent chapters with mutually importing CSS finish without a cross-job wait cycle')
      const urls = await resolved
      check(urls.length === 2 && (await page(urls[0]!)).body.textContent?.includes('First chapter'), 'Breaking one CSS cycle edge preserves both actual chapters')
    })
    await run('overlap', async (check, keep) => {
      const bytes = await epub(0, false, true), needle = new TextEncoder().encode('SECOND_IMAGE'), marker = bytes.findIndex((_, offset) => needle.every((byte, index) => bytes[offset + index] === byte)), input = source(bytes)
      let block = false, resume!: () => void, begin!: () => void
      const started = new Promise<void>(resolve => { begin = resolve }), original = input.value.read.bind(input.value)
      input.value.read = async (offset, length, signal) => {
        if (block && offset <= marker && offset + length > marker) {
          block = false; begin(); await new Promise<void>(resolve => { resume = resolve })
        }
        return original(offset, length, signal)
      }
      const reader = keep(await openBook(input.value, { name: 'overlap.epub', format: 'epub' }))
      const first = await page(await reader.sections[0]!.load()), shared = first.querySelector('img[src^="blob:"]')!.getAttribute('src')!
      block = true
      const loading = reader.sections[1]!.load()
      await started; reader.sections[0]!.unload(); resume()
      const second = await page(await loading)
      check(second.querySelector('img[src]')?.getAttribute('src') === shared, 'Both actual chapters reference the same shared image')
      let readable = false; try { readable = (await fetch(shared)).ok } catch {}
      check(readable, 'An in-flight chapter retains a shared resource after the old chapter unloads')
    })
    await run('missing', async (check, keep) => {
      const reader = keep(await openBook(source(await epub(0, true)).value, { name: 'missing.epub', format: 'epub' }))
      let failure: string | undefined
      try { await reader.sections[0]!.load() } catch (error) { failure = (error as { code?: string }).code }
      check(failure === 'BOOK_SECTION_UNAVAILABLE', 'A missing archive chapter is a section failure, never an empty successful page')
      check((await page(await reader.sections[1]!.load())).body.textContent?.includes('Second chapter'), 'A missing chapter does not remove the healthy chapter')
    })
    await run('compressed', async (check, keep) => {
      const reader = keep(await openBook(source(await epub(6)).value, { name: 'deflated.epub', format: 'epub' }))
      check(reader.metadata.title === 'Two Chapters', 'Deflated EPUB package metadata is decompressed by the actual ZIP reader')
      check((await page(await reader.sections[0]!.load())).body.textContent?.includes('First chapter'), 'Deflated chapter one decodes')
      check((await page(await reader.sections[1]!.load())).body.textContent?.includes('Second chapter'), 'Deflated chapter two decodes')
    })
    await run('security', async (check, keep) => {
      const reader = keep(await openBook(source(await epub()).value, { name: 'sample.epub', format: 'epub' })), first = await reader.sections[0]!.load(), doc = await page(first)
      check(!doc.querySelector('script, iframe, object, form'), 'Section documents contain no executable embedding')
      check(!doc.querySelector('[onerror], [src^="https:"]'), 'Section documents contain no event handlers or external image requests')
      const policy = doc.querySelector('meta[http-equiv="Content-Security-Policy"]')
      check(policy?.getAttribute('content') === BOOK_CONTENT_CSP && policy.namespaceURI === 'http://www.w3.org/1999/xhtml', 'The actual XHTML section declares an HTML-namespace CSP meta')
      const image = doc.querySelector('img[src^="blob:"]')!.getAttribute('src')!
      check(activeURLs.has(image), 'The section references its owned image URL')
      reader.sections[0]!.unload(); check(!activeURLs.has(image), 'Section unload releases its referenced image')
      const again = await page(await reader.sections[0]!.load())
      check(again.querySelector('img[src^="blob:"]'), 'Reloading a released section obtains live resources again')
    })
    await run('traversal', async check => {
      let rejected = false
      try { await openBook(source(await zip({ '../outside.xhtml': '<p>outside</p>' })).value, { name: 'bad.epub', format: 'epub' }) }
      catch (error) { rejected = (error as { filename?: string }).filename === '../outside.xhtml' }
      check(rejected, 'The ZIP reader refuses the actual traversal entry')
    })
    await run('mobi', async (check, keep) => {
      const input = source(mobi()), reader = keep(await openBook(input.value, { name: 'sample.mobi', format: 'mobi' }))
      check(reader.metadata.title === 'Palm Book' && reader.sections.length >= 2, 'Actual MOBI records produce a title and split text sections')
      check(input.reads.some(read => read.offset === 60 && read.length === 8), 'MOBI reads the protocol magic through a record slice')
      const first = await reader.sections[0]!.load()
      check((await page(first)).body.textContent?.includes('First Palm chapter'), 'The MOBI section contains the actual Palm text record')
      reader.sections[0]!.unload(); check(!activeURLs.has(first), 'MOBI unload releases the section')
      check((await page(await reader.sections[0]!.load())).body.textContent?.includes('First Palm chapter'), 'MOBI can reopen a released section')
    })
    await run('mobi-images', async (check, keep) => {
      const bytes = mobi(false, true), input = source(bytes), reader = keep(await openBook(input.value, { name: 'images.mobi', format: 'mobi' }))
      const [a, b] = await Promise.all([reader.sections[0]!.load(), reader.sections[1]!.load()])
      const first = (await page(a)).querySelector('img')!.getAttribute('src')!, second = (await page(b)).querySelector('img')!.getAttribute('src')!
      check(first === second, 'Concurrent MOBI chapters share one actual image resource')
      const imageOffset = new DataView(bytes.buffer).getUint32(94)
      check(input.reads.filter(read => read.offset === imageOffset).length === 1, 'The shared MOBI record is read only once')
      reader.sections[0]!.unload(); check((await fetch(second)).ok, 'The second MOBI chapter keeps its image after the first unloads')
      reader.sections[1]!.unload()
      let released = false; try { await fetch(second) } catch { released = true }
      check(released, 'The last MOBI chapter releases its shared image')
    })
    await run('kf8', async (check, keep) => {
      const bytes = Uint8Array.from(atob(__KF8_BASE64__), character => character.charCodeAt(0)), input = source(bytes)
      const reader = keep(await openBook(input.value, { name: 'alice.azw3', format: 'azw3' }))
      check(reader.metadata.title.includes('Alice') && reader.sections.length > 2 && reader.toc.length > 0, 'The unmodified Gutenberg KF8 file produces actual metadata, spine and navigation')
      const openingBytes = input.reads.reduce((sum, read) => sum + read.length, 0)
      const items = reader.toc.flatMap(item => [item, ...(item.children ?? [])])
      const chapter = items.find(item => /rabbit.hole/i.test(item.label)) ?? items.find(item => /chapter/i.test(item.label))
      const index = chapter ? (await reader.resolveHref(chapter.href))?.index ?? 0 : 0
      const url = await reader.sections[index >= 0 ? index : 0]!.load(), doc = await page(url)
      check((doc.body.textContent?.trim().length ?? 0) > 100, 'The real KF8 section contains decoded book text')
      const stylesheet = doc.querySelector('link[rel="stylesheet"][href^="blob:"]')?.getAttribute('href')
      check(stylesheet && (await fetch(stylesheet)).headers.get('content-type')?.includes('text/css'), 'The real KF8 stylesheet preserves its original text/css MIME type')
      const entry = items.find(item => item.href.startsWith('kindle:'))
      check(entry && (await reader.resolveHref(entry.href)) !== null, 'The real KF8 navigation resolves its original record selector')
      reader.sections[index >= 0 ? index : 0]!.unload()
      let released = false; try { await fetch(url) } catch { released = true }
      check(released && input.reads.some(read => read.offset > 0 && read.length < bytes.length), 'KF8 uses original record slices and unload revokes its actual document')
      return { fileBytes: bytes.length, openingBytes, sections: reader.sections.length, title: reader.metadata.title }
    })
    await run('encrypted', async check => {
      let rejected = false
      try { await openBook(source(mobi(true)).value, { name: 'locked.azw3', format: 'azw3' }) }
      catch (error) { rejected = (error as { code?: string }).code === 'BOOK_ENCRYPTED' }
      check(rejected, 'The Kindle encryption flag is reported before text decoding')
    })
    await run('fb2', async (check, keep) => {
      const reader = keep(await openBook(source(fb2()).value, { name: 'sample.fb2', format: 'fb2' }))
      check(reader.metadata.title === 'Fiction Book' && reader.sections.length >= 2, 'Actual FictionBook XML produces metadata and chapters')
      check(activeURLs.size === 1, 'FB2 materializes only its small stylesheet before reading a chapter')
      const first = await reader.sections[0]!.load()
      check((await page(first)).body.textContent?.includes('Fiction chapter one'), 'FB2 chapter one has its actual content')
      reader.sections[0]!.unload(); check(!activeURLs.has(first), 'FB2 unload releases its page')
      const second = await page(await reader.sections[1]!.load())
      check(second.body.textContent?.includes('Fiction chapter two'), 'FB2 chapter two has its actual content')
      check(activeURLs.has(second.querySelector('link')!.getAttribute('href')!), 'The book stylesheet survives an earlier section release')
    })
    await run('cbz', async (check, keep) => {
      const canvas = document.createElement('canvas'); canvas.width = canvas.height = 1
      canvas.getContext('2d')!.fillRect(0,0,1,1)
      const jpeg = new Uint8Array(await (await new Promise<Blob>(resolve => canvas.toBlob(blob => resolve(blob!), 'image/jpeg'))).arrayBuffer())
      const reader = keep(await openBook(source(await zip({ 'page10.PNG': png, 'page2.JpEg': jpeg, 'note.txt': 'ignored' })).value, { name: 'sample.cbz', format: 'cbz' }))
      check(reader.layout === 'pre-paginated' && reader.sections.map(section => section.id).join('|') === 'page2.JpEg|page10.PNG', 'Actual CBZ images use natural page order')
      const first = await reader.sections[0]!.load(), doc = await page(first), image = doc.querySelector('img')!.getAttribute('src')!
      check(activeURLs.has(image) && Boolean(doc.querySelector('meta[http-equiv]')), 'CBZ uses an owned image and an inert document')
      const decoded = new Image(); decoded.src = image; await decoded.decode()
      check(decoded.naturalWidth === 1 && decoded.naturalHeight === 1, 'The real CBZ page is decoded by Chromium, not just fetched')
      reader.sections[0]!.unload(); check(!activeURLs.has(first) && !activeURLs.has(image), 'CBZ unload releases the image and document together')
      check((await page(await reader.sections[1]!.load())).querySelector('img'), 'Another CBZ page remains readable')
    })
    await run('close', async (check, keep) => {
      const input = source(await epub()), reader = keep(await openBook(input.value, { name: 'sample.epub', format: 'epub' }))
      await reader.sections[0]!.load(); reader.destroy()
      check(input.reads.every(read => read.signal?.aborted), 'Closing aborts the exact signals passed to original byte reads')
      let rejected = false
      try { await reader.sections[1]!.load() } catch (error) { rejected = (error as Error).name === 'AbortError' }
      check(rejected && activeURLs.size === 0, 'A closed book allocates no late section URL')
    })
    await run('inflight', async (check, keep) => {
      const input = source(await epub())
      let block = false, begin!: () => void, readSignal: AbortSignal | undefined
      const started = new Promise<void>(resolve => { begin = resolve })
      const original = input.value.read.bind(input.value)
      input.value.read = async (offset, length, signal) => {
        if (block) {
          readSignal = signal; begin()
          await new Promise<void>((_resolve, reject) => signal?.addEventListener('abort', () => reject(signal.reason), { once: true }))
        }
        return original(offset, length, signal)
      }
      const reader = keep(await openBook(input.value, { name: 'sample.epub', format: 'epub' }))
      block = true
      const loading = reader.sections[0]!.load().catch(error => error)
      await started; reader.destroy()
      check(readSignal?.aborted, 'Closing aborts the original byte read while the section is in flight')
      check((await loading)?.name === 'AbortError', 'The pending section receives its actual byte-read cancellation')
    })
    return { results, actualBrowser: navigator.userAgent }
  } finally { URL.createObjectURL = issued; URL.revokeObjectURL = revoke }
}

;(globalThis as unknown as { runBookContracts: typeof runBookContracts }).runBookContracts = runBookContracts
