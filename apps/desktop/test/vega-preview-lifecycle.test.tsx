const { fixturePath: _hygiene_fixturePath } = await vi.hoisted(async () => await import("../scripts/lib/fixture-values.mjs"))
// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { VegaFilePreview } from '../src/renderer/src/components/file-preview/VegaFilePreview'
import type { ChartSnapshot } from '../src/renderer/src/lib/file-formats/vega-chart-protocol'
import { previewVisibility } from './helpers/preview-visibility'

const ports = vi.hoisted(() => ({
  workspace: { id: 'w', hostId: 'local', path: _hygiene_fixturePath("workspace") },
  jobs: [] as Array<{ content: string; signal: AbortSignal; callbacks: { snapshot(value: ChartSnapshot): void; error(error: Error): void }; dispose: ReturnType<typeof vi.fn>; event: ReturnType<typeof vi.fn>; setSignal: ReturnType<typeof vi.fn>; resize: ReturnType<typeof vi.fn> }>,
  loaders: [] as Array<{ dispose: ReturnType<typeof vi.fn> }>
}))
vi.mock('../src/renderer/src/store', () => ({ useAppStore: (selector: (state: unknown) => unknown) => selector({ config: { workspaces: [ports.workspace] } }) }))
vi.mock('../src/renderer/src/lib/file-formats/vega-worker', () => ({ createVegaPreview: (content: string, _mode: string, _loader: unknown, signal: AbortSignal, callbacks: any) => {
  const job = { content, signal, callbacks, dispose: vi.fn(), event: vi.fn(), setSignal: vi.fn(), resize: vi.fn() }; ports.jobs.push(job); return job
} }))
vi.mock('../src/renderer/src/lib/file-formats/workspace-vega-loader', () => ({ createWorkspaceVegaLoader: () => {
  const loader = { dispose: vi.fn() }; ports.loaders.push(loader); return loader
} }))
afterEach(() => { ports.jobs.length = 0; ports.loaders.length = 0; ports.workspace.path = _hygiene_fixturePath("workspace"); vi.restoreAllMocks(); vi.unstubAllGlobals() })

const snapshot = (): ChartSnapshot => ({ svg: '<svg width="200" height="100"/>', width: 200, height: 100, events: [{ source: 'view', type: 'click' }, { source: 'window', type: 'keydown' }], bindings: [{ signal: 'level', input: 'range', value: 2, min: 0, max: 5 }, { signal: 'choice', input: 'select', value: 42, options: [42, { key: 'typed' }] }] })
function environment(inViewport = true, foreground = true) {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const visibility = previewVisibility(inViewport, foreground)
  const observers: Array<{ callback: (entries: any[]) => void; disconnect: ReturnType<typeof vi.fn> }> = []
  vi.stubGlobal('ResizeObserver', class { disconnect = vi.fn(); constructor(callback: (entries: any[]) => void) { observers.push({ callback, disconnect: this.disconnect }) } observe() {} })
  const create = vi.spyOn(URL, 'createObjectURL').mockImplementation(() => `blob:chart-${Math.random()}`), revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
  const addWindow = vi.spyOn(window, 'addEventListener'), removeWindow = vi.spyOn(window, 'removeEventListener')
  const container = document.createElement('div'), root = createRoot(container)
  const render = (content: string, visible = true) => act(async () => root.render(<VegaFilePreview content={content} mode="vega" path="chart.vg.json" workspaceId="w" visible={visible} />))
  return { container, root, render, observers, create, revoke, visibility, addWindow, removeWindow }
}

