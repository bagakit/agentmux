import { afterEach, describe, expect, it, vi } from 'vitest'
import { request, type ClientRequest } from 'node:http'
import { HtmlFilePreviews } from '../src/main/html-file-previews.js'
import type { WorkspaceRecord } from '../src/shared/contracts.js'

type Read = { path: string; signal: AbortSignal | undefined; settled: boolean; finish: () => void }
type Reply = { status: number; body: string } | { error: Error }
const cleanups: Array<() => Promise<void>> = []

function fixture() {
  const workspace: WorkspaceRecord = { id: 'preview-workspace', name: 'Preview', hostId: 'local', path: new URL("preview-workspace", new URL('/', import.meta.url)).pathname, kind: 'folder' }
  const reads: Read[] = [], clients: ClientRequest[] = []
  const previews = new HtmlFilePreviews({ snapshotBytes: async (_workspace, path, options) => {
    const signal = options?.signal
    let finish!: () => void
    const pending = new Promise<void>((resolve, reject) => {
      finish = resolve
      signal?.addEventListener('abort', () => reject(signal.reason), { once: true })
      if (signal?.aborted) reject(signal.reason)
    })
    const read: Read = { path, signal, settled: false, finish }
    reads.push(read)
    try {
      await pending
      const bytes = Buffer.from(`original:${path}`)
      return { bytes, revision: 'original', totalBytes: bytes.length, offset: 0, nextOffset: null, returnedBytes: bytes.length, readCost: { payloadBytes: bytes.length } }
    } finally { read.settled = true }
  } }, id => id === workspace.id ? workspace : undefined)
  function client(url: URL | string, method = 'GET') {
    let req!: ClientRequest
    const result = new Promise<Reply>(resolve => {
      req = request(url, { method }, response => {
        const chunks: Buffer[] = []
        response.on('data', chunk => chunks.push(Buffer.from(chunk)))
        response.on('end', () => resolve({ status: response.statusCode!, body: Buffer.concat(chunks).toString('utf8') }))
        response.on('error', error => resolve({ error }))
      })
      req.on('error', error => resolve({ error }))
      req.end()
    })
    clients.push(req)
    return { request: req, result }
  }
  cleanups.push(async () => {
    for (const client of clients) client.destroy()
    // Finish controlled leaves even when a source mutation deliberately removes cancellation.
    for (const read of reads) read.finish()
    await previews.dispose()
  })
  return { workspace, previews, reads, client }
}

afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup() })

describe('HTML preview read ownership over real HTTP connections', () => {
  it.each(['release', 'releaseAll', 'dispose'] as const)('cancels pending GET and HEAD reads when their lease ends through %s', async action => {
    const f = fixture(), opened = await f.previews.open(f.workspace, 'index.html', '<h1>Original draft</h1>')
    const get = f.client(new URL('image.png', opened.url)), head = f.client(new URL('theme.css', opened.url), 'HEAD')
    await vi.waitFor(() => expect(f.reads.map(read => read.path).sort()).toEqual(['image.png', 'theme.css']))
    expect(f.reads.map(read => read.signal?.aborted)).toEqual([false, false])
    if (action === 'release') f.previews.release(opened.id)
    else if (action === 'releaseAll') f.previews.releaseAll()
    else await f.previews.dispose()
    expect(f.reads.map(read => read.signal?.aborted)).toEqual([true, true])
    await vi.waitFor(() => expect(f.reads.map(read => read.settled)).toEqual([true, true]))
    const replies = await Promise.all([get.result, head.result])
    if (action === 'dispose') {
      expect(replies).toHaveLength(2)
      for (const reply of replies) expect('error' in reply || reply.status === 410).toBe(true)
    } else {
      expect(replies).toEqual([{ status: 410, body: expect.not.stringContaining('original:') }, { status: 410, body: '' }])
      const retry = await f.previews.open(f.workspace, 'index.html', '<h1>New draft</h1>')
      expect(await f.client(retry.url).result).toEqual({ status: 200, body: '<h1>New draft</h1>' })
    }
  })

  it('cancels only the disconnected response while its same-lease sibling and subsequent reads stay usable', async () => {
    const f = fixture(), opened = await f.previews.open(f.workspace, 'index.html', '<h1>Original draft</h1>')
    const departed = f.client(new URL('departed.png', opened.url)), sibling = f.client(new URL('sibling.css', opened.url))
    await vi.waitFor(() => expect(f.reads.map(read => read.path).sort()).toEqual(['departed.png', 'sibling.css']))
    const original = f.reads.find(read => read.path === 'departed.png')!, survivor = f.reads.find(read => read.path === 'sibling.css')!
    expect([original.signal?.aborted, survivor.signal?.aborted]).toEqual([false, false])
    departed.request.destroy()
    await vi.waitFor(() => expect([original.signal?.aborted, original.settled]).toEqual([true, true]))
    expect(survivor.signal?.aborted).toBe(false)
    survivor.finish()
    expect(await sibling.result).toEqual({ status: 200, body: 'original:sibling.css' })
    const retry = f.client(new URL('departed.png', opened.url))
    await vi.waitFor(() => expect(f.reads).toHaveLength(3))
    expect(f.reads[2]!.signal?.aborted).toBe(false)
    f.reads[2]!.finish()
    expect(await retry.result).toEqual({ status: 200, body: 'original:departed.png' })
    expect(await f.client(opened.url).result).toEqual({ status: 200, body: '<h1>Original draft</h1>' })
    expect(f.reads.map(read => read.settled)).toEqual([true, true, true])
  })

  it('releasing one lease leaves another exact lease and its pending asset intact', async () => {
    const f = fixture()
    const first = await f.previews.open(f.workspace, 'index.html', 'first draft'), second = await f.previews.open(f.workspace, 'index.html', 'second draft')
    const ended = f.client(new URL('first.css', first.url)), retained = f.client(new URL('second.css', second.url))
    await vi.waitFor(() => expect(f.reads.map(read => read.path).sort()).toEqual(['first.css', 'second.css']))
    f.previews.release(first.id)
    expect(f.reads.map(read => read.signal?.aborted)).toEqual([true, false])
    expect(await ended.result).toEqual({ status: 410, body: expect.not.stringContaining('original:') })
    f.reads[1]!.finish()
    expect(await retained.result).toEqual({ status: 200, body: 'original:second.css' })
    expect(await f.client(second.url).result).toEqual({ status: 200, body: 'second draft' })
  })
})
