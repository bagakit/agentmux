import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  BrowserDemonstrationFileStore,
  BrowserDemonstrationRecorder,
  type BrowserDemonstrationDocument,
  type BrowserDemonstrationEvent,
  type BrowserDemonstrationStore
} from '../src/main/browser-demonstration-recorder.js'

class MemoryStore implements BrowserDemonstrationStore {
  document: BrowserDemonstrationDocument | null = null
  saves = 0
  failLoad = false
  failSave = false
  async load() { if (this.failLoad) throw new Error('load'); return structuredClone(this.document) }
  async save(document: BrowserDemonstrationDocument) {
    if (this.failSave) throw new Error('save')
    this.saves += 1
    this.document = structuredClone(document)
  }
}
const browserId = 'browser-1'
const navigationId = 'navigation-1'
const target = { role: 'button', name: 'Continue', ordinal: 1, count: 1 }
function setup(store = new MemoryStore()) {
  let now = 1_000
  let id = 0
  const recorder = new BrowserDemonstrationRecorder(store, { now: () => now, id: () => `record-${++id}` })
  return { recorder, store, time(value: number) { now = value },
    start: () => recorder.start({ browserId, navigationId, url: 'https://example.test/form?private=value#secret' }),
    native: (type = 'mouseUp') => recorder.noteNativeInput({ browserId, navigationId, type }),
    event: (input: Partial<BrowserDemonstrationEvent> = {}) => recorder.recordBrowserDemonstration({ browserId, navigationId, kind: 'click', isTrusted: true, target, ...input }) }
}
const paths: string[] = []
afterEach(async () => { await Promise.all(paths.splice(0).map(path => rm(path, { recursive: true, force: true }))) })