it('owns current draft, aborts on source/authority/hide and discards late snapshots without reviving resources', async () => {
  const env = environment()
  try {
    await env.render('first draft')
    expect(ports.jobs[0]!.content).toBe('first draft')
    await act(async () => ports.jobs[0]!.callbacks.snapshot(snapshot()))
    const first = env.container.querySelector('img')!.src
    await env.render('second draft')
    expect(ports.jobs[0]!.signal.aborted).toBe(true)
    expect(ports.jobs[0]!.dispose).toHaveBeenCalledOnce()
    expect(ports.loaders[0]!.dispose).toHaveBeenCalledOnce()
    expect(env.observers[0]!.disconnect).toHaveBeenCalledOnce()
    expect(env.revoke).toHaveBeenCalledWith(first)
    await act(async () => ports.jobs[0]!.callbacks.snapshot(snapshot()))
    expect(env.create).toHaveBeenCalledOnce()
    expect(env.container.textContent).toContain('Preparing chart')
    ports.workspace.path = _hygiene_fixturePath("rebound")
    await env.render('second draft')
    expect(ports.jobs[1]!.signal.aborted).toBe(true)
    expect(ports.loaders[1]!.dispose).toHaveBeenCalledOnce()
    await env.render('second draft', false)
    expect(ports.jobs[2]!.signal.aborted).toBe(true)
    expect(ports.jobs[2]!.dispose).toHaveBeenCalledOnce()
    await act(async () => ports.jobs[2]!.callbacks.snapshot(snapshot()))
    expect(env.container.children).toHaveLength(0)
    expect(env.create).toHaveBeenCalledOnce()
  } finally { await act(async () => env.root.unmount()) }
})

it('bridges real DOM coordinates, typed signal controls and resize to the current worker, then releases on failure for retry', async () => {
  const env = environment()
  try {
    await env.render('interactive draft')
    await act(async () => ports.jobs[0]!.callbacks.snapshot(snapshot()))
    const image = env.container.querySelector('img')!
    vi.spyOn(image, 'getBoundingClientRect').mockReturnValue({ left: 10, top: 20, width: 400, height: 200 } as DOMRect)
    image.dispatchEvent(new MouseEvent('click', { clientX: 110, clientY: 70, buttons: 1 }))
    expect(ports.jobs[0]!.event).toHaveBeenCalledWith(expect.objectContaining({ source: 'view', type: 'click', x: 50, y: 25, buttons: 1 }))
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft' }))
    expect(ports.jobs[0]!.event).toHaveBeenCalledWith(expect.objectContaining({ source: 'window', type: 'keydown', key: 'ArrowLeft' }))
    const select = env.container.querySelector('select')!
    await act(async () => { select.value = '1'; select.dispatchEvent(new Event('change', { bubbles: true })) })
    expect(ports.jobs[0]!.setSignal).toHaveBeenCalledWith('choice', { key: 'typed' })
    env.observers[0]!.callback([{ contentRect: { width: 333, height: 222 } }])
    expect(ports.jobs[0]!.resize).toHaveBeenCalledWith(333, 222)
    await act(async () => ports.jobs[0]!.callbacks.error(new Error('Resource unavailable. Source was kept.')))
    expect(env.container.querySelector('[role="alert"]')!.textContent).toContain('Resource unavailable')
    expect(ports.jobs[0]!.signal.aborted).toBe(true)
    expect(ports.jobs[0]!.dispose).toHaveBeenCalledOnce()
    expect(ports.loaders[0]!.dispose).toHaveBeenCalledOnce()
    expect(env.observers[0]!.disconnect).toHaveBeenCalledOnce()
    const calls = ports.jobs[0]!.event.mock.calls.length
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight' }))
    expect(ports.jobs[0]!.event).toHaveBeenCalledTimes(calls)
    await act(async () => env.container.querySelector('button')!.click())
    expect(ports.jobs).toHaveLength(2)
    expect(ports.jobs[1]!.content).toBe('interactive draft')
  } finally { await act(async () => env.root.unmount()) }
})

