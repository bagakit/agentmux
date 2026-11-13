import { describe, expect, it } from 'vitest'
import { SourceFile } from '../../src/books/source-file'
import { BookResources } from '../../src/books/resources'
import { SectionResources } from '../../src/books/section-resources'
import { readerBook } from '../../src/books/normalize'

const tick = () => new Promise(resolve => setTimeout(resolve, 0))

describe('books byte and resource lifecycle', () => {
  it('slices the original source, preserves negative Blob offsets and sends the exact cancellation signal', async () => {
    const bytes = Uint8Array.from([0, 1, 2, 3, 4, 5]), calls: unknown[][] = [], controller = new AbortController()
    const file = new SourceFile({ size: bytes.length, async read(...args) { calls.push(args); return bytes.slice(args[0], args[0] + args[1]) } }, 'book.mobi', controller.signal)
    expect([...new Uint8Array(await file.slice(1, -1).slice(1, 3).arrayBuffer())]).toEqual([2, 3])
    expect(calls).toEqual([[2, 2, controller.signal]])
    controller.abort(); await expect(file.slice(0, 1).arrayBuffer()).rejects.toMatchObject({ name: 'AbortError' })
    expect(calls).toHaveLength(1)
  })

  it('keeps a shared image alive for an in-flight section and deduplicates the original resource read', async () => {
    const resources = new BookResources(), assets = new SectionResources<string, string>(resources)
    let resume!: () => void, calls = 0
    const create = async () => { calls++; await new Promise<void>(resolve => { resume = resolve }); return resources.createObjectURL(new Blob(['pixels'])) }
    const a = assets.load('image', 'A', create), b = assets.load('image', 'B', create)
    await tick(); assets.release('A'); resume()
    const [first, second] = await Promise.all([a, b])
    expect(first).toBe(second); expect(calls).toBe(1)
    expect(await (await fetch(second)).text()).toBe('pixels')
    assets.release('B'); await expect(fetch(second)).rejects.toThrow()
    assets.destroy(); resources.destroy()
  })

  it('breaks a cross-job dependency cycle while preserving shared asset lifetimes', async () => {
    const resources = new BookResources(), assets = new SectionResources<string, string>(resources)
    let beginX!: () => void, beginY!: () => void
    const xStarted = new Promise<void>(resolve => { beginX = resolve }), yStarted = new Promise<void>(resolve => { beginY = resolve })
    const x = () => assets.load('X', 'A', async () => {
      beginX(); await yStarted
      const child = await assets.load('Y', 'A', async () => { throw new Error('existing Y must be reused') }, 'X')
      return resources.createObjectURL(new Blob(['X:' + child]))
    })
    const y = () => assets.load('Y', 'B', async () => {
      beginY(); await xStarted
      const child = await assets.load('X', 'B', async () => { throw new Error('existing X must be reused') }, 'Y')
      return resources.createObjectURL(new Blob(['Y:' + child]))
    })
    const [one, two] = await Promise.all([x(), y()])
    expect(await (await fetch(one)).text()).toContain('X:')
    expect(await (await fetch(two)).text()).toContain('Y:')
    assets.release('B'); expect(await (await fetch(two)).text()).toContain('Y:')
    assets.release('A'); await expect(fetch(one)).rejects.toThrow(); await expect(fetch(two)).rejects.toThrow()
    assets.destroy(); resources.destroy()
  })

  it('reopens a section after an older in-flight load releases without revoking the new page', async () => {
    const resources = new BookResources(), controller = new AbortController()
    let resume!: () => void, firstCall = true
    let currentURL: string | undefined
    const raw = { sections: [{ id: 'one', unload() { if (currentURL) resources.revokeObjectURL(currentURL); currentURL = undefined }, async load() {
      if (firstCall) { firstCall = false; await new Promise<void>(resolve => { resume = resolve }) }
      currentURL = resources.createObjectURL(new Blob(['<p>chapter</p>'], { type: 'text/html' })); return currentURL
    } }] }
    const book = readerBook(raw, 'Book', resources, controller), section = book.sections[0]!
    const before = section.load(), beforeFailure = expect(before).rejects.toMatchObject({ name: 'AbortError' })
    await tick(); section.unload()
    const reopened = section.load(); resume()
    await beforeFailure
    const url = await reopened
    expect(await (await fetch(url)).text()).toContain('chapter')
    book.destroy(); await expect(fetch(url)).rejects.toThrow()
  })

  it('aborts close and refuses URL allocation after an unresolved section returns', async () => {
    const resources = new BookResources(), controller = new AbortController()
    let resume!: () => void
    const raw = { sections: [{ async load() { await new Promise<void>(resolve => { resume = resolve }); return resources.createObjectURL(new Blob(['late'])) } }] }
    const book = readerBook(raw, 'Book', resources, controller), pending = book.sections[0]!.load()
    const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    await tick(); book.destroy(); resume()
    await rejected; expect(controller.signal.aborted).toBe(true)
  })
})
