import { expect, it } from 'vitest'
import { pageBook } from '../src/books/page-decoders/page-book'

it('unloading an in-flight page aborts only its render and does not resurrect a stale page', async () => {
  let stopped = false
  const book = pageBook('Book', [{ id: 'one', size: 1 }, { id: 'two', size: 1 }], new AbortController(), async (index, signal) => {
    if (index === 1) return new Blob(['second'])
    await new Promise<void>((_, reject) => signal.addEventListener('abort', () => { stopped = true; reject(new DOMException('Cancelled', 'AbortError')) }, { once: true }))
    return new Blob(['first'])
  })
  const first = book.sections[0]!.load(); book.sections[0]!.unload()
  await expect(first).rejects.toMatchObject({ name: 'AbortError' }); expect(stopped).toBe(true)
  const second = await book.sections[1]!.load(); expect(await (await fetch(second)).text()).toContain('Page 2')
  book.destroy(); await expect(fetch(second)).rejects.toThrow()
})

it('returning to the resident page cancels a different pending page before it can revoke the current document', async () => {
  let resume!: () => void
  const book = pageBook('Book', [{ id: 'one', size: 1 }, { id: 'two', size: 1 }], new AbortController(), async (index, signal) => {
    if (index === 1) await new Promise<void>((resolve, reject) => { resume = resolve; signal.addEventListener('abort', () => reject(new DOMException('Cancelled', 'AbortError')), { once: true }) })
    return new Blob(['original pixels'])
  })
  const first = await book.sections[0]!.load(), second = book.sections[1]!.load()
  expect(await book.sections[0]!.load()).toBe(first)
  resume()
  await expect(second).rejects.toMatchObject({ name: 'AbortError' })
  expect(await (await fetch(first)).text()).toContain('Page 1')
  book.destroy()
})
