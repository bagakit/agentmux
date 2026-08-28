import { afterEach, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { RendererUpdates } from '../src/main/renderer-updates'
import { validateRendererRelease } from '../src/main/renderer-release'
import { topFrameNavigationGuard, topFrameOrigin } from '../src/main/top-frame-navigation'

const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'amx-update-')); roots.push(root)
  const bundled = join(root, 'bundled'), directory = join(root, 'updates')
  const identity = { shell: 'host-1', ctxmux: 'runtime-1' }
  const filesFor = (body: string) => ({ 'index.html': createHash('sha256').update(body).digest('hex') })
  const idFor = (body: string) => createHash('sha256').update(JSON.stringify({ identity, files: Object.entries(filesFor(body)).sort() })).digest('hex')
  const id = idFor('<div>New</div>')
  async function release(path: string, body: string) {
    await mkdir(path, { recursive: true })
    await writeFile(join(path, 'index.html'), body)
    await writeFile(join(path, 'release.json'), JSON.stringify({ schema: 1, id: idFor(body), identity, files: filesFor(body) }))
  }
  await release(bundled, '<div>Old</div>'); await release(join(directory, id), '<div>New</div>')
  const prepare = vi.fn(async () => {}), load = vi.fn(async (_path: string) => {})
  const owner = new RendererUpdates({ bundled, directory, prepare, load, report: vi.fn() })
  await owner.initialize()
  expect(load).toHaveBeenLastCalledWith(join(bundled, 'index.html'))
  load.mockClear()
  const pointer = (current: string | null, previous: string | null = null) => writeFile(join(directory, 'active.json'), JSON.stringify({ current, previous }))
  return { directory, bundled, identity, id, prepare, load, owner, pointer, release }
}
it('checkpoints before hot reload, keeps host owners alive and returns to the bundled frontend on rollback', async () => {
  const f = await fixture()
  await f.pointer(f.id); await f.owner.apply()
  expect(f.prepare).toHaveBeenCalledOnce()
  expect(JSON.parse(await readFile(join(f.directory, 'status.json'), 'utf8'))).toMatchObject({ outcome: 'applied', current: f.id })
  expect(f.load).toHaveBeenLastCalledWith(join(f.directory, f.id, 'index.html'))
  expect(f.prepare.mock.invocationCallOrder[0]).toBeLessThan(f.load.mock.invocationCallOrder[0]!)
  await f.owner.rollback()
  expect(f.load).toHaveBeenLastCalledWith(join(f.bundled, 'index.html'))
  expect(JSON.parse(await readFile(join(f.directory, 'active.json'), 'utf8')).current).toBeNull()
})
it('a frontend that fails readiness rolls back without accepting its version', async () => {
  const f = await fixture(); await f.pointer(f.id)
  f.load.mockRejectedValueOnce(new Error('not ready'))
  await expect(f.owner.apply()).rejects.toThrow('restored the previous interface')
  expect(f.load).toHaveBeenLastCalledWith(join(f.bundled, 'index.html'))
  expect(JSON.parse(await readFile(join(f.directory, 'active.json'), 'utf8')).current).toBeNull()
})
it('invalidates an active hot update when the bundled Renderer release changes', async () => {
  const f = await fixture()
  await f.pointer(f.id)
  await f.release(f.bundled, '<div>Bundled replacement</div>')
  const load = vi.fn(async (_path: string) => {})
  const owner = new RendererUpdates({ bundled: f.bundled, directory: f.directory, load, prepare: f.prepare, report: vi.fn() })
  await owner.initialize()
  expect(load).toHaveBeenLastCalledWith(join(f.bundled, 'index.html'))
  expect(JSON.parse(await readFile(join(f.directory, 'active.json'), 'utf8'))).toEqual({ current: null, previous: null })
  expect(JSON.parse(await readFile(join(f.directory, 'bundled.json'), 'utf8')).id).not.toBe(f.id)
})
it('keeps an active hot update across restart when the bundled release is unchanged', async () => {
  const f = await fixture()
  await f.pointer(f.id)
  const load = vi.fn(async (_path: string) => {})
  const owner = new RendererUpdates({ bundled: f.bundled, directory: f.directory, load, prepare: f.prepare, report: vi.fn() })
  await owner.initialize()
  load.mockClear()
  const restarted = new RendererUpdates({ bundled: f.bundled, directory: f.directory, load, prepare: f.prepare, report: vi.fn() })
  await restarted.initialize()
  expect(load).toHaveBeenLastCalledWith(join(f.directory, f.id, 'index.html'))
})
it('integrity, incompatible shell and symlinks are rejected before current UI is touched', async () => {
  const f = await fixture(); await f.pointer(f.id)
  const candidate = join(f.directory, f.id)
  await expect(validateRendererRelease(candidate, { ...f.identity, shell: 'another-host' })).rejects.toThrow('incompatible')
  await symlink(join(f.bundled, 'index.html'), join(candidate, 'extra'))
  await expect(f.owner.apply()).rejects.toThrow('symlinks')
  await rm(join(candidate, 'extra'))
  await writeFile(join(candidate, 'index.html'), 'corrupt')
  await f.pointer(f.id)
  await expect(f.owner.apply()).rejects.toThrow('integrity')
  expect(f.prepare).not.toHaveBeenCalled(); expect(f.load).not.toHaveBeenCalled()
})
it('failed checkpoint leaves the current page running', async () => {
  const f = await fixture(); await f.pointer(f.id)
  f.prepare.mockRejectedValueOnce(new Error('save in flight'))
  await expect(f.owner.apply()).rejects.toThrow('save in flight')
  expect(f.load).not.toHaveBeenCalled()
})
it('navigation trusts exactly the newly selected document, never all local files', () => {
  let origin = topFrameOrigin({ rendererDevServerUrl: undefined, packagedRendererFilePath: '/app/old/index.html' })
  const guard = topFrameNavigationGuard(() => origin)
  origin = topFrameOrigin({ rendererDevServerUrl: undefined, packagedRendererFilePath: '/updates/new/index.html' })
  const preventDefault = vi.fn()
  guard({ isMainFrame: true, url: 'file:///updates/new/index.html', preventDefault })
  expect(preventDefault).not.toHaveBeenCalled()
  guard({ isMainFrame: true, url: 'file:///tmp/other.html', preventDefault })
  expect(preventDefault).toHaveBeenCalledOnce()
})
it('actual store persistence retains drafts and dirty buffers, excluding clean files and Run-owned facts', async () => {
  vi.stubGlobal('__AGENTMUX_WEB_PREVIEW__', true)
  const { useAppStore } = await import('../src/renderer/src/store')
  const state = useAppStore.getState()
  const projection = useAppStore.persist.getOptions().partialize!({ ...state,
    agentComposerDrafts: { agent: 'unfinished message' },
    documents: { dirty: { path: 'a.ts', revision: 'base', content: 'unsaved' }, clean: { path: 'b.ts', revision: 'base', content: 'saved' } },
    dirtyDocuments: { dirty: true, clean: false }
  })
  expect(projection).toMatchObject({ agentComposerDrafts: { agent: 'unfinished message' }, documents: { dirty: { content: 'unsaved' } }, dirtyDocuments: { dirty: true } })
  expect(projection.documents).not.toHaveProperty('clean')
  expect(projection).not.toHaveProperty('sessions')
})
it('cold-start readiness failure restores the previous UI and records the working pointer', async () => {
  const f = await fixture(); await f.pointer(f.id)
  const load = vi.fn(async (file: string) => { if (file.includes(f.id)) throw new Error('startup broken') })
  const report = vi.fn()
  const owner = new RendererUpdates({ bundled: f.bundled, directory: f.directory, load, prepare: f.prepare, report })
  await owner.initialize()
  expect(load).toHaveBeenLastCalledWith(join(f.bundled, 'index.html'))
  expect(report).toHaveBeenCalledOnce()
  expect(JSON.parse(await readFile(join(f.directory, 'active.json'), 'utf8')).current).toBeNull()
  expect(f.prepare).not.toHaveBeenCalled()
})
it('rollback waits for the current switch instead of racing its load', async () => {
  const f = await fixture(); await f.pointer(f.id)
  let unblock!: () => void
  f.load.mockImplementationOnce(() => new Promise<void>((resolve) => { unblock = resolve }))
  const switching = f.owner.apply()
  await vi.waitFor(() => expect(f.load).toHaveBeenCalledOnce())
  const reverting = f.owner.rollback()
  await new Promise((resolve) => setTimeout(resolve, 10))
  expect(f.load).toHaveBeenCalledOnce()
  unblock(); await switching; await reverting
  expect(f.load).toHaveBeenLastCalledWith(join(f.bundled, 'index.html'))
  expect(JSON.parse(await readFile(join(f.directory, 'active.json'), 'utf8')).current).toBeNull()
})
