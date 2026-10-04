// @vitest-environment happy-dom
import { dirname, join } from 'node:path'
import { createRequire } from 'node:module'
import { expect, it, vi } from 'vitest'
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { EventBus, PDFFindController, PDFLinkService } from 'pdfjs-dist/legacy/web/pdf_viewer.mjs'
import { pdfReaderFixture } from './helpers/pdf-reader-fixture'

it('searches real PDF text and resolves nested/named outline destinations through the installed engine', async () => {
  const root = dirname(createRequire(import.meta.url).resolve('pdfjs-dist/package.json'))
  const original = pdfReaderFixture(true), task = getDocument({ data: original.slice(), cMapUrl: join(root, 'cmaps/'), cMapPacked: true,
    standardFontDataUrl: join(root, 'standard_fonts/'), wasmUrl: join(root, 'wasm/'), useSystemFonts: false, useWorkerFetch: false, stopAtErrors: true })
  const bus = new EventBus(), link = new PDFLinkService({ eventBus: bus }), finder = new PDFFindController({ eventBus: bus, linkService: link, delay: 0 })
  const viewer = { currentPageNumber: 1, pagesRotation: 0, scrollPageIntoView: vi.fn() }
  link.setViewer(viewer as never); finder.onIsPageVisible = () => true
  try {
    const document = await task.promise
    link.setDocument(document); finder.setDocument(document)
    const outline = await document.getOutline()
    expect(outline.map(item => item.title)).toEqual(['Introduction', 'Second chapter'])
    expect(outline[1]?.items[0]?.title).toBe('Final section')
    await link.goToDestination(outline[1]!.dest!)
    expect(viewer.scrollPageIntoView).toHaveBeenCalledWith(expect.objectContaining({ pageNumber: 2 }))
    const matches = new Promise<{ current: number; total: number }>(resolve => bus.on('updatefindmatchescount', event => { if (event.matchesCount.total === 3) resolve(event.matchesCount) }))
    bus.dispatch('find', { query: 'File surface reading', type: 'again', caseSensitive: false, entireWord: false, highlightAll: true, findPrevious: false, matchDiacritics: false })
    expect(await matches).toMatchObject({ total: 3 })
    const noMatches = new Promise<void>(resolve => bus.on('updatefindcontrolstate', event => { if (event.rawQuery === 'absent needle' && event.state === 1) resolve() }))
    bus.dispatch('find', { query: 'absent needle', type: 'again', caseSensitive: false, entireWord: false, highlightAll: true, findPrevious: false, matchDiacritics: false })
    await noMatches
    expect(finder.pageMatches?.every(page => page.length === 0)).toBe(true)
    expect(original).toEqual(pdfReaderFixture(true))
  } finally { finder.setDocument(null as never); link.setDocument(null); await task.destroy() }
})
