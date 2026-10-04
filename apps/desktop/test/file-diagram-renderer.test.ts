const { fixturePath: _hygiene_fixturePath } = await vi.hoisted(async () => await import("../scripts/lib/fixture-values.mjs"))
const { fixtureFileUrl: _hygiene_fixtureFileUrl } = await vi.hoisted(async () => await import("../scripts/lib/fixture-values.mjs"))
import { beforeEach, describe, expect, it, vi } from 'vitest'
const fixtures = vi.hoisted(() => ({ windows: [] as any[], renders: [] as { window: any; code: string; resolve(value: unknown): void }[], render: null as null | ((value: unknown) => void), peakWindows: 0 }))
vi.mock('electron', () => ({ BrowserWindow: class {
  listeners = new Map<string, () => void>()
  dead = false
  destroy = vi.fn(() => { this.dead = true; this.listeners.get('closed')?.() })
  isDestroyed = () => this.dead
  once = (name: string, callback: () => void) => { this.listeners.set(name, callback) }
  loadFile = vi.fn(async () => {})
  loadURL = vi.fn(async () => {})
  webContents = { session: { setPermissionRequestHandler: vi.fn(), setPermissionCheckHandler: vi.fn(), webRequest: { onBeforeRequest: vi.fn() } },
    setWindowOpenHandler: vi.fn(), on: vi.fn(), once: vi.fn(), executeJavaScript: vi.fn((code: string) => new Promise(resolve => { fixtures.render = resolve; fixtures.renders.push({ window: this, code, resolve }) })) }
  constructor(public options: any) { fixtures.windows.push(this); fixtures.peakWindows = Math.max(fixtures.peakWindows, fixtures.windows.filter(window => !window.dead).length) }
} }))
import { FileDiagramRenderer } from '../src/main/file-diagram-renderer'
const request = (id: string) => ({ id, kind: 'mermaid' as const, content: 'graph LR\n A-->B', theme: 'dark' as const })
beforeEach(() => { fixtures.windows.length = 0; fixtures.renders.length = 0; fixtures.render = null; fixtures.peakWindows = 0 })
describe('isolated file diagram owner', () => {
  it('destroys the exact sandbox on successful render and never gives it a preload', async () => {
    const owner = new FileDiagramRenderer({ rendererFile: _hygiene_fixturePath("app/renderer/file-diagram/index.html") })
    const result = owner.render(request('one'))
    await vi.waitFor(() => expect(fixtures.render).toBeTypeOf('function'))
    const window = fixtures.windows[0]
    expect(window.options.webPreferences).toMatchObject({ sandbox: true, contextIsolation: true, nodeIntegration: false })
    expect(window.options.webPreferences.preload).toBeUndefined()
    expect(window.options.webPreferences.partition).toMatch(/^diagram-/)
    fixtures.render!({ id: 'one', svg: '<svg />' })
    expect(await result).toEqual({ id: 'one', svg: '<svg />' })
    expect(window.destroy).toHaveBeenCalledOnce()
    owner.dispose()
  })
  it('cancel and dispose destroy pending jobs, reject id collision and fence late execution', async () => {
    const owner = new FileDiagramRenderer()
    const first = owner.render(request('first'))
    await expect(owner.render(request('first'))).rejects.toThrow('unique')
    const second = owner.render(request('second'))
    owner.cancel('first')
    expect(fixtures.windows[0].destroy).toHaveBeenCalledOnce()
    expect(fixtures.windows[1].destroy).not.toHaveBeenCalled()
    expect((await first).error).toMatch(/cancelled/)
    owner.dispose()
    expect(fixtures.windows[1].destroy).toHaveBeenCalledOnce()
    expect((await second).error).toMatch(/cancelled/)
    await expect(owner.render(request('closed'))).rejects.toThrow('closed')
  })
  it('blocks external and workspace URLs while allowing only packaged renderer resources', async () => {
    const owner = new FileDiagramRenderer({ rendererFile: _hygiene_fixturePath("app/renderer/file-diagram/index.html") })
    const result = owner.render(request('resources'))
    const intercept = fixtures.windows[0].webContents.session.webRequest.onBeforeRequest.mock.calls[0][0]
    for (const [url, cancel] of [['https://example.com/a.js', true], [_hygiene_fixtureFileUrl("workspace/private.txt"), true], [_hygiene_fixtureFileUrl("app/renderer/assets/a.js"), false]]) {
      const callback = vi.fn(); intercept({ url }, callback); expect(callback).toHaveBeenCalledWith({ cancel })
    }
    owner.dispose(); await result
  })
  it('bounds concurrent windows and starts queued requests FIFO only after exact owner destruction', async () => {
    const owner = new FileDiagramRenderer()
    const jobs = ['one', 'two', 'three', 'four', 'five'].map(id => owner.render(request(id)))
    expect(fixtures.windows).toHaveLength(2)
    await expect(owner.render(request('three'))).rejects.toThrow('unique')
    let cancelled: { error?: string } | undefined
    void jobs[2].then(result => { cancelled = result })
    owner.cancel('three')
    await Promise.resolve()
    expect(cancelled).toEqual(expect.objectContaining({ error: expect.stringMatching(/cancelled/) }))
    expect(fixtures.windows).toHaveLength(2)
    await vi.waitFor(() => expect(fixtures.renders).toHaveLength(2))
    fixtures.renders[0].resolve({ id: 'one', svg: '<svg />' })
    await jobs[0]
    await vi.waitFor(() => expect(fixtures.renders).toHaveLength(3))
    expect(fixtures.renders[2].code).toContain('"id":"four"')
    expect(fixtures.windows[0].dead).toBe(true)
    owner.cancel('two')
    await vi.waitFor(() => expect(fixtures.renders).toHaveLength(4))
    expect(fixtures.renders[3].code).toContain('"id":"five"')
    expect(fixtures.windows[1].dead).toBe(true)
    // The cancelled active owner's delayed computation cannot retire another slot.
    fixtures.renders[1].resolve({ id: 'two', svg: '<svg>late</svg>' })
    await Promise.resolve()
    expect(fixtures.windows[2].dead).toBe(false)
    expect(fixtures.windows[3].dead).toBe(false)
    expect(fixtures.peakWindows).toBe(2)
    owner.dispose()
    expect((await Promise.all(jobs)).filter(result => result.error)).toHaveLength(4)
    expect(fixtures.windows.every(window => window.dead)).toBe(true)
  })
  it('cancelAll removes queued jobs without starting windows, remains reusable, and dispose closes all future work', async () => {
    const owner = new FileDiagramRenderer()
    const first = Array.from({ length: 8 }, (_, index) => owner.render(request(`first-${index}`)))
    expect(fixtures.windows).toHaveLength(2)
    owner.cancelAll()
    expect(fixtures.windows).toHaveLength(2)
    expect((await Promise.all(first)).every(result => result.error?.includes('cancelled'))).toBe(true)
    expect(fixtures.windows.every(window => window.dead)).toBe(true)
    const next = Array.from({ length: 8 }, (_, index) => owner.render(request(`next-${index}`)))
    expect(fixtures.windows).toHaveLength(4)
    owner.dispose()
    expect(fixtures.windows).toHaveLength(4)
    expect((await Promise.all(next)).every(result => result.error?.includes('cancelled'))).toBe(true)
    expect(fixtures.windows.every(window => window.dead)).toBe(true)
    expect(fixtures.peakWindows).toBe(2)
    await expect(owner.render(request('closed'))).rejects.toThrow('closed')
  })
  it('a renderer crash releases its slot to the next request and remains cancelable', async () => {
    const owner = new FileDiagramRenderer()
    const jobs = ['crash', 'second', 'queued'].map(id => owner.render(request(id)))
    const crash = fixtures.windows[0].webContents.once.mock.calls.find(([name]: [string]) => name === 'render-process-gone')![1]
    crash()
    expect((await jobs[0]).error).toMatch(/renderer stopped/)
    await vi.waitFor(() => expect(fixtures.renders).toHaveLength(2))
    expect(fixtures.renders.map(render => render.code).join('\n')).toContain('"id":"queued"')
    expect(fixtures.windows[0].dead).toBe(true)
    expect(fixtures.peakWindows).toBe(2)
    owner.dispose()
    await Promise.all(jobs)
  })
})
