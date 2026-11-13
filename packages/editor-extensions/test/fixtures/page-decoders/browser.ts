import { openDjvuBook } from '../../../src/books/page-decoders/djvu'
import originalUrl from './chinese-cookbook.djvu?url'

const check = (condition: unknown, message: string) => { if (!condition) throw new Error(message) }
const nativeWorker = globalThis.Worker, workers = { created: 0, terminated: 0 }
globalThis.Worker = class extends nativeWorker {
  constructor(url: string | URL, options?: WorkerOptions) { super(url, options); workers.created++ }
  terminate() { workers.terminated++; super.terminate() }
}
const bytes = new Uint8Array(await (await fetch(originalUrl)).arrayBuffer())
let slow = false, cancelled = 0
const reads: [number, number][] = []
const source = { size: bytes.length, async read(offset: number, length: number, signal?: AbortSignal) {
  signal?.throwIfAborted()
  reads.push([offset, length])
  if (slow) await new Promise((_, reject) => signal?.addEventListener('abort', () => { cancelled++; reject(signal.reason) }, { once: true }))
  return bytes.slice(offset, offset + length)
} }
async function pixels(document: string) {
  const html = await (await fetch(document)).text(), image = /src="([^"]+)"/.exec(html)?.[1]
  check(image, 'The real page consumer returns an image document')
  const blob = await (await fetch(image!)).blob(), bitmap = await createImageBitmap(blob)
  try {
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height), context = canvas.getContext('2d')!
    context.drawImage(bitmap, 0, 0)
    const data = context.getImageData(0, 0, bitmap.width, bitmap.height).data
    const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', data)), byte => byte.toString(16).padStart(2, '0')).join('')
    return { width: bitmap.width, height: bitmap.height, sha256: hash, pngBytes: blob.size }
  } finally { bitmap.close() }
}
const proof: any = { workers, ready: false, passed: false }
Object.assign(globalThis, { __pageDecoderProof: proof })
try {
  const book = await openDjvuBook(source, 'The Chinese Cook Book · 1917', new AbortController())
  check(book.sections.length === 5, 'Five original pages are indexed')
  check(reads.length === 1 && reads[0]![1] === 65536, 'Open fetches only the first 64 KiB')
  const first = await book.sections[0]!.load(), firstPixels = await pixels(first)
  check(firstPixels.sha256 === 'af1cf9b47a4156d7a3207f5f7fe335c0bb4617323d86d21113f4bd3c8991c56b', 'First original page pixels match the qualified WASM result')
  const last = await book.sections[4]!.load(), lastPixels = await pixels(last)
  check(lastPixels.sha256 === '56dea9d15c0a60c73a8eec700db34b1b8ffd879adb3090c9be108ef26a09f1cd', 'Jump to the last original page renders different correct pixels')
  check(reads.some(([offset]) => offset >= 131072), 'Jump fetches the relevant tail ranges')
  check(!reads.some(([offset, length]) => offset === 0 && length === bytes.length), 'No original whole-file read')
  let revoked = false; try { await fetch(first) } catch { revoked = true }
  check(revoked, 'Previous page document is released')
  proof.firstPixels = firstPixels; proof.lastPixels = lastPixels
  Object.assign(globalThis, {
    async __repeatPages(count: number) { for (let i = 0; i < count; i++) await book.sections[(i % 2) * 4]!.load(); check(workers.created === 1 && workers.terminated === 0, 'Repeated visits reuse one initialized engine'); return { reads: reads.length, workers: { ...workers } } },
    async __finishPages() {
      book.sections[4]!.unload(); slow = true
      const beforeCancel = reads.length, deadline = Date.now() + 5000
      const pending = book.sections[4]!.load().then(() => false, () => true)
      while (reads.length === beforeCancel) {
        await new Promise(resolve => setTimeout(resolve, 20))
        check(Date.now() < deadline, 'The real worker requested bytes before cancellation')
      }
      book.sections[4]!.unload()
      check(await pending, 'Unloading an in-flight page rejects it')
      check(workers.terminated === 1 && cancelled === 1, 'Cancellation terminates the decoder and aborts its original read')
      slow = false
      const restored = await book.sections[0]!.load()
      check((await pixels(restored)).sha256 === firstPixels.sha256, 'A new page still works after cancellation')
      document.querySelector('iframe')!.src = restored
      document.querySelector('#status')!.textContent = 'Original DjVu page · bounded ranges · isolated WASM worker'
      const before = reads.length; await new Promise(resolve => setTimeout(resolve, 120))
      check(reads.length === before, 'Idle reader reads no bytes')
      book.destroy()
      check(workers.created === workers.terminated, 'Destroy terminates every created worker')
      let released = false; try { await fetch(restored) } catch { released = true }
      check(released, 'Destroy revokes the final page')
      proof.passed = true; proof.reads = reads; proof.cancelled = cancelled
      return proof
    },
  })
  proof.ready = true
} catch (error) { proof.failure = String(error); proof.ready = true }
