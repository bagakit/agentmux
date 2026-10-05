const { fixtureFileUrl: _hygiene_fixtureFileUrl, fixturePath: _hygiene_fixturePath } = await vi.hoisted(async () => await import("../scripts/lib/fixture-values.mjs"))
// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
const host = vi.hoisted(() => {
  const state = { config: { workspaces: [{ id: 'original', hostId: 'local', path: _hygiene_fixturePath("workspace") }] } }
  const listeners = new Set<(next: typeof state, previous: typeof state) => void>()
  return { state, listeners, read: vi.fn(), preview: vi.fn(), cancel: vi.fn(async () => {}),
    rebind(path: string) { const previous = { config: state.config }; state.config = { workspaces: [{ id: 'original', hostId: 'local', path }] }; for (const listener of listeners) listener(state, previous) } }
})
vi.mock('../src/renderer/src/lib/api', () => ({ api: { files: { read: host.read, readPreviewResource: (request: { kind: string }) => request.kind === 'data' ? host.read(request) : host.preview(request), cancelPreviewResource: host.cancel } } }))
vi.mock('../src/renderer/src/store', () => ({ useAppStore: { getState: () => host.state, subscribe: (listener: any) => { host.listeners.add(listener); return () => host.listeners.delete(listener) } } }))
import { chartResourcePath, createWorkspaceVegaLoader } from '../src/renderer/src/lib/file-formats/workspace-vega-loader'
beforeEach(() => {
  host.rebind(_hygiene_fixturePath("workspace")); host.read.mockReset(); host.preview.mockReset(); host.cancel.mockClear()
  vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:owned-image')
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
})
afterEach(() => { expect(host.listeners.size).toBe(0); vi.restoreAllMocks() })
describe('original Workspace Vega resource loader', () => {
  it('resolves relative resources and refuses external, encoded and escaping addresses before reading', async () => {
    expect(chartResourcePath('charts/spec.vega', '../data/points.csv')).toBe('data/points.csv')
    const loader = createWorkspaceVegaLoader('original', 'charts/spec.vega', new AbortController().signal)
    for (const uri of ['https://example.org/data', _hygiene_fixtureFileUrl("tmp/data"), '//server/data', '../../secret', '%2e%2e/%2e%2e/secret', '%2fetc/passwd', 'a%5cb', 'a%00b']) await expect(loader.load(uri)).rejects.toThrow()
    await expect(loader.http('https://example.org', {})).rejects.toThrow()
    await expect(loader.file(_hygiene_fixturePath("tmp/data"))).rejects.toThrow()
    expect(host.read).not.toHaveBeenCalled()
    host.read.mockResolvedValue({ kind: 'data', content: 'x,y\n1,2' })
    expect(await loader.load('../data/points.csv')).toBe('x,y\n1,2')
    expect(host.read).toHaveBeenCalledWith(expect.objectContaining({ id: expect.any(String), workspaceId: 'original', path: 'data/points.csv', kind: 'data' }))
    loader.dispose()
  })
  it('returns only authorized image bytes for Worker encoding, disallows navigation and ignores late bytes', async () => {
    const controller = new AbortController(), loader = createWorkspaceVegaLoader('original', 'spec.vega', controller.signal)
    host.preview.mockResolvedValue({ kind: 'image', mimeType: 'image/png', bytes: new Uint8Array([1, 2]) })
    expect(await loader.sanitize('image.png', { context: 'image' })).toEqual({ href: 'image.png', bytes: new Uint8Array([1, 2]), mimeType: 'image/png' })
    await expect(loader.sanitize('image.png', { context: 'href' })).rejects.toThrow(/navigation/)
    controller.abort()
    expect(URL.createObjectURL).not.toHaveBeenCalled()
    await expect(loader.load('data.csv')).rejects.toThrow(/cancelled/)
    loader.dispose()
    const second = new AbortController(), late = createWorkspaceVegaLoader('original', 'spec.vega', second.signal)
    let resolve!: (value: unknown) => void
    host.preview.mockImplementation(() => new Promise(yes => { resolve = yes }))
    const pending = late.sanitize('image.png', { context: 'image' }); second.abort()
    resolve({ kind: 'image', mimeType: 'image/png', bytes: new Uint8Array([3]) })
    await expect(pending).rejects.toThrow(/cancelled/)
    expect(URL.createObjectURL).not.toHaveBeenCalled()
    late.dispose()
  })
  it('presents the actual Main reason without Electron transport framing and permits a fresh retry', async () => {
    const loader = createWorkspaceVegaLoader('original', 'spec.vega', new AbortController().signal)
    host.read.mockRejectedValueOnce(new Error("Error invoking remote method 'files:readPreviewResource': Error: File content exceeds the read budget. Source was kept."))
    await expect(loader.load('data.csv')).rejects.toThrow(/^File content exceeds the read budget\. Source was kept\.$/)
    host.read.mockResolvedValueOnce({ kind: 'data', content: 'x,y\n1,2' })
    expect(await loader.load('data.csv')).toBe('x,y\n1,2')
    loader.dispose()
  })
  it('invalidates the original binding even when it changes away and back during a read', async () => {
    const loader = createWorkspaceVegaLoader('original', 'spec.vega', new AbortController().signal)
    let resolve!: (value: unknown) => void
    host.read.mockImplementation(() => new Promise(yes => { resolve = yes }))
    const pending = loader.load('data.csv')
    host.rebind(_hygiene_fixturePath("replacement")); host.rebind(_hygiene_fixturePath("workspace"))
    resolve({ kind: 'data', content: 'replacement' })
    await expect(pending).rejects.toThrow(/Workspace changed/)
    loader.dispose()
  })
})
