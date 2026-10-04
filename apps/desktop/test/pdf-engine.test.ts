import { dirname, join } from 'node:path'
import { createRequire } from 'node:module'
import { expect, it } from 'vitest'
// Node needs the package's documented legacy entry; Renderer uses its modern build.
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { pdfReaderFixture } from './helpers/pdf-reader-fixture'

it('uses the actual installed engine to read three pages and CJK text with local font/character resources', async () => {
  const engine = dirname(createRequire(import.meta.url).resolve('pdfjs-dist/package.json'))
  const original = pdfReaderFixture(), task = getDocument({ data: original.slice(),
    cMapUrl: join(engine, 'cmaps/'), cMapPacked: true, standardFontDataUrl: join(engine, 'standard_fonts/'),
    wasmUrl: join(engine, 'wasm/'), iccUrl: join(engine, 'iccs/'), useSystemFonts: false, useWorkerFetch: false, stopAtErrors: true })
  try {
    const document = await task.promise
    expect(document.numPages).toBe(3)
    const texts: string[] = []
    for (let index = 1; index <= document.numPages; index++) {
      const page = await document.getPage(index), text = await page.getTextContent()
      await page.getOperatorList()
      texts.push(text.items.map(item => 'str' in item ? item.str : '').join(' '))
    }
    expect(texts).toHaveLength(3)
    expect(texts[0]).toContain('File surface reading - page 1')
    expect(texts[1]).toContain('中文阅读')
    expect(original.byteLength).toBeGreaterThan(0)
  } finally { await task.destroy() }
})