it('starts no chart resources before viewport and document foreground both admit work', async () => {
  const env = environment(false, false)
  try {
    await env.render('offscreen draft')
    expect(ports.jobs).toHaveLength(0); expect(ports.loaders).toHaveLength(0); expect(env.observers).toHaveLength(0)
    await act(async () => env.visibility.viewport(true))
    expect(ports.jobs).toHaveLength(0)
    await env.render('current hidden draft')
    await act(async () => env.visibility.foreground(true))
    expect(ports.jobs).toHaveLength(1)
    expect(ports.jobs[0]!.content).toBe('current hidden draft')
  } finally { await act(async () => env.root.unmount()) }
})

it('does not briefly restart Vega when viewport reentry discovers a document hidden while offscreen', async () => {
  const env = environment()
  try {
    await env.render('visible draft')
    expect(ports.jobs).toHaveLength(1)
    await act(async () => env.visibility.viewport(false))
    expect(ports.jobs[0]!.signal.aborted).toBe(true)
    // Offscreen work has no visibilitychange subscription. Its stored foreground
    // value is still true, so the current document fact must gate this next commit.
    await act(async () => env.visibility.foreground(false))
    await env.render('current hidden draft')
    expect(document.visibilityState).toBe('hidden')
    await act(async () => env.visibility.viewport(true))
    expect(ports.jobs).toHaveLength(1)
    expect(ports.loaders).toHaveLength(1)
    expect(env.observers).toHaveLength(1)
    await act(async () => env.visibility.foreground(true))
    expect(ports.jobs).toHaveLength(2)
    expect(ports.jobs[1]!.content).toBe('current hidden draft')
  } finally { await act(async () => env.root.unmount()) }
})

it.each(['document', 'viewport', 'layout'] as const)('parks Vega resources on %s hide and rebuilds from the current draft without old URLs/events', async reason => {
  const env = environment()
  try {
    await env.render('visible draft')
    const old = ports.jobs[0]!, loader = ports.loaders[0]!, observer = env.observers[0]!
    await act(async () => old.callbacks.snapshot(snapshot()))
    const url = env.container.querySelector('img')!.src
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft' }))
    expect(old.event).toHaveBeenCalledOnce()
    if (reason === 'document') await act(async () => env.visibility.foreground(false))
    if (reason === 'viewport') await act(async () => env.visibility.viewport(false))
    if (reason === 'layout') await env.render('visible draft', false)
    expect(old.signal.aborted).toBe(true)
    expect(old.dispose).toHaveBeenCalledOnce(); expect(loader.dispose).toHaveBeenCalledOnce(); expect(observer.disconnect).toHaveBeenCalledOnce()
    expect(env.revoke).toHaveBeenCalledWith(url)
    const keyListener = env.addWindow.mock.calls.find(([type]) => type === 'keydown')![1]
    expect(env.removeWindow).toHaveBeenCalledWith('keydown', keyListener)
    expect(env.container.querySelector('img[src]')).toBeNull()
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight' }))
    observer.callback([{ contentRect: { width: 999, height: 999 } }])
    await act(async () => old.callbacks.snapshot(snapshot()))
    expect(old.event).toHaveBeenCalledOnce(); expect(old.resize).not.toHaveBeenCalled(); expect(env.create).toHaveBeenCalledOnce()
    await env.render('current hidden draft', reason !== 'layout')
    expect(ports.jobs).toHaveLength(1)
    if (reason === 'document') await act(async () => env.visibility.foreground(true))
    if (reason === 'viewport') await act(async () => env.visibility.viewport(true))
    if (reason === 'layout') await env.render('current hidden draft')
    expect(ports.jobs).toHaveLength(2)
    expect(ports.jobs[1]!.content).toBe('current hidden draft')
    expect(env.container.querySelector('img[src]')).toBeNull()
    await act(async () => old.callbacks.snapshot(snapshot()))
    expect(env.create).toHaveBeenCalledOnce()
    await act(async () => ports.jobs[1]!.callbacks.snapshot(snapshot()))
    expect(env.container.querySelector('img[src]')).not.toBeNull()
  } finally { await act(async () => env.root.unmount()) }
})