describe('BrowserDemonstrationRecorder', () => {
  it('requires explicit recording, native input, page trust and the current document together', async () => {
    const s = setup()
    s.native()
    await expect(s.event()).resolves.toBeNull()
    await s.start()
    await expect(s.event()).resolves.toBeNull()
    s.native()
    await expect(s.event({ isTrusted: false })).resolves.toBeNull()
    await expect(s.event({ browserId: 'other-browser' })).resolves.toBeNull()
    await expect(s.event({ navigationId: 'old-document' })).resolves.toBeNull()
    const draft = await s.event()
    expect(draft?.steps).toEqual([expect.objectContaining({ sequence: 1, method: 'click', source: 'native-human', navigationId, target, args: [] })])
    expect(draft?.url).toBe('https://example.test/form')
    expect(draft?.steps[0]?.blockedReason).toContain('side effects')
  })

  it('does not borrow a stale or future gesture, hover, or another Browser input', async () => {
    const s = setup()
    await s.start()
    s.native('mouseMove')
    await expect(s.event()).resolves.toBeNull()
    s.recorder.noteNativeInput({ browserId: 'other-browser', navigationId, type: 'mouseUp' })
    await expect(s.event()).resolves.toBeNull()
    s.native()
    s.time(3_001)
    await expect(s.event()).resolves.toBeNull()
    s.recorder.noteNativeInput({ browserId, navigationId, type: 'mouseUp', at: 4_000 })
    await expect(s.event()).resolves.toBeNull()
    expect((await s.recorder.get(browserId))?.steps).toEqual([])
  })

  it('never accepts values, coalesces a field semantic step, and leaves uncertain targets blocked', async () => {
    const s = setup()
    await s.start()
    s.native('char')
    const field = { role: 'text input', name: 'Display name', ordinal: 1, count: 1 }
    const raw = { browserId, navigationId, kind: 'fill', isTrusted: true, target: field, value: 'secret-first', args: ['secret-second'], html: '<input value="secret-third">' }
    await s.recorder.recordBrowserDemonstration(raw as BrowserDemonstrationEvent)
    const saves = s.store.saves
    s.native('keyDown')
    await s.event({ kind: 'fill', target: field })
    expect(s.store.saves).toBe(saves)
    const filled = (await s.recorder.get(browserId))?.steps
    expect(filled).toEqual([expect.objectContaining({ method: 'fillInput', args: [], inputKey: 'input-1', target: field })])
    expect(filled?.[0]?.blockedReason).toContain('fresh parameter')
    s.native()
    await s.recorder.recordBrowserDemonstration({ browserId, navigationId, kind: 'click', isTrusted: true })
    expect((await s.recorder.get(browserId))?.steps).toHaveLength(2)
    expect((await s.recorder.get(browserId))?.steps[1]?.blockedReason).toContain('could not be verified')
    expect(JSON.stringify(s.store.document)).not.toContain('secret-')
  })

  it('records navigation facts without claiming an unattributed navigation is a human action', async () => {
    const s = setup()
    await s.start()
    const moved = await s.recorder.navigated({ browserId, fromNavigationId: navigationId, navigationId: 'navigation-2', url: 'https://example.test/results?token=private' })
    expect(moved?.steps).toEqual([expect.objectContaining({ source: 'navigation', method: 'gotoUrl', url: 'https://example.test/results', args: ['https://example.test/results'], blockedReason: expect.stringContaining('unknown') })])
    s.native()
    await expect(s.event()).resolves.toBeNull()
    s.recorder.noteNativeInput({ browserId, navigationId: 'navigation-2', type: 'mouseUp' })
    const real = await s.recorder.recordBrowserDemonstration({ browserId, navigationId: 'navigation-2', kind: 'click', isTrusted: true, target })
    expect(real?.steps).toHaveLength(2)
    expect(real?.steps[1]?.source).toBe('native-human')
    expect(JSON.stringify(s.store.document)).not.toContain('private')
    await expect(s.recorder.navigated({ browserId, fromNavigationId: navigationId, navigationId: 'stale', url: 'https://example.test/stale' })).resolves.toBeNull()
  })

  it('keeps the stopped draft immutable to late events and does not resume recording on restart', async () => {
    const s = setup()
    await s.start(); s.native(); await s.event()
    const stopped = await s.recorder.stop(browserId)
    s.native()
    await expect(s.event()).resolves.toBeNull()
    expect(stopped?.status).toBe('stopped')
    expect((await s.recorder.get(browserId))?.steps).toHaveLength(1)
    await s.recorder.start({ browserId, navigationId, url: 'https://example.test/new' })
    const restarted = new BrowserDemonstrationRecorder(s.store, { now: () => 5_000 })
    const drafts = await restarted.list()
    expect(drafts.map(d => d.status)).toEqual(['stopped', 'interrupted'])
    expect(drafts[1]?.warning).toContain('restart')
    restarted.noteNativeInput({ browserId, navigationId, type: 'mouseUp' })
    await expect(restarted.recordBrowserDemonstration({ browserId, navigationId, kind: 'click', isTrusted: true, target })).resolves.toBeNull()
  })

  it('preserves a usable live draft when storage fails and does not overwrite unread history', async () => {
    const s = setup()
    s.store.failSave = true
    const started = await s.start()
    s.native(); await s.event()
    expect(started.status).toBe('recording')
    expect(s.recorder.getPersistenceWarning()).toContain('could not be saved')
    expect((await s.recorder.get(browserId))?.steps).toHaveLength(1)
    s.store.failSave = false
    await s.recorder.stop(browserId)
    expect(s.recorder.getPersistenceWarning()).toBeUndefined()
    expect(s.store.document?.drafts[0]?.steps).toHaveLength(1)
    const failedStore = new MemoryStore(); failedStore.failLoad = true
    const inaccessible = setup(failedStore)
    await inaccessible.start(); inaccessible.native(); await inaccessible.event()
    expect((await inaccessible.recorder.get(browserId))?.steps).toHaveLength(1)
    expect(inaccessible.recorder.getPersistenceWarning()).toContain('could not be loaded')
    expect(failedStore.saves).toBe(0)
  })

  it('stops at the step budget, bounds drafts without dropping another active Browser, and returns copies', async () => {
    const s = setup()
    await s.start()
    for (let n = 0; n < 129; n += 1) { s.native(); await s.event() }
    const current = await s.recorder.get(browserId)
    expect(current?.steps).toHaveLength(128)
    expect(current?.status).toBe('stopped')
    expect(current?.warning).toContain('budget')
    current!.steps.length = 0
    expect((await s.recorder.get(browserId))?.steps).toHaveLength(128)
    for (let n = 1; n < 32; n += 1) await s.recorder.start({ browserId: `browser-${n + 1}`, navigationId, url: 'https://example.test/' })
    await expect(s.recorder.start({ browserId: 'over-budget', navigationId, url: 'https://example.test/' })).rejects.toThrow('budget')
    expect(await s.recorder.list()).toHaveLength(32)
    expect((await s.recorder.get('browser-2'))?.status).toBe('recording')
  })

  it('persists and recovers semantic drafts from disk, strips unexpected secret fields, and preserves corrupt files', async () => {
    const path = await mkdtemp(join(tmpdir(), 'agentmux-recorder-test-')); paths.push(path)
    const file = join(path, 'drafts.json')
    const store = new BrowserDemonstrationFileStore(file)
    let id = 0
    const recording = new BrowserDemonstrationRecorder(store, { id: () => `disk-${++id}` })
    await recording.start({ browserId, navigationId, url: 'https://example.test/form' })
    recording.noteNativeInput({ browserId, navigationId, type: 'char' })
    await recording.recordBrowserDemonstration({ browserId, navigationId, kind: 'fill', isTrusted: true, target: { role: 'text input', name: 'Field', ordinal: 1, count: 1 } })
    const content = JSON.parse(await readFile(file, 'utf8'))
    content.drafts[0].steps[0].args = ['never-retain-this']
    content.drafts[0].value = 'never-retain-this-either'
    await writeFile(file, JSON.stringify(content))
    const restored = new BrowserDemonstrationRecorder(store)
    const draft = await restored.get(browserId)
    expect(draft?.status).toBe('interrupted')
    expect(draft?.steps).toEqual([expect.objectContaining({ method: 'fillInput', inputKey: 'input-1', args: [] })])
    expect(await readFile(file, 'utf8')).not.toContain('never-retain')
    await writeFile(file, '{corrupted-private-content')
    const corrupt = new BrowserDemonstrationRecorder(store)
    await corrupt.start({ browserId, navigationId, url: 'https://example.test/' })
    expect(corrupt.getPersistenceWarning()).toContain('could not be loaded')
    expect(await readFile(file, 'utf8')).toBe('{corrupted-private-content')
  })
})
