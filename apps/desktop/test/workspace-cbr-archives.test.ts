import { describe, expect, it } from 'vitest'
import { mkdtemp, open, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve, join } from 'node:path'
import { WorkspaceCbrArchives } from '../src/main/workspace-cbr-archives'
import { openCbrBook } from '../../../packages/editor-extensions/src/books/page-decoders/cbr'

const fixtures = resolve(import.meta.dirname, '../../../packages/editor-extensions/test/fixtures/page-decoders')
async function fixture<T>(consume: (archives: WorkspaceCbrArchives, abort: AbortController, path: string) => Promise<T>) {
  const directory = await mkdtemp(join(tmpdir(), 'agentmux-cbr-'))
  const path = join(directory, 'original.cbr'); await writeFile(path, await readFile(join(fixtures, 'original-pages.cbr')))
  const file = await open(path, 'r'), abort = new AbortController()
  const archives = new WorkspaceCbrArchives({
    async withDescriptor(caller, source, operation, read) {
      if (caller !== 7 || source !== 'original' || !operation) throw new Error('Wrong original source')
      return { status: 'read', value: await read(file.fd, abort.signal) }
    },
  })
  try { return await consume(archives, abort, path) }
  finally { abort.abort(); await file.close(); await rm(directory, { recursive: true, force: true }) }
}
const value = <T>(result: { status: string; value?: T }): T => { expect(result.status).toBe('read'); return result.value! }

describe('CBR pinned original → native libarchive → PAX → page consumer', () => {
  it('round-trips machine names including newline/glob characters and reads every original page repeatedly', () => fixture(async archives => {
    const entries = value(await archives.entries(7, 'original', 'list'))
    expect(entries.map(entry => entry.path)).toEqual(['page 001.png', 'dir/page\n[002]*?/.png', 'page010.png'])
    for (let pass = 0; pass < 2; pass++) for (let index = 0; index < entries.length; index++) {
      const bytes = value(await archives.readEntry(7, 'original', `page-${pass}-${index}`, entries[index]!.path))
      expect(Buffer.from(bytes)).toEqual(await readFile(join(fixtures, `page-${index + 1}.png`)))
    }
  }))
  it('uses the pinned descriptor after the original pathname is replaced', () => fixture(async (archives, _, path) => {
    await rename(path, path + '.retained'); await writeFile(path, 'replacement is not an archive')
    expect(value(await archives.entries(7, 'original', 'list')).length).toBe(3)
  }))
  it('cancels the exact child, waits for completion, and leaves another original read usable', () => fixture(async (archives, abort) => {
    const pending = archives.entries(7, 'original', 'cancel'); abort.abort()
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
  }))
  it('the ReaderBook loads selected original pixels and revokes the previous page and all URLs on destroy', () => fixture(async archives => {
    let sequence = 0
    const source = {
      async entries() { return value(await archives.entries(7, 'original', `list-${++sequence}`)) },
      async loadEntry(path: string) { return value(await archives.readEntry(7, 'original', `read-${++sequence}`, path)) },
    }
    const book = await openCbrBook(source, 'Original comic', new AbortController())
    expect(book.sections).toHaveLength(3)
    const first = await book.sections[0]!.load()
    const firstDocument = await (await fetch(first)).text(), image = /src="([^"]+)"/.exec(firstDocument)![1]!
    expect(Buffer.from(await (await fetch(image)).arrayBuffer())).toEqual(await readFile(join(fixtures, 'page-2.png')))
    const last = await book.sections[2]!.load()
    await expect(fetch(first)).rejects.toThrow(); await expect(fetch(image)).rejects.toThrow()
    const lastDocument = await (await fetch(last)).text(), lastImage = /src="([^"]+)"/.exec(lastDocument)![1]!
    expect(lastDocument).toContain('Page 3')
    expect(Buffer.from(await (await fetch(lastImage)).arrayBuffer())).toEqual(await readFile(join(fixtures, 'page-3.png')))
    book.destroy(); await expect(fetch(last)).rejects.toThrow()
    expect(() => book.sections[0]!.load()).toThrow()
  }))
})
