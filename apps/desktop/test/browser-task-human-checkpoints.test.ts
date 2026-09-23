import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BrowserTaskAssetFileStore, BrowserTaskAssets, type BrowserTaskAssetHost, type BrowserTaskAssetStore } from '../src/main/browser-task-assets'
import type { BrowserDemonstrationDraft } from '../src/shared/browser-demonstration'
import type { BrowserScriptRunReport } from '../src/shared/contracts'
import type { BrowserTaskAssetDocument, BrowserTaskAssetRun, BrowserTaskRunIdentity } from '../src/shared/browser-task-assets'

const roots: string[] = []
afterEach(async () => { for (const path of roots.splice(0)) await rm(path, { recursive: true, force: true }) })
class MemoryStore implements BrowserTaskAssetStore {
  document: BrowserTaskAssetDocument | null = null
  saves = 0
  fail = false
  hold: Promise<void> | null = null
  onSave: (() => void) | null = null
  async load() { return structuredClone(this.document) }
  async save(document: BrowserTaskAssetDocument) {
    this.saves += 1; this.onSave?.(); if (this.hold) await this.hold
    if (this.fail) throw new Error('private store error must not escape')
    this.document = structuredClone(document)
  }
}
const tuple = (run: BrowserTaskAssetRun): BrowserTaskRunIdentity => ({ runId: run.id, browserId: run.browserId, assetId: run.assetId, version: run.version })
const pending = (run: BrowserTaskAssetRun) => ({ pendingCheckpointId: run.pendingCheckpointId!, nextStep: run.nextStep, controlBefore: 'human' as const })
function clocked(store: BrowserTaskAssetStore) {
  let n = 0, time = 10
  return new BrowserTaskAssets(store, { id: () => `asset-or-run-${++n}`, now: () => time++ })
}
async function asset(assets: BrowserTaskAssets, browserId: string, checkpoint = true) {
  const recording: BrowserDemonstrationDraft = { id: `recording-${browserId}`, browserId, navigationId: 'nav-a', url: 'https://generic.invalid/form',
    status: 'stopped', revision: 1, startedAt: 1, updatedAt: 2, steps: [] }
  const imported = await assets.importRecording(recording)
  const edited = await assets.edit(imported.id, imported.revision, { ...imported.draft,
    steps: [ ...(checkpoint ? [{ id: 'checkpoint-a', kind: 'checkpoint' as const, url: recording.url, reviewed: true }] : []),
      { id: 'navigate-after', kind: 'navigate', url: 'https://generic.invalid/next', reviewed: true } ] })
  return assets.saveVersion(edited.id, edited.revision)
}
function host() {
  const controls = new Map<string, 'human' | 'agent'>()
  let operation = 0
  const runScript = vi.fn(async (browserId: string, _script: string): Promise<BrowserScriptRunReport> => ({ result: {}, logs: [], outcome: { kind: 'completed' },
    runOperation: { id: `operation-${++operation}`, browserId, operator: { id: 'person', name: 'Person' }, startedAt: 1, phase: 'completed', summary: 'Actual Client step', url: 'https://generic.invalid/next', steps: [] } }))
  const value: BrowserTaskAssetHost = { onRunPrepared: () => {}, runScript, yieldControl: id => { controls.set(id, 'human') }, control: id => controls.get(id) ?? 'agent' }
  return { value, runScript, returnControl: (id: string) => { controls.set(id, 'agent') } }
}
async function waiting(store: BrowserTaskAssetStore = new MemoryStore()) {
  const assets = clocked(store), saved = await asset(assets, 'browser-a'), h = host()
  const run = await assets.run({ browserId: saved.browserId, assetId: saved.id, version: 1, parameters: {} }, h.value)
  expect(run.status).toBe('waiting-human')
  expect(run.pendingCheckpointId).toBe('checkpoint-a')
  expect(run.humanCheckpoints).toEqual([])
  return { assets, saved, run, host: h, store }
}

