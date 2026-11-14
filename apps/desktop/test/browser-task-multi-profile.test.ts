import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BrowserTaskAssetFileStore, BrowserTaskAssets, type BrowserTaskAssetStore, type BrowserTaskAssetHost } from '../src/main/browser-task-assets.js'
import { importTaskRecording } from './helpers/import-task-recording.js'
import type { BrowserTaskAssetDocument, BrowserTaskStepExecution } from '../src/shared/browser-task-assets.js'
import type { BrowserTaskParallelHost } from '../src/main/browser-task-parallel.js'
import { parseBrowserTaskControlPayload } from '../../../packages/core/src/browser-task-control.js'
import { parseBrowserTaskParallelInput, parseBrowserTaskParallelInspection } from '../../../packages/core/src/browser-task-parallel.js'
import { createBrowserAutomationGate } from '../src/main/browser-automation-gate.js'
import { createBrowserProfileUsage } from '../src/main/browser-profile-usage.js'

const directoryFault = vi.hoisted(() => ({ path: '', hits: 0 }))
vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return { ...actual, open: async (...args: Parameters<typeof actual.open>) => {
    const handle = await actual.open(...args)
    if (String(args[0]) === directoryFault.path) handle.sync = async () => { directoryFault.hits++; throw Object.assign(new Error('Controlled directory ACK loss'), { code: 'EIO' }) }
    return handle
  } }
})
afterEach(() => { directoryFault.path = ''; directoryFault.hits = 0 })
const source = 'source-library', url = 'https://forms.invalid/submit'
class MemoryStore implements BrowserTaskAssetStore {
  document: BrowserTaskAssetDocument | null = null
  fault: 'before' | 'after' | undefined
  async load() { return structuredClone(this.document) }
  async save(document: BrowserTaskAssetDocument) {
    if (this.fault === 'before') throw Error('storage unavailable')
    this.document = structuredClone(document)
    if (this.fault === 'after') throw Error('write reply lost')
  }
}
const target = (id: string, profileId = id) => ({ id, browserId: `browser-${id}`, profileId, parameters: { entry: `fresh-${id}` } })
async function fixture(capacity = 2) {
  const store = new MemoryStore(); let sequence = 0
  const options = { id: () => `id-${++sequence}`, parallelCapacity: () => capacity }
  let owner = new BrowserTaskAssets(store, options)
  const actions: { browserId: string; stepId: string; value: string; runId: string }[] = []
  const started: string[] = [], gates = new Map<string, Promise<void>>(), releases = new Map<string, () => void>()
  const failed = new Set<string>()
  const host: BrowserTaskAssetHost = {
    onRunPrepared() {}, control: () => 'agent', yieldControl() {}, navigationId: () => 'document-1',
    async runScript(browserId, script, execution: BrowserTaskStepExecution, frame) {
      const operationId = `operation-${execution.runId}-${execution.stepId}`
      expect(await owner.bindOperation(execution, operationId)).toBe(true)
      await gates.get(browserId)
      const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor
      const result = await new AsyncFunction('pageInfo', 'snapshot', 'fillInput', script)(
        async () => ({ url, navigationId: 'document-1' }),
        async () => ({ navigationId: 'document-1', nodes: [{ ref: '@entry', role: 'textbox', name: 'Entry' }], missingFrames: [],
          observation: { scope: { kind: 'page', document: null }, fullObserved: 1, scoped: 1, matched: 1, returned: 1, truncated: false, omittedFrames: [] } }),
        async (_ref: string, value: string) => actions.push({ browserId, stepId: execution.stepId, value, runId: execution.runId }))
      expect(frame?.parameters.entry).toEqual(actions.find(action => action.runId === execution.runId)?.value)
      return { result, logs: [], outcome: { kind: 'completed' }, runOperation: { id: operationId, browserId, phase: 'completed',
        operator: { id: 'operator', name: 'Operator' }, startedAt: 1, summary: 'Fill', url, steps: [{ sequence: 1, method: 'fillInput', status: 'completed' }] } }
    }
  }
  const parallel: BrowserTaskParallelHost = { async runTask(input, execution) {
    started.push(input.browserId)
    if (failed.has(input.browserId)) throw Error(`Rejected fresh-private-${input.parameters.entry}`)
    return owner.run(input, host, undefined, execution)
  } }
  const publish = async () => {
    const asset = await importTaskRecording(owner, { id: `recording-${++sequence}`, browserId: source, revision: 1, navigationId: 'recorded', url, status: 'stopped', startedAt: 1, updatedAt: 2, steps: [] })
    const edited = await owner.edit(asset.id, asset.revision, { name: 'Submit', url, parameters: [{ key: 'entry', label: 'Entry', secret: true }],
      steps: [{ id: 'original-fill', kind: 'fill', url, reviewed: true, target: { role: 'textbox', name: 'Entry', ordinal: 1, count: 1 }, parameterKey: 'entry' }] })
    return owner.saveVersion(edited.id, edited.revision)
  }
  const asset = await publish()
  const start = (operationId: string, targets = [target('a')], concurrency = capacity) => owner.startParallel(source, asset.id, 1, { operationId, concurrency, targets }, parallel)
  const inspect = (operationId: string) => owner.inspectParallel(source, operationId)
  return { store, asset, start, inspect, started, failed, actions, owner: () => owner,
    hold: (browserId: string) => gates.set(browserId, new Promise<void>(resolve => releases.set(browserId, resolve))),
    release: (browserId: string) => releases.get(browserId)?.(),
    reload: () => { owner = new BrowserTaskAssets(store, options); return owner } }
}

