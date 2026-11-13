import { Uint8ArrayReader, Uint8ArrayWriter, ZipWriter, ZipReader } from '@zip.js/zip.js'
import type { RandomAccessSource } from '../../src/bytes'

const encode = (text: string) => new TextEncoder().encode(text)

export async function zip(entries: Record<string, string | Uint8Array>, level = 0): Promise<Uint8Array> {
  const writer = new ZipWriter(new Uint8ArrayWriter(), { useWebWorkers: false, level })
  for (const [path, content] of Object.entries(entries)) await writer.add(path, new Uint8ArrayReader(typeof content === 'string' ? encode(content) : content))
  return writer.close()
}

export const chapterOne = '<html xmlns="http://www.w3.org/1999/xhtml"><head><title>One</title></head><body><h1 id="opening">First chapter</h1><img src="art/cover.png"/><a href="two.xhtml#second">Next</a><script>window.evil=true</script><img src="https://example.invalid/track.png" onerror="window.evil=true"/></body></html>'
export const chapterTwo = '<html xmlns="http://www.w3.org/1999/xhtml"><head><title>Two</title></head><body><h1 id="second">Second chapter</h1><p>Only requested when reading chapter two.</p></body></html>'
export const png = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jP1EAAAAASUVORK5CYII='), char => char.charCodeAt(0))

export const epub = (level = 0, missingFirst = false, sharedSecond = false, cyclicStyle = false) => zip({
  mimetype: 'application/epub+zip',
  'META-INF/container.xml': '<container xmlns="urn:oasis:names:tc:opendocument:xmlns:container" version="1.0"><rootfiles><rootfile full-path="book/package.opf" media-type="application/oebps-package+xml"/></rootfiles></container>',
  'book/package.opf': '<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="id">two-chapters</dc:identifier><dc:title>Two Chapters</dc:title><dc:creator>Sample Author</dc:creator><dc:language>en</dc:language></metadata><manifest><item id="one" href="one.xhtml" media-type="application/xhtml+xml"/><item id="two" href="two.xhtml" media-type="application/xhtml+xml"/><item id="cover" href="art/cover.png" media-type="image/png"/><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/></manifest><spine><itemref idref="one"/><itemref idref="two"/></spine></package>'.replace('</manifest>', sharedSecond ? '<item id="secondart" href="art/second.png" media-type="image/png"/></manifest>' : '</manifest>').replace('</manifest>', cyclicStyle ? '<item id="xstyle" href="x.css" media-type="text/css"/><item id="ystyle" href="y.css" media-type="text/css"/></manifest>' : '</manifest>'),
  'book/nav.xhtml': '<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head><title>Contents</title></head><body><nav epub:type="toc"><ol><li><a href="one.xhtml#opening">One</a></li><li><a href="two.xhtml#second">Two</a></li></ol></nav></body></html>',
  ...(!missingFirst ? { 'book/one.xhtml': cyclicStyle ? chapterOne.replace('</head>', '<link rel="stylesheet" href="x.css"/></head>') : chapterOne } : {}),
  'book/two.xhtml': cyclicStyle ? chapterTwo.replace('</head>', '<link rel="stylesheet" href="y.css"/></head>') : sharedSecond ? chapterTwo.replace('</body>', '<img src="art/cover.png"/><img src="art/second.png"/></body>') : chapterTwo,
  ...(sharedSecond ? { 'book/art/second.png': new Uint8Array([...png, ...encode('SECOND_IMAGE')]) } : {}),
  'book/art/cover.png': png,
  ...(cyclicStyle ? { 'book/x.css': '@import "y.css"; h1 {color: red}', 'book/y.css': '@import "x.css"; p {color: blue}' } : {}),
  // An unreferenced stored resource makes reading the whole ZIP detectable, without a huge test fixture.
  'unused.bin': new Uint8Array(512 * 1024).fill(71)
}, level)

export const fb2 = () => encode('<?xml version="1.0" encoding="utf-8"?><FictionBook xmlns="http://www.gribuser.ru/xml/fictionbook/2.0"><description><title-info><book-title>Fiction Book</book-title><author><first-name>Sample</first-name><last-name>Author</last-name></author><lang>en</lang></title-info><document-info><id>fiction</id></document-info></description><body><section id="first"><title><p>First chapter</p></title><p>Fiction chapter one.</p></section><section id="second"><title><p>Second chapter</p></title><p>Fiction chapter two.</p></section></body></FictionBook>')

/** Uncompressed MOBI6 Palm database with one actual text record and a canonical MOBI header. */
export function mobi(encrypted = false, withImage = false): Uint8Array {
  const title = encode('Palm Book'), content = encode(`<html><head><title>Palm Book</title></head><body><h1>First Palm chapter</h1><p>A real Palm text record.</p>${withImage ? '<img recindex="1"/>' : ''}<mbp:pagebreak/><h1>Second Palm chapter</h1>${withImage ? '<img recindex="1"/>' : ''}</body></html>`)
  const recordCount = withImage ? 3 : 2, recordStart = 78 + recordCount * 8 + 2, textStart = recordStart + 248 + title.length
  const bytes = new Uint8Array(textStart + content.length + (withImage ? png.length : 0)), view = new DataView(bytes.buffer)
  bytes.set(encode('Palm Book'), 0); bytes.set(encode('BOOKMOBI'), 60)
  view.setUint16(76, recordCount); view.setUint32(78, recordStart); view.setUint32(86, textStart)
  view.setUint16(recordStart, 1); view.setUint32(recordStart + 4, content.length); view.setUint16(recordStart + 8, 1)
  view.setUint16(recordStart + 10, 4096); view.setUint16(recordStart + 12, encrypted ? 1 : 0)
  bytes.set(encode('MOBI'), recordStart + 16); view.setUint32(recordStart + 20, 232)
  view.setUint32(recordStart + 24, 2); view.setUint32(recordStart + 28, 65001); view.setUint32(recordStart + 32, 7); view.setUint32(recordStart + 36, 6)
  view.setUint32(recordStart + 84, 248); view.setUint32(recordStart + 88, title.length); view.setUint32(recordStart + 108, 2); view.setUint32(recordStart + 244, 0xffffffff)
  if (withImage) { view.setUint32(94, textStart + content.length); bytes.set(png, textStart + content.length) }
  bytes.set(title, recordStart + 248); bytes.set(content, textStart)
  return bytes
}

export function source(bytes: Uint8Array) {
  const reads: { offset: number; length: number; signal?: AbortSignal }[] = []
  const value: RandomAccessSource = { size: bytes.length, async read(offset, length, signal) {
    signal?.throwIfAborted(); reads.push({ offset, length, ...(signal ? { signal } : {}) }); return bytes.slice(offset, offset + length)
  } }
  return { value, reads }
}

/** Locate a stored fixture entry with zip.js's authoritative local-header offset. */
export async function entryDataOffset(bytes: Uint8Array, name: string): Promise<number> {
  const reader = new ZipReader(new Uint8ArrayReader(bytes), { useWebWorkers: false })
  try {
    const entry = (await reader.getEntries()).find(entry => entry.filename === name)!
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    return entry.offset + 30 + view.getUint16(entry.offset + 26, true) + view.getUint16(entry.offset + 28, true)
  } finally { await reader.close() }
}