describe('trusted Continue event facts in the existing asset run', () => {
  it('records actual pending tuple and owner time once; returns copies and retains the original event', async () => {
    const store = new MemoryStore(), f = await waiting(store)
    expect(await f.assets.readExactFact(tuple(f.run), 'checkpoint-a')).toEqual({ status: 'not-recorded' })
    const extra = { ...tuple(f.run), confirmedAt: 999999, privateValue: 'caller-private-value' }
    const first = await f.assets.recordHumanCheckpoint(extra, 'checkpoint-a', pending(f.run))
    expect(first.saved).toBe(true)
    expect(first.fact).toMatchObject({ ...tuple(f.run), checkpointId: 'checkpoint-a', pendingCursor: 1, origin: 'trusted-ui', controlBefore: 'human' })
    expect(first.fact!.confirmedAt).toBeGreaterThan(f.run.startedAt)
    expect(first.fact!.confirmedAt).not.toBe(extra.confirmedAt)
    expect(JSON.stringify(first)).not.toContain('caller-private-value')
    const saves = store.saves
    expect(await f.assets.recordHumanCheckpoint(tuple(f.run), 'checkpoint-a', pending(f.run))).toEqual(first)
    expect(store.saves).toBe(saves)
    expect((await f.assets.state('browser-a')).runs[0]!.humanCheckpoints).toEqual([first.fact])
    const expected = structuredClone(first.fact)
    first.fact!.checkpointId = 'mutated-return-copy'
    expect(await f.assets.readExactFact(tuple(f.run), 'checkpoint-a')).toEqual({ status: 'available', fact: expected })
    for (const wrong of [{ ...tuple(f.run), runId: 'historical-run' }, { ...tuple(f.run), browserId: 'foreign-browser' }]) {
      expect(await f.assets.readExactFact(wrong, 'checkpoint-a')).toMatchObject({ status: 'unavailable' })
    }
    const nextVersion = await f.assets.saveVersion(f.saved.id, f.saved.revision)
    expect(nextVersion.versions).toHaveLength(2)
    expect(await f.assets.readExactFact({ ...tuple(f.run), version: 2 }, 'checkpoint-a')).toMatchObject({ status: 'unavailable' })
    expect(f.host.value.control('browser-a')).toBe('human')
    expect(f.host.runScript).toHaveBeenCalledTimes(0)
  })

  it('rejects wrong run/browser/asset/version and actual pending or control proof without saving', async () => {
    const store = new MemoryStore(), f = await waiting(store), identity = tuple(f.run), saves = store.saves
    const invalid = [{ ...identity, runId: 'other-run' }, { ...identity, browserId: 'other-browser' },
      { ...identity, assetId: 'other-asset' }, { ...identity, version: 2 }]
    for (const wrong of invalid) {
      expect(await f.assets.recordHumanCheckpoint(wrong, 'checkpoint-a', pending(f.run))).toMatchObject({ saved: false, fact: null })
      expect(await f.assets.readExactFact(wrong, 'checkpoint-a')).toMatchObject({ status: 'unavailable' })
    }
    for (const actual of [{ ...pending(f.run), controlBefore: 'agent' as const }, { ...pending(f.run), pendingCheckpointId: 'other-checkpoint' },
      { ...pending(f.run), nextStep: 0 }]) {
      expect(await f.assets.recordHumanCheckpoint(identity, 'checkpoint-a', actual)).toMatchObject({ saved: false, fact: null })
    }
    expect(await f.assets.recordHumanCheckpoint(identity, 'unobserved-checkpoint', pending(f.run))).toMatchObject({ saved: false, fact: null })
    expect(store.saves).toBe(saves)
    expect((await f.assets.state('browser-a')).runs[0]!.humanCheckpoints).toEqual([])
  })

  it('does not publish an approval before the existing store acknowledges its candidate', async () => {
    const store = new MemoryStore(), f = await waiting(store)
    let release!: () => void, started!: () => void
    store.hold = new Promise(resolve => { release = resolve })
    const entered = new Promise<void>(resolve => { started = resolve }); store.onSave = started
    const saving = f.assets.recordHumanCheckpoint(tuple(f.run), 'checkpoint-a', pending(f.run))
    try {
      await entered
      expect((await f.assets.state('browser-a')).runs[0]!.humanCheckpoints).toEqual([])
      expect(await f.assets.readExactFact(tuple(f.run), 'checkpoint-a')).toEqual({ status: 'not-recorded' })
      release()
      expect((await saving).saved).toBe(true)
    } finally { release(); await saving }
  })

  it('failed optional save leaves no fact/cursor/control change and the real Client run can continue', async () => {
    const store = new MemoryStore(), f = await waiting(store)
    store.fail = true
    const receipt = await f.assets.recordHumanCheckpoint(tuple(f.run), 'checkpoint-a', pending(f.run))
    expect(receipt).toMatchObject({ saved: false, fact: null })
    expect(receipt.warning).toContain('Verification is unavailable')
    expect(receipt.warning).not.toContain('private store error')
    expect((await f.assets.state('browser-a')).runs[0]).toMatchObject({ status: 'waiting-human', nextStep: 1, humanCheckpoints: [] })
    expect(await f.assets.readExactFact(tuple(f.run), 'checkpoint-a')).toMatchObject({ status: 'unavailable' })
    expect(f.host.value.control('browser-a')).toBe('human')
    store.fail = false; f.host.returnControl('browser-a')
    const continued = await f.assets.run({ ...tuple(f.run), assetId: f.saved.id, runId: f.run.id, parameters: {} }, f.host.value)
    expect(continued.status).toBe('completed')
    expect(continued.operationIds).toEqual(['operation-1'])
    expect(f.host.runScript).toHaveBeenCalledTimes(1)
    expect(await f.assets.readExactFact(tuple(f.run), 'checkpoint-a')).toMatchObject({ status: 'unavailable' })
  })

  it('candidate publication preserves another real Browser progress producer across a held save', async () => {
    const store = new MemoryStore(), f = await waiting(store)
    const other = await asset(f.assets, 'browser-b', false), h = host()
    let releaseReport!: () => void, reportEntered!: () => void, releaseSave!: () => void, saveEntered!: () => void
    const original = h.value.runScript
    const entered = new Promise<void>(resolve => { reportEntered = resolve })
    const held = new Promise<void>(resolve => { releaseReport = resolve })
    h.value.runScript = async (...args) => { reportEntered(); await held; return original(...args) }
    const running = f.assets.run({ browserId: other.browserId, assetId: other.id, version: 1, parameters: {} }, h.value)
    let saving: ReturnType<BrowserTaskAssets['recordHumanCheckpoint']> | undefined
    try {
      await entered
      const saveStarted = new Promise<void>(resolve => { saveEntered = resolve })
      store.hold = new Promise<void>(resolve => { releaseSave = resolve }); store.onSave = saveEntered
      saving = f.assets.recordHumanCheckpoint(tuple(f.run), 'checkpoint-a', pending(f.run))
      await saveStarted
      releaseReport(); store.onSave = null; store.hold = null; releaseSave()
      expect((await saving).saved).toBe(true)
      const completed = await running
      expect(completed.status).toBe('completed')
      expect((await f.assets.state('browser-b')).runs).toEqual([completed])
      expect(store.document!.runs.find(run => run.browserId === 'browser-b')).toEqual(completed)
      expect(completed.operationIds).toEqual(['operation-1'])
      expect((await f.assets.state('browser-a')).runs[0]!.humanCheckpoints).toHaveLength(1)
    } finally { releaseReport(); releaseSave?.(); store.hold = null; await Promise.allSettled([running, ...(saving ? [saving] : [])]) }
  })

  it('ordinary file-store restart retains the event without continuing a page action', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'amux-human-facts-')); roots.push(directory)
    const path = join(directory, 'assets.json'), f = await waiting(new BrowserTaskAssetFileStore(path))
    const saved = await f.assets.recordHumanCheckpoint(tuple(f.run), 'checkpoint-a', pending(f.run))
    expect(saved.saved).toBe(true)
    const restored = clocked(new BrowserTaskAssetFileStore(path))
    expect(await restored.readExactFact(tuple(f.run), 'checkpoint-a')).toEqual({ status: 'available', fact: saved.fact })
    expect((await restored.state('browser-a')).runs[0]!.humanCheckpoints).toEqual([saved.fact])
    expect((await restored.state('browser-a')).runs[0]!.status).toBe('waiting-human')
    expect(f.host.runScript).toHaveBeenCalledTimes(0)
    const bytes = await readFile(path, 'utf8')
    expect(bytes).not.toContain('parametersValue')
    expect(bytes).not.toContain('approved')
  })

  it('missing/damaged optional recording information is unavailable while valid run progress remains', async () => {
    const store = new MemoryStore(), f = await waiting(store)
    const saved = await f.assets.recordHumanCheckpoint(tuple(f.run), 'checkpoint-a', pending(f.run))
    expect(saved.saved).toBe(true)
    const original = structuredClone(store.document!)
    for (const change of [
      (doc: BrowserTaskAssetDocument) => { delete doc.runs[0]!.humanCheckpoints },
      (doc: BrowserTaskAssetDocument) => { doc.runs[0]!.humanCheckpoints![0]!.origin = 'agent' as 'trusted-ui' },
      (doc: BrowserTaskAssetDocument) => { doc.runs[0]!.humanCheckpoints![0]!.version = 2 },
      (doc: BrowserTaskAssetDocument) => { doc.runs[0]!.humanCheckpoints!.push(structuredClone(doc.runs[0]!.humanCheckpoints![0]!)) }
    ]) {
      const changed = structuredClone(original); change(changed); store.document = changed
      const reader = clocked(store)
      expect(await reader.readExactFact(tuple(f.run), 'checkpoint-a')).toMatchObject({ status: 'unavailable' })
      expect((await reader.state('browser-a')).runs).toHaveLength(1)
      expect((await reader.state('browser-a')).runs[0]!.status).toBe('waiting-human')
    }
    const broken: BrowserTaskAssetStore = { load: async () => { throw new Error('Disk inaccessible') }, save: async () => {} }
    expect(await clocked(broken).readExactFact(tuple(f.run), 'checkpoint-a')).toMatchObject({ status: 'unavailable' })
  })

  it('agent control and completed cursor never manufacture a confirmation, including after normal file save', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'amux-no-fake-approval-')); roots.push(directory)
    const path = join(directory, 'assets.json'), f = await waiting(new BrowserTaskAssetFileStore(path))
    f.host.returnControl('browser-a')
    const completed = await f.assets.run({ browserId: f.run.browserId, assetId: f.run.assetId, version: f.run.version, runId: f.run.id, parameters: {} }, f.host.value)
    expect(completed.status).toBe('completed')
    expect(completed.humanCheckpoints).toEqual([])
    expect(await f.assets.readExactFact(tuple(f.run), 'checkpoint-a')).toMatchObject({ status: 'unavailable' })
    const restored = clocked(new BrowserTaskAssetFileStore(path))
    expect(await restored.readExactFact(tuple(f.run), 'checkpoint-a')).toMatchObject({ status: 'unavailable' })
    expect(await restored.recordHumanCheckpoint(tuple(f.run), 'checkpoint-a', pending(f.run))).toMatchObject({ saved: false, fact: null })
    expect(JSON.parse(await readFile(path, 'utf8')).runs[0].humanCheckpoints).toEqual([])
  })
})
