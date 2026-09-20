import { EventEmitter } from 'node:events'
import vm from 'node:vm'
import type { WebContents } from 'electron'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BrowserDemonstrationCapture } from '../src/main/browser-demonstration-capture.js'
import { BrowserDemonstrationRecorder } from '../src/main/browser-demonstration-recorder.js'
import type { BrowserDemonstrationDocument, BrowserDemonstrationDraft } from '../src/shared/browser-demonstration.js'
import { captureBrowserPageSnapshot } from '../src/main/browser-page-snapshot.js'

vi.mock('../src/main/browser-page-snapshot.js', () => ({ captureBrowserPageSnapshot: vi.fn() }))
const snapshot = vi.mocked(captureBrowserPageSnapshot)
class Element {
  constructor(readonly ownerDocument: unknown, readonly backendNodeId: number) {}
}
class Contents extends EventEmitter {
  attached = false
  attaches = 0
  attachFailure = false
  unknownContext = false
  scriptReads = 0
  commands: { method: string; params?: Record<string, unknown> }[] = []
  pageListeners = new Map<string, (event: unknown) => void>()
  handles = new Map<string, Element>()
  document = { addEventListener: (type: string, listener: (event: unknown) => void) => this.pageListeners.set(type, listener), removeEventListener: (type: string) => this.pageListeners.delete(type) }
  world = vm.createContext({ document: this.document, Element })
  main = vm.createContext({})
  debugger = Object.assign(new EventEmitter(), {
    attach: () => { if (this.attachFailure) throw new Error('DevTools open'); this.attaches += 1; this.attached = true },
    detach: () => { this.attached = false },
    isAttached: () => this.attached,
    sendCommand: async (method: string, params?: Record<string, unknown>): Promise<unknown> => {
      if (!this.attached) throw new Error('Detached')
      this.commands.push({ method, ...(params ? { params } : {}) })
      if (method === 'Runtime.enable') {
        for (const id of [3, 7]) this.debugger.emit('message', {}, 'Runtime.executionContextCreated', { context: { id } })
      }
      if (method === 'Runtime.evaluate') {
        const result: unknown = vm.runInContext(String(params?.expression), params?.contextId === 7 && !this.unknownContext ? this.world : this.main)
        if (params?.returnByValue) return { result: { value: result } }
        if (!(result instanceof Element)) return { result: { type: 'undefined' } }
        const objectId = `object-${result.backendNodeId}`
        this.handles.set(objectId, result)
        return { result: { objectId } }
      }
      if (method === 'DOM.describeNode') return { node: { backendNodeId: this.handles.get(String(params?.objectId))?.backendNodeId } }
      if (method === 'Accessibility.getPartialAXTree') return { nodes: [{ backendDOMNodeId: params?.backendNodeId, ignored: false, role: { value: params?.backendNodeId === 22 ? 'textbox' : 'button' }, name: { value: params?.backendNodeId === 22 ? 'Name' : 'Continue' } }] }
      return {}
    }
  })
  isDestroyed() { return false }
  async executeJavaScriptInIsolatedWorld(_world: number, scripts: { code: string }[]) {
    this.scriptReads += 1
    return vm.runInContext(scripts[0]!.code, this.world) as unknown
  }
  event(type: 'click' | 'input', backendNodeId: number, isTrusted = true) {
    const node = new Element(this.document, backendNodeId)
    this.pageListeners.get(type)?.({ type, isTrusted, composedPath: () => [node] })
  }
  native(type = 'mouseUp') { this.emit('input-event', {}, { type }) }
}
const captures: BrowserDemonstrationCapture[] = []
afterEach(async () => { await Promise.all(captures.splice(0).map(capture => capture.dispose())); vi.clearAllMocks() })
function setup(firstSave?: () => Promise<void>) {
  const contents = new Contents()
  let document: BrowserDemonstrationDocument | null = null
  let saved = false
  const recorder = new BrowserDemonstrationRecorder({ load: async () => document, save: async next => { if (!saved) { saved = true; await firstSave?.() }; document = structuredClone(next) } })
  const drafts: { draft: BrowserDemonstrationDraft | null; warning?: string }[] = []
  const identity = { navigationId: 'nav-1', url: 'https://example.test/form?private=secret', title: 'Form' }
  const capture = new BrowserDemonstrationCapture({ contents: contents as unknown as WebContents, browserId: 'browser-1', recorder, getIdentity: () => ({ ...identity }), onDraft: (draft, warning) => drafts.push({ draft, ...(warning ? { warning } : {}) }) })
  captures.push(capture)
  snapshot.mockResolvedValue({ nodes: [
    { ref: '@e1', role: 'button', name: 'Continue', backendNodeId: 11, depth: 0 },
    { ref: '@e2', role: 'text input', name: 'Name', backendNodeId: 22, depth: 0 }
  ] } as Awaited<ReturnType<typeof captureBrowserPageSnapshot>>)
  return { contents, recorder, capture, identity, drafts }
}