describe('original task orchestration over explicit Browser/Profile targets', () => {
  it('serializes shared Profiles, advances independent ones, isolates a failed target and pins the source version', async () => {
    const f = await fixture(); f.hold('browser-a1'); f.hold('browser-b'); f.failed.add('browser-c')
    await f.start('original-set', [target('a1', 'shared'), target('a2', 'shared'), target('b'), target('c')])
    await vi.waitFor(() => expect(f.started).toEqual(['browser-a1', 'browser-b']))
    const queued = await f.inspect('original-set')
    expect(queued?.targets[1]).toMatchObject({ phase: 'queued', waitingForProfile: { operationId: 'original-set', targetId: 'a1' } })
    const edit = await f.owner().edit(f.asset.id, f.asset.revision, { ...f.asset.draft, steps: [{ ...f.asset.draft.steps[0]!, id: 'new-fill' }] })
    await f.owner().saveVersion(edit.id, edit.revision)
    f.release('browser-b')
    await vi.waitFor(() => expect(f.started).toContain('browser-c'))
    expect(f.started).not.toContain('browser-a2')
    f.release('browser-a1')
    await vi.waitFor(async () => expect((await f.inspect('original-set'))?.run).toMatchObject({ status: 'failed', counts: { completed: 3, failed: 1 } }))
    expect(f.actions.map(action => action.stepId)).toEqual(['original-fill', 'original-fill', 'original-fill'])
    expect(f.actions.map(action => action.value).sort()).toEqual(['fresh-a1', 'fresh-a2', 'fresh-b'])
    expect(f.store.document?.assets).toHaveLength(1)
    const inspection = (await f.inspect('original-set'))!
    for (const row of inspection.targets.filter(row => row.run)) {
      expect((await f.owner().inspect(row.browserId, row.run!.id))?.runs[0]).toMatchObject({ browserId: row.browserId, version: 1,
        orchestration: { operationId: 'original-set', targetId: row.id, sourceBrowserId: source } })
    }
    expect(JSON.stringify(f.store.document)).not.toMatch(/fresh-|private-/)
  })

  it('limits current work rather than lifetime results and admits queued work across independent operations', async () => {
    const f = await fixture(2); f.hold('browser-a'); f.hold('browser-b'); f.hold('browser-c'); f.hold('browser-d')
    await f.start('one', [target('a'), target('b')], 9)
    await f.start('two', [target('c'), target('d')], 9)
    await vi.waitFor(() => expect(f.started).toHaveLength(2))
    f.release('browser-a')
    await vi.waitFor(() => expect(f.started).toContain('browser-c'))
    expect(f.started).not.toContain('browser-d')
    f.release('browser-b'); f.release('browser-c'); f.release('browser-d')
    await vi.waitFor(async () => expect((await f.inspect('two'))?.run).toMatchObject({ status: 'completed', counts: { completed: 2 } }))
    expect((await f.inspect('one'))?.run).toMatchObject({ concurrency: 2, counts: { completed: 2 } })
  })

  it.each(['before', 'after'] as const)('does not dispatch after an unconfirmed %s admission and reads the same ID without replay', async fault => {
    const f = await fixture(); f.store.fault = fault
    await expect(f.start('lost-ack')).rejects.toMatchObject({ code: 'BROWSER_TASK_PARALLEL_UNCONFIRMED' })
    expect(f.started).toEqual([])
    f.store.fault = undefined
    const inspected = await f.inspect('lost-ack')
    expect(inspected?.run).toMatchObject({ operationId: 'lost-ack', status: 'interrupted', admission: fault === 'after' ? 'confirmed' : 'unknown' })
    const repeated = await f.start('lost-ack', [{ ...target('a'), parameters: { entry: 'replacement' } }])
    expect(repeated.status).toBe('interrupted')
    expect(f.started).toEqual([])
  })

  it('retains original root IDs, cursor, queued targets and cold Profile references across owner restart', async () => {
    const f = await fixture(1); f.hold('browser-a')
    await f.start('restart-set', [target('a', 'shared'), target('b', 'shared')])
    await vi.waitFor(async () => expect((await f.inspect('restart-set'))?.targets[0]?.run?.status).toBe('running'))
    const before = (await f.inspect('restart-set'))!, originalRun = before.targets[0]!.run!
    const restored = f.reload(); await restored.ready()
    const after = (await restored.inspectParallel(source, 'restart-set'))!
    expect(after.run.status).toBe('interrupted')
    expect(after.targets[0]?.run).toEqual({ ...originalRun, status: 'interrupted' })
    expect(after.targets[1]).toMatchObject({ phase: 'queued' })
    expect(await restored.profileReferences('shared')).toHaveLength(2)
    expect((await f.start('restart-set', [target('a', 'shared'), target('b', 'shared')], 1)).status).toBe('interrupted')
    expect(f.started).toEqual(['browser-a'])
    await expect(restored.startParallel(source, f.asset.id, 1, { operationId: 'restart-set', targets: [target('a')] }, { runTask: vi.fn() })).rejects.toMatchObject({ code: 'BROWSER_TASK_PARALLEL_CONFLICT' })
    // The abandoned in-process reader is intentionally never released; its promise does not own restored work.
  })

  it('pages all retained operations and target rows without treating accumulated history as a transport carrier', async () => {
    const f = await fixture()
    for (let index = 0; index < 70; index++) {
      await f.start(`set-${index}`)
      await vi.waitFor(async () => expect((await f.inspect(`set-${index}`))?.run.status).toBe('completed'))
    }
    const seen: string[] = []; let before: string | undefined
    do {
      const page = await f.owner().listParallel(source, before, 13)
      seen.push(...page.runs.map(run => run.operationId)); before = page.page.nextBefore ?? undefined
    } while (before)
    expect(seen).toHaveLength(70); expect(new Set(seen).size).toBe(70); expect(seen.at(-1)).toBe('set-0')
    await f.reload().ready()
    expect((await f.owner().listParallel(source)).runs).toHaveLength(32)
    expect(f.store.document?.parallel).toHaveLength(70)
  }, 15_000)

  it('refuses public frame injection and foreign source identity while retaining original records', async () => {
    const f = await fixture(); await f.start('set')
    await vi.waitFor(async () => expect((await f.inspect('set'))?.run.status).toBe('completed'))
    const run = (await f.inspect('set'))!.targets[0]!.run!
    await expect(f.owner().run({ browserId: 'browser-a', assetId: f.asset.id, version: 1, runId: run.id, parameters: {} }, {} as any)).rejects.toThrow()
    await expect(f.owner().inspectParallel('other-source', 'set')).rejects.toMatchObject({ code: 'BROWSER_TASK_PARALLEL_NOT_FOUND' })
    expect(() => parseBrowserTaskControlPayload({ operation: 'browser.task.run', browserId: 'browser-a', assetId: f.asset.id, version: 1, parameters: {}, orchestration: { operationId: 'set' } })).toThrow()
    expect(() => parseBrowserTaskParallelInput({ operationId: 'bad', targets: [target('a'), target('a')] })).toThrow()
    const inspected = (await f.inspect('set'))!
    expect(() => parseBrowserTaskParallelInspection({ ...inspected, targets: [{ ...inspected.targets[0], run: undefined }] })).toThrow()
  })

  it('protects cold pending Profile references through the original recycle and purge guard', async () => {
    const f = await fixture(1); f.hold('browser-a')
    await f.start('cold-profile', [target('a', 'shared'), target('b', 'shared')])
    await vi.waitFor(() => expect(f.started).toHaveLength(1))
    const guard = createBrowserProfileUsage({ open: () => [], readSaved: async () => null,
      nativeUse: () => ({ status: 'idle', workers: 0, requests: 0, downloads: 0 }) as any,
      taskReferences: profile => f.owner().profileReferences(profile), deleteProfile: vi.fn() })
    await expect(guard.assertUnused('shared')).rejects.toMatchObject({ code: 'BROWSER_PROFILE_IN_USE', details: { tasks: expect.arrayContaining([{ operationId: 'cold-profile', targetId: 'b', browserId: 'browser-b' }]) } })
    await expect(guard.assertUnused('unrelated')).resolves.toBeUndefined()
    const unknown = createBrowserProfileUsage({ open: () => [], readSaved: async () => null,
      nativeUse: () => ({ status: 'idle' }) as any, taskReferences: async () => { throw Error('unavailable') }, deleteProfile: vi.fn() })
    await expect(unknown.assertUnused('shared')).rejects.toMatchObject({ code: 'BROWSER_PROFILE_USAGE_UNKNOWN' })
  })

  it('requires the real parent-directory persistence ACK before admitting a parallel target', async () => {
    const f = await fixture(), root = await mkdtemp(join(tmpdir(), 'task-parallel-ack-'))
    try {
      const file = new BrowserTaskAssetFileStore(join(root, 'assets.json'))
      await file.save(f.store.document!)
      const owner = new BrowserTaskAssets(file), runTask = vi.fn()
      await owner.ready(); directoryFault.path = root
      await expect(owner.startParallel(source, f.asset.id, 1, { operationId: 'directory-ack', targets: [target('a')] }, { runTask })).rejects.toMatchObject({ code: 'BROWSER_TASK_PARALLEL_UNCONFIRMED' })
      expect(directoryFault.hits).toBeGreaterThan(0); expect(runTask).not.toHaveBeenCalled()
      directoryFault.path = ''
      expect((await owner.inspectParallel(source, 'directory-ack'))?.run).toMatchObject({ operationId: 'directory-ack', admission: 'confirmed', status: 'interrupted' })
      expect(runTask).not.toHaveBeenCalled()
    } finally { directoryFault.path = ''; await rm(root, { recursive: true, force: true }) }
  })

  it('checks the selected Profile identity rather than granting an Agent permission from another Profile', async () => {
    const gate = createBrowserAutomationGate({ automation: () => true, profileOf: async () => 'changed-profile', agentAccess: () => true })
    await expect(gate('target', { agentSessionId: 'agent' }, 'selected-profile')).rejects.toMatchObject({ code: 'CONTROL_REQUEST_CONFLICT' })
    const unknown = createBrowserAutomationGate({ automation: () => true, profileOf: async () => { throw Error('unavailable') }, agentAccess: () => true })
    await expect(unknown('target', { agentSessionId: 'agent' }, 'selected-profile')).rejects.toMatchObject({ code: 'BROWSER_PROFILE_AGENT_ACCESS_UNKNOWN' })
  })
})
