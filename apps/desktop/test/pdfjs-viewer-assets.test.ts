import { once } from 'node:events'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, type ReadStream } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { PassThrough } from 'node:stream'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { pdfjsViewerAssets } from '../scripts/pdfjs-viewer-assets'

const observed = vi.hoisted(() => ({ streams: [] as ReadStream[] }))
vi.mock('node:fs', async importOriginal => {
  const original = await importOriginal<typeof import('node:fs')>()
  return { ...original, createReadStream: (...args: Parameters<typeof original.createReadStream>) => {
    const stream = original.createReadStream(...args); observed.streams.push(stream); return stream
  } }
})
let root: string, middleware: any
function plugin(root: string, base = '/') {
  const result = pdfjsViewerAssets(root)
  if (typeof result.configResolved !== 'function' || typeof result.configureServer !== 'function') throw new Error('PDF asset hooks missing')
  result.configResolved.call({} as never, { base } as never)
  result.configureServer.call({} as never, { middlewares: { use(callback: any) { middleware = callback } } } as never)
  return result
}
function request(method = 'GET', url = '/pdfjs/cmaps/map.bcmap') {
  const response = Object.assign(new PassThrough({ highWaterMark: 16 }), { setHeader: vi.fn(), statusCode: 0 })
  const next = vi.fn(); middleware({ method, url }, response, next)
  return { response, next, source: observed.streams.at(-1) }
}
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'agentmux-pdfjs-assets-'))
  for (const directory of ['cmaps', 'standard_fonts', 'wasm', 'iccs']) mkdirSync(join(root, directory))
  writeFileSync(join(root, 'cmaps/map.bcmap'), 'exact character map bytes')
  writeFileSync(join(root, 'wasm/large.wasm'), Buffer.alloc(1024 * 1024, 9))
  writeFileSync(join(root, 'wasm/decoder.js'), 'export default () => null')
  plugin(root)
})
afterEach(async () => {
  await Promise.all(observed.streams.map(async stream => { if (stream.closed) return; const closed = once(stream, 'close'); stream.destroy(); await closed }))
  observed.streams.length = 0; rmSync(root, { recursive: true, force: true })
})

it('serves exact local bytes, allows HEAD without opening resources, and respects the gallery base', async () => {
  const current = request(), chunks: Buffer[] = []
  current.response.on('data', chunk => chunks.push(chunk)); await once(current.response, 'end')
  expect(Buffer.concat(chunks).toString()).toBe('exact character map bytes'); expect(current.next).not.toHaveBeenCalled()
  await expect.poll(() => current.source?.closed).toBe(true)
  expect(current.response.listenerCount('close')).toBe(0); expect(current.response.listenerCount('error')).toBe(0)
  const before = observed.streams.length, head = request('HEAD', '/pdfjs/wasm/large.wasm')
  expect(observed.streams).toHaveLength(before); expect(head.response.writableEnded).toBe(true)
  expect(head.response.setHeader).toHaveBeenCalledWith('Content-Type', 'application/wasm')
  head.response.destroy()
  const decoder = request('HEAD', '/pdfjs/wasm/decoder.js')
  expect(decoder.response.setHeader).toHaveBeenCalledWith('Content-Type', 'text/javascript'); decoder.response.destroy()
  plugin(root, '/agentmux-gallery/')
  const prefixed = request('HEAD', '/agentmux-gallery/pdfjs/cmaps/map.bcmap')
  expect(prefixed.response.statusCode).toBe(200); expect(prefixed.next).not.toHaveBeenCalled(); prefixed.response.destroy()
})
it('closes backpressured streams and removes response listeners for abandoned previews', async () => {
  const responses: PassThrough[] = []
  for (let index = 0; index < 5; index++) {
    const current = request('GET', '/pdfjs/wasm/large.wasm')
    expect(current.source).toBeDefined(); responses.push(current.response)
    await once(current.source!, 'pause'); const closed = once(current.response, 'close'); current.response.destroy(); await closed
  }
  await expect.poll(() => observed.streams.map(stream => stream.closed)).toEqual([true, true, true, true, true])
  expect(observed.streams.map(stream => (stream as ReadStream & { fd: number | null }).fd)).toEqual([null, null, null, null, null])
  expect(responses.map(response => [response.listenerCount('close'), response.listenerCount('error')])).toEqual([[0, 0], [0, 0], [0, 0], [0, 0], [0, 0]])
})
it.each(['/pdfjs/cmaps/%00', '/pdfjs/cmaps/%5cmap.bcmap', '/pdfjs/cmaps/%2e%2e/secret', '/pdfjs/other/map.bcmap', '/pdfjs/cmaps/missing.bcmap'])('passes through an invalid asset path %s without a stream', path => {
  const current = request('GET', path); expect(current.next).toHaveBeenCalledOnce(); expect(observed.streams).toHaveLength(0); current.response.destroy()
})
it('ships exact installed CJK maps, non-embedded font data, WASM decoders and CMYK profile bytes', async () => {
  const installed = dirname(createRequire(import.meta.url).resolve('pdfjs-dist/package.json')), output = join(root, 'output')
  const assets = pdfjsViewerAssets()
  if (typeof assets.writeBundle !== 'function') throw new Error('PDF asset build hook missing')
  assets.writeBundle.call({} as never, { dir: output } as never, {})
  const resources = ['cmaps/UniGB-UCS2-H.bcmap', 'standard_fonts/LiberationSans-Regular.ttf', 'wasm/openjpeg.wasm', 'wasm/qcms_bg.wasm', 'wasm/jbig2.wasm', 'iccs/CGATS001Compat-v2-micro.icc']
  expect(resources.length).toBeGreaterThan(0)
  for (const resource of resources) {
    expect(existsSync(join(output, 'pdfjs', resource))).toBe(true)
    const expected = readFileSync(join(installed, resource)), actual = readFileSync(join(output, 'pdfjs', resource))
    expect(actual).toEqual(expected); expect(actual.byteLength).toBeGreaterThan(0)
    if (resource.endsWith('.wasm')) expect(WebAssembly.validate(actual)).toBe(true)
  }
})