describe('BrowserDemonstrationCapture', () => {
  it('coalesces duplicate starts and cannot reacquire a CDP owner after an Agent releases a slow start', async () => {
    let entered!: () => void, release!: () => void
    const waiting = new Promise<void>(done => { entered = done })
    const paused = new Promise<void>(done => { release = done })
    const s = setup(async () => { entered(); await paused })
    const first = s.capture.start(), duplicate = s.capture.start()
    expect(first).toBe(duplicate)
    await waiting
    const stopping = s.capture.stop()
    expect(s.contents.attached).toBe(false)
    release()
    await first; await stopping
    expect(s.contents.attaches).toBe(0)
    expect(s.contents.listenerCount('input-event')).toBe(0)
    expect((await s.recorder.get('browser-1'))?.status).toBe('stopped')
  })
  it('reads only after native input, filters synthetic page events and proves the actual target in the isolated world', async () => {
    const s = setup()
    await s.capture.start()
    const initialReads = s.contents.scriptReads
    s.contents.native('mouseMove')
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(s.contents.scriptReads).toBe(initialReads)
    s.contents.event('click', 11, false)
    s.contents.native()
    s.contents.event('click', 11)
    s.contents.native('char')
    s.contents.event('input', 22)
    await s.capture.flush()
    expect((await s.recorder.get('browser-1'))?.steps).toEqual([
      expect.objectContaining({ method: 'click', target: { role: 'button', name: 'Continue', ordinal: 1, count: 1 }, source: 'native-human' }),
      expect.objectContaining({ method: 'fillInput', target: { role: 'text input', name: 'Name', ordinal: 1, count: 1 }, args: [], inputKey: 'input-2' })
    ])
    expect(snapshot).toHaveBeenCalledTimes(1)
    expect(s.contents.commands.filter(command => command.method === 'DOM.describeNode')).toHaveLength(2)
    expect(s.contents.commands.filter(command => command.method === 'Accessibility.getPartialAXTree').map(command => command.params?.backendNodeId)).toEqual([11, 22])
    expect(s.drafts.filter(entry => entry.draft?.steps.length)).toHaveLength(2)
  })

  it('never guesses a target when names are ambiguous, the actual backend differs, or the isolated-world token is unproven', async () => {
    const s = setup()
    await s.capture.start()
    snapshot.mockResolvedValue({ nodes: [{ ref: '@e1', role: 'button', name: 'Continue', backendNodeId: 11 }, { ref: '@e2', role: 'button', name: 'Continue', backendNodeId: 33 }] } as Awaited<ReturnType<typeof captureBrowserPageSnapshot>>)
    s.contents.native(); s.contents.event('click', 11); await s.capture.flush()
    snapshot.mockResolvedValue({ nodes: [{ ref: '@e2', role: 'button', name: 'Continue', backendNodeId: 33 }] } as Awaited<ReturnType<typeof captureBrowserPageSnapshot>>)
    s.contents.native(); s.contents.event('click', 11); await s.capture.flush()
    // Force a fresh isolated-world attestation by starting a new explicit capture.
    await s.capture.stop(); s.contents.unknownContext = true; await s.capture.start()
    s.contents.native(); s.contents.event('click', 11); await s.capture.flush()
    const all = (await s.recorder.list()).flatMap(draft => draft.steps)
    expect(all).toHaveLength(3)
    expect(all.map(step => step.target)).toEqual([undefined, undefined, undefined])
    expect(all.map(step => step.blockedReason)).toEqual(Array(3).fill('The demonstrated target could not be verified; locate it before replay.'))
    expect(s.drafts.at(-1)?.warning).toContain('isolated world')
  })

  it('keeps uncertain steps and warns when attaching fails instead of making the healthy Browser unusable', async () => {
    const s = setup(); s.contents.attachFailure = true
    await expect(s.capture.start()).resolves.toMatchObject({ status: 'recording' })
    s.contents.native(); s.contents.event('click', 11); await s.capture.flush()
    expect((await s.recorder.get('browser-1'))?.steps).toEqual([expect.objectContaining({ blockedReason: expect.stringContaining('could not be verified') })])
    expect(s.drafts.at(-1)?.warning).toContain('unavailable')
    expect(s.contents.attached).toBe(false)
  })

  it('bounds event capture, drops no unknown amount silently and clears old events at navigation', async () => {
    const s = setup(); await s.capture.start()
    s.contents.native()
    for (let index = 0; index < 70; index += 1) s.contents.event('click', 11)
    await s.capture.flush()
    expect((await s.recorder.get('browser-1'))?.steps).toHaveLength(64)
    expect(s.drafts.at(-1)?.warning).toContain('event budget')
    expect(snapshot).toHaveBeenCalledTimes(1)
    s.contents.native(); s.contents.event('click', 11)
    s.identity.navigationId = 'nav-2'; s.identity.url = 'https://example.test/next?private=value'
    s.contents.emit('did-start-navigation', { isMainFrame: true })
    await s.capture.flush()
    const draft = await s.recorder.get('browser-1')
    expect(draft?.steps).toHaveLength(65)
    expect(draft?.steps.at(-1)).toMatchObject({ method: 'gotoUrl', source: 'navigation', url: 'https://example.test/next', navigationId: 'nav-2' })
    expect(draft?.url).toBe('https://example.test/next')
  })

  it('releases the CDP owner and listeners before any slow stop persistence and does not record after stop', async () => {
    const s = setup(); await s.capture.start()
    const stop = s.capture.stop()
    expect(s.contents.attached).toBe(false)
    expect(s.contents.listenerCount('input-event')).toBe(0)
    expect(s.contents.pageListeners.size).toBe(0)
    s.contents.native(); s.contents.event('click', 11)
    await stop; await s.capture.flush()
    expect((await s.recorder.get('browser-1'))?.steps).toEqual([])
    expect((await s.recorder.get('browser-1'))?.status).toBe('stopped')
  })

  it('releases capture when the durable recorder reaches its step budget', async () => {
    const s = setup(); await s.capture.start()
    for (const count of [64, 64, 1]) {
      s.contents.native()
      for (let index = 0; index < count; index += 1) s.contents.event('click', 11)
      await s.capture.flush()
    }
    const draft = await s.recorder.get('browser-1')
    expect(draft?.steps).toHaveLength(128)
    expect(draft?.status).toBe('stopped')
    expect(draft?.warning).toContain('step budget')
    expect(s.contents.attached).toBe(false)
    expect(s.contents.listenerCount('input-event')).toBe(0)
  })

  it('preserves the mature CDP owner cleanup warning without rejecting a stopped recording', async () => {
    const s = setup(); await s.capture.start()
    s.contents.debugger.detach = () => { throw new Error('Cleanup failed') }
    await expect(s.capture.stop()).resolves.toMatchObject({ status: 'stopped' })
    expect(s.drafts.at(-1)?.warning).toContain('Browser debugger cleanup could not finish')
    expect(s.contents.listenerCount('input-event')).toBe(0)
  })
})
