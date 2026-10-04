import { fixturePath as _hygiene_fixturePath } from "../scripts/lib/fixture-values.mjs"
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, readFile, rm, symlink, truncate, writeFile } from 'node:fs/promises'
import { request } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LocalExecutionHost, type ExecutionHost } from '@agentmux/core'
import { HtmlFilePreviews } from '../src/main/html-file-previews.js'
import { WorkspaceFiles } from '../src/main/workspace-files.js'
import type { WorkspaceRecord } from '../src/shared/contracts.js'
import { WORKSPACE_FILE_MAX_BYTES } from '../src/shared/workspace-file-bytes.js'

const roots: string[] = []
const owners: HtmlFilePreviews[] = []
const saved = '<h1>Saved document</h1>'
const draft = '<link rel="stylesheet" href="../theme.css"><h1>Unsaved 草稿</h1><script>window.inlineRan=true</script><script type="module" src="./app.mjs"></script><img src="../image.png">'

async function fixture() {
  const base = await mkdtemp(join(tmpdir(), 'agentmux-html-preview-'))
  roots.push(base)
  const root = join(base, 'workspace')
  await mkdir(join(root, 'pages'), { recursive: true })
  const workspace: WorkspaceRecord = { id: 'workspace', name: 'HTML', hostId: 'local', path: root, kind: 'folder' }
  let current: WorkspaceRecord | undefined = workspace
  const files = new WorkspaceFiles(() => new LocalExecutionHost())
  const previews = new HtmlFilePreviews(files, id => current?.id === id ? current : undefined)
  owners.push(previews)
  await writeFile(join(root, 'pages/index.html'), saved)
  return { base, root, workspace, files, previews, setWorkspace: (next: WorkspaceRecord | undefined) => { current = next } }
}

function barrier() {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}

function rawGet(origin: string, path: string, host?: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request(origin, { path, headers: host ? { Host: host } : {} }, response => {
      const chunks: Buffer[] = []
      response.on('data', chunk => chunks.push(Buffer.from(chunk)))
      response.on('end', () => resolve({ status: response.statusCode!, body: Buffer.concat(chunks).toString('utf8') }))
    })
    req.on('error', reject)
    req.end()
  })
}

afterEach(async () => {
  await Promise.all(owners.splice(0).map(owner => owner.dispose()))
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
  vi.restoreAllMocks()
})

describe('editor HTML preview resources', () => {
  it('serves the current Unicode draft without saving, and reads relative CSS, modules and image bytes through WorkspaceFiles', async () => {
    const f = await fixture(), snapshot = vi.spyOn(f.files, 'snapshotBytes')
    const filename = 'pages/草稿 #?.html'
    await writeFile(join(f.root, filename), saved)
    await writeFile(join(f.root, 'theme.css'), 'h1 { color: rebeccapurple; }')
    await writeFile(join(f.root, 'pages/app.mjs'), 'import "./dependency.js"; window.moduleRan=true')
    await writeFile(join(f.root, 'pages/dependency.js'), 'export const loaded=true')
    const png = Buffer.from([137, 80, 78, 71, 0, 255, 128])
    await writeFile(join(f.root, 'image.png'), png)
    const opened = await f.previews.open(f.workspace, filename, draft)
    expect(opened.id).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(new URL(opened.url).hostname).toBe('127.0.0.1')
    expect(opened.url).toContain('/%E8%8D%89%E7%A8%BF%20%23%3F.html')
    const page = await fetch(opened.url)
    expect(page.status).toBe(200)
    expect(page.headers.get('content-type')).toBe('text/html; charset=utf-8')
    expect(page.headers.get('content-length')).toBe(String(Buffer.byteLength(draft)))
    expect(await page.text()).toBe(draft)
    expect(snapshot).not.toHaveBeenCalled()
    expect(await readFile(join(f.root, filename), 'utf8')).toBe(saved)

    const css = await fetch(new URL('../theme.css?cache=1', opened.url))
    expect(css.status).toBe(200)
    expect(css.headers.get('content-type')).toBe('text/css; charset=utf-8')
    expect(await css.text()).toBe('h1 { color: rebeccapurple; }')
    const module = await fetch(new URL('./app.mjs', opened.url))
    expect(module.headers.get('content-type')).toBe('text/javascript; charset=utf-8')
    expect(module.headers.get('access-control-allow-origin')).toBe('*')
    expect(await module.text()).toBe('import "./dependency.js"; window.moduleRan=true')
    const dependency = await fetch(new URL('./dependency.js', opened.url))
    expect(dependency.headers.get('content-type')).toBe('text/javascript; charset=utf-8')
    expect(await dependency.text()).toBe('export const loaded=true')
    const image = await fetch(new URL('../image.png', opened.url))
    expect(image.headers.get('content-type')).toBe('image/png')
    expect(Buffer.from(await image.arrayBuffer())).toEqual(png)
    expect(snapshot.mock.calls.map(([, path]) => path)).toEqual(['theme.css', 'pages/app.mjs', 'pages/dependency.js', 'image.png'])
    for (const [workspace] of snapshot.mock.calls) expect(workspace).toEqual(f.workspace)
    expect(await readFile(join(f.root, 'image.png'))).toEqual(png)

    const head = await fetch(opened.url, { method: 'HEAD' })
    expect(head.status).toBe(200)
    expect(head.headers.get('content-length')).toBe(String(Buffer.byteLength(draft)))
    expect(await head.text()).toBe('')
    const assetHead = await fetch(new URL('../theme.css', opened.url), { method: 'HEAD' })
    expect(assetHead.headers.get('content-type')).toBe('text/css; charset=utf-8')
    expect(await assetHead.text()).toBe('')
  })

  it('applies opaque sandbox and read-only response policies even when a document URL is opened directly', async () => {
    const f = await fixture(), opened = await f.previews.open(f.workspace, 'pages/index.html', draft)
    const response = await fetch(opened.url)
    const csp = response.headers.get('content-security-policy')!
    expect(csp).toContain('sandbox allow-scripts;')
    expect(csp).not.toContain('allow-same-origin')
    expect(csp).not.toContain('allow-top-navigation')
    expect(csp).not.toContain('allow-popups')
    for (const directive of ["frame-src 'none'", "object-src 'none'", "form-action 'none'", "base-uri 'none'"]) expect(csp).toContain(directive)
    expect(csp).toContain("script-src 'unsafe-inline' http: https:")
    expect(csp).toContain("style-src 'unsafe-inline' http: https:")
    expect(csp).toContain('img-src http: https: data: blob:')
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(response.headers.get('referrer-policy')).toBe('no-referrer')
    expect(response.headers.get('x-content-type-options')).toBe('nosniff')
    await response.arrayBuffer()
  })

  it('shares one loopback listener while keeping unknown, malformed and released token paths unreadable', async () => {
    const f = await fixture(), snapshot = vi.spyOn(f.files, 'snapshotBytes')
    const [first, second] = await Promise.all([
      f.previews.open(f.workspace, 'pages/index.html', 'first draft'),
      f.previews.open(f.workspace, 'pages/index.html', 'second draft')
    ])
    const origin = new URL(first.url).origin
    expect(new URL(second.url).origin).toBe(origin)
    expect(first.id).not.toBe(second.id)
    const invalidPaths = [
      '/pages/index.html', '/unknown/pages/index.html', `/unknown/../${first.id}/pages/index.html`,
      `/${first.id}/../../outside.txt`, `/${first.id}/%2e%2e/outside.txt`, `/${first.id}/%2Foutside.txt`,
      `/${first.id}/..%5Coutside.txt`, `/${first.id}/%00outside.txt`, `/${first.id}/%zz`, `/${first.id}/`
    ]
    expect(invalidPaths.length).toBeGreaterThan(0)
    for (const path of invalidPaths) expect(await rawGet(origin, path)).toMatchObject({ status: 404 })
    expect(await rawGet(origin, new URL(first.url).pathname, 'unrelated.example')).toMatchObject({ status: 404 })
    f.previews.release(first.id)
    expect((await fetch(first.url)).status).toBe(404)
    expect((await fetch(new URL('../private.txt', first.url))).status).toBe(404)
    expect(await (await fetch(second.url)).text()).toBe('second draft')
    expect(snapshot).not.toHaveBeenCalled()
  })

  it('refuses all mutating HTTP methods without reading or changing their asset', async () => {
    const f = await fixture(), snapshot = vi.spyOn(f.files, 'snapshotBytes')
    await writeFile(join(f.root, 'theme.css'), 'original')
    const opened = await f.previews.open(f.workspace, 'pages/index.html', draft)
    const methods = ['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']
    expect(methods.length).toBeGreaterThan(0)
    for (const method of methods) {
      const response = await fetch(new URL('../theme.css', opened.url), { method, body: 'must not write' })
      expect(response.status).toBe(405)
      expect(response.headers.get('allow')).toBe('GET, HEAD')
      expect(await response.text()).toContain('read-only')
    }
    expect(snapshot).not.toHaveBeenCalled()
    expect(await readFile(join(f.root, 'theme.css'), 'utf8')).toBe('original')
  })

  it('uses strict real-file confinement for outside symlinks, while preserving inside links and safe unknown MIME', async () => {
    const f = await fixture(), opened = await f.previews.open(f.workspace, 'pages/index.html', draft)
    await writeFile(join(f.base, 'outside.txt'), 'outside secret')
    await symlink(join(f.base, 'outside.txt'), join(f.root, 'outside-link.txt'))
    await writeFile(join(f.root, 'theme.css'), 'inside stylesheet')
    await symlink(join(f.root, 'theme.css'), join(f.root, 'inside.css'))
    const outside = await fetch(new URL('../outside-link.txt', opened.url))
    expect(outside.status).toBe(404)
    expect(await outside.text()).not.toContain('outside secret')
    const inside = await fetch(new URL('../inside.css', opened.url))
    expect(inside.status).toBe(200)
    expect(await inside.text()).toBe('inside stylesheet')
    await writeFile(join(f.root, 'unknown.custom'), '<script>must not be sniffed</script>')
    const unknown = await fetch(new URL('../unknown.custom', opened.url))
    expect(unknown.headers.get('content-type')).toBe('application/octet-stream')
    expect(unknown.headers.get('x-content-type-options')).toBe('nosniff')
    expect(await unknown.text()).toBe('<script>must not be sniffed</script>')
    expect(await readFile(join(f.base, 'outside.txt'), 'utf8')).toBe('outside secret')
  })

  it('bounds each draft and complete asset snapshot without taking away the original source or another preview', async () => {
    const f = await fixture(), opened = await f.previews.open(f.workspace, 'pages/index.html', draft)
    await expect(f.previews.open(f.workspace, 'pages/index.html', '字'.repeat(Math.floor(WORKSPACE_FILE_MAX_BYTES / 3) + 1))).rejects.toThrow('16 MiB')
    expect(await (await fetch(opened.url)).text()).toBe(draft)
    const maximum = await f.previews.open(f.workspace, 'pages/index.html', 'a'.repeat(WORKSPACE_FILE_MAX_BYTES))
    const head = await fetch(maximum.url, { method: 'HEAD' })
    expect(head.status).toBe(200)
    expect(head.headers.get('content-length')).toBe(String(WORKSPACE_FILE_MAX_BYTES))
    await writeFile(join(f.root, 'large.png'), '')
    await truncate(join(f.root, 'large.png'), WORKSPACE_FILE_MAX_BYTES + 1)
    const large = await fetch(new URL('../large.png', opened.url))
    expect(large.status).toBe(413)
    expect(await large.text()).toContain('16 MiB')
    await writeFile(join(f.root, 'empty.css'), '')
    const empty = await fetch(new URL('../empty.css', opened.url))
    expect(empty.status).toBe(200)
    expect(await empty.text()).toBe('')
    expect(await readFile(join(f.root, 'pages/index.html'), 'utf8')).toBe(saved)
  })

  it('does not serve partial or oversized bytes from a snapshot port', async () => {
    const f = await fixture(), opened = await f.previews.open(f.workspace, 'pages/index.html', draft)
    await writeFile(join(f.root, 'theme.css'), 'complete')
    const actual = await f.files.snapshotBytes(f.workspace, 'theme.css')
    const snapshot = vi.spyOn(f.files, 'snapshotBytes')
    snapshot.mockResolvedValueOnce({ ...actual, bytes: actual.bytes.subarray(0, 2), returnedBytes: 2, nextOffset: 2 })
    const partial = await fetch(new URL('../theme.css', opened.url))
    expect(partial.status).toBe(422)
    expect(await partial.text()).not.toBe('co')
    snapshot.mockResolvedValueOnce({ ...actual, totalBytes: WORKSPACE_FILE_MAX_BYTES + 1 })
    const oversized = await fetch(new URL('../theme.css', opened.url))
    expect(oversized.status).toBe(413)
    await oversized.arrayBuffer()
    const retry = await fetch(new URL('../theme.css', opened.url))
    expect(retry.status).toBe(200)
    expect(await retry.text()).toBe('complete')
  })

  it('renders remote current buffers without inventing a remote binary transport', async () => {
    const f = await fixture(), run = vi.fn()
    const remote: WorkspaceRecord = { ...f.workspace, hostId: 'remote' }
    const host = { id: 'remote', kind: 'ssh', run } as unknown as ExecutionHost
    const files = new WorkspaceFiles(() => host)
    const previews = new HtmlFilePreviews(files, () => remote)
    owners.push(previews)
    const opened = await previews.open(remote, 'pages/index.html', '<h1>Remote draft</h1>')
    expect(await (await fetch(opened.url)).text()).toBe('<h1>Remote draft</h1>')
    const asset = await fetch(new URL('../theme.css', opened.url))
    expect(asset.status).toBe(404)
    await asset.arrayBuffer()
    expect(run).not.toHaveBeenCalled()
    expect(await readFile(join(f.root, 'pages/index.html'), 'utf8')).toBe(saved)
  })

  it.each(['path', 'hostId', 'removed'] as const)('does not leak late asset bytes when its original Workspace %s changes', async change => {
    const f = await fixture(), started = barrier(), finish = barrier()
    await writeFile(join(f.root, 'theme.css'), 'old resource secret')
    const actual = f.files.snapshotBytes.bind(f.files)
    const snapshot = vi.spyOn(f.files, 'snapshotBytes').mockImplementation(async (...args) => {
      const bytes = await actual(...args)
      started.resolve()
      await finish.promise
      return bytes
    })
    const opened = await f.previews.open(f.workspace, 'pages/index.html', draft)
    const pending = fetch(new URL('../theme.css', opened.url))
    await started.promise
    if (change === 'removed') f.setWorkspace(undefined)
    else f.workspace[change] = change === 'path' ? join(f.base, 'replacement') : 'another-host'
    finish.resolve()
    const response = await pending
    expect(response.status).toBe(410)
    expect(await response.text()).not.toContain('old resource secret')
    expect(snapshot.mock.calls[0]![0].path).toBe(f.root)
    expect(snapshot.mock.calls[0]![0].hostId).toBe('local')
    const staleDocument = await fetch(opened.url)
    expect(staleDocument.status).toBe(410)
    expect(await staleDocument.text()).not.toContain('Unsaved 草稿')
  })

  it('releases an in-flight read without allowing its late bytes to revive the preview', async () => {
    const f = await fixture(), started = barrier(), finish = barrier()
    await writeFile(join(f.root, 'theme.css'), 'released secret')
    const actual = f.files.snapshotBytes.bind(f.files)
    vi.spyOn(f.files, 'snapshotBytes').mockImplementation(async (...args) => {
      const bytes = await actual(...args)
      started.resolve()
      await finish.promise
      return bytes
    })
    const opened = await f.previews.open(f.workspace, 'pages/index.html', draft)
    const pending = fetch(new URL('../theme.css', opened.url))
    await started.promise
    f.previews.release(opened.id)
    finish.resolve()
    const response = await pending
    expect(response.status).toBe(410)
    expect(await response.text()).not.toContain('released secret')
    expect((await fetch(opened.url)).status).toBe(404)
    const retry = await f.previews.open(f.workspace, 'pages/index.html', 'retry draft')
    expect(retry.id).not.toBe(opened.id)
    expect(await (await fetch(retry.url)).text()).toBe('retry draft')
  })

  it('refuses invalid opens and stale resources without disabling valid retry', async () => {
    const f = await fixture()
    for (const path of ['', '.', '..', '../outside.html', _hygiene_fixturePath("outside.html"), 'pages/..', 'pages/\\outside.html']) {
      await expect(f.previews.open(f.workspace, path, draft)).rejects.toThrow()
    }
    f.setWorkspace(undefined)
    await expect(f.previews.open(f.workspace, 'pages/index.html', draft)).rejects.toThrow('resource changed')
    f.setWorkspace({ ...f.workspace, name: 'Renamed project' })
    const retry = await f.previews.open(f.workspace, 'pages/index.html', draft)
    expect(await (await fetch(retry.url)).text()).toBe(draft)
  })

  it('releases every Renderer lease and pending open, while allowing the next Renderer to retry', async () => {
    const f = await fixture()
    const first = await f.previews.open(f.workspace, 'pages/index.html', 'first draft')
    const second = await f.previews.open(f.workspace, 'pages/index.html', 'second draft')
    const pending = f.previews.open(f.workspace, 'pages/index.html', 'late draft')
    const rejected = expect(pending).rejects.toThrow('released')
    f.previews.releaseAll()
    await rejected
    expect((await fetch(first.url)).status).toBe(404)
    expect((await fetch(second.url)).status).toBe(404)
    const retry = await f.previews.open(f.workspace, 'pages/index.html', 'new Renderer')
    expect(new URL(retry.url).origin).toBe(new URL(first.url).origin)
    expect(await (await fetch(retry.url)).text()).toBe('new Renderer')

    const lazy = new HtmlFilePreviews(f.files, () => f.workspace)
    owners.push(lazy)
    const starting = Promise.all([
      lazy.open(f.workspace, 'pages/index.html', 'pending one'),
      lazy.open(f.workspace, 'pages/index.html', 'pending two')
    ])
    const startupRejected = expect(starting).rejects.toThrow('released')
    lazy.releaseAll()
    await startupRejected
    const fresh = await lazy.open(f.workspace, 'pages/index.html', 'fresh after startup')
    expect(await (await fetch(fresh.url)).text()).toBe('fresh after startup')
  })

  it('closes its listener, clears all leases, and handles disposal during lazy startup', async () => {
    const f = await fixture(), opened = await f.previews.open(f.workspace, 'pages/index.html', draft)
    await (await fetch(opened.url)).arrayBuffer()
    await f.previews.dispose()
    await expect(fetch(opened.url)).rejects.toThrow()
    await expect(f.previews.open(f.workspace, 'pages/index.html', draft)).rejects.toThrow('closed')
    const other = new HtmlFilePreviews(f.files, () => f.workspace)
    owners.push(other)
    const starting = other.open(f.workspace, 'pages/index.html', draft)
    const rejected = expect(starting).rejects.toThrow()
    await other.dispose()
    await rejected
  })
})
