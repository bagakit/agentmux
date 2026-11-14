import { mkdtemp, rename, rm, stat, writeFile } from 'node:fs/promises'
import { appendFileSync, readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'
import ts from 'typescript'
import { connectAgentMuxRpc } from '@agentmux/core'
import { parseAgentMuxCliInvocation } from '../../../packages/core/src/agentmux-cli-commands'
import { BrowserOperationFileStore, BrowserOperationJournal, BROWSER_OPERATION_JOURNAL_FILE, browserOperationAlreadyExistsError } from '@agentmux/browser/browser-operation-journal'
import { serveStandaloneBrowser } from '@agentmux/browser/standalone'
import type { BrowserOperationPhase } from '@agentmux/browser/model/browser-operation'
import { runBrowserScript } from '@agentmux/browser/browser-script-runner'
import { browserRunResult, unwrapBrowserRunResult } from '../src/shared/browser-run-result'
import { createBrowserAutomationGate } from '../src/main/browser-automation-gate'

const facts: unknown[] = [], owned: string[] = []
const input = { browserId: 'private-browser', operator: { id: 'private-agent', name: 'Private Agent' }, summary: 'Original retained operation', url: 'https://example.test/' }
afterAll(async () => {
  for (const directory of owned) await rm(directory, { recursive: true, force: true })
  if (process.env.AGENTMUX_BROWSER_WINDOW_FACTS) await writeFile(process.env.AGENTMUX_BROWSER_WINDOW_FACTS, JSON.stringify({ facts, cleanup: 'All private SQLite directories removed; no App, native input or schema change.' }, null, 2) + '\n')
})
class ObservedStore extends BrowserOperationFileStore {
  readonly loadedEntities: { operations: number; steps: number }[] = []
  constructor(path: string, private readonly fullRead = false) { super(path) }
  override async load(window?: { maxOperations: number; protectedPhases: readonly BrowserOperationPhase[] }) {
    const document = await super.load(this.fullRead ? undefined : window)
    if (document) this.loadedEntities.push({ operations: document.operations.length, steps: document.operations.reduce((sum, operation) => sum + operation.steps.length, 0) })
    return document
  }
}
async function fixture(cold = 1000) {
  const directory = await mkdtemp(join(tmpdir(), 'amux-window-complete-')); owned.push(directory)
  const path = join(directory, 'journal.sqlite')
  const protectedPhases = ['running', 'human', 'indeterminate'] as const
  const operations = [...protectedPhases.map((phase, n) => ({ metadata: { ...input, id: 'protected-' + n, startedAt: n + 1, phase }, steps: [] })),
    ...Array.from({ length: cold }, (_, n) => ({ metadata: { ...input, id: 'cold-' + n, startedAt: n + 10, finishedAt: n + 11, phase: 'completed' as const }, steps: Array.from({ length: 5 }, (_, i) => ({ sequence: i + 1, method: 'snapshot', label: 'Private retained step', startedAt: i + 1, finishedAt: i + 2, status: 'completed' as const })) }))]
  await new BrowserOperationFileStore(path).save({ writer: 'original', revision: 1, operations, events: [], maxEvents: 512 })
  const store = new ObservedStore(path), journal = new BrowserOperationJournal(store)
  await journal.ready()
  return { directory, path, store, journal }
}

describe('BrowserOperationJournal bounded storage window', () => {
it('genuine empty startup remains lazy and admits its original first operation', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'amux-window-empty-')); owned.push(directory)
  const path = join(directory, 'journal.sqlite'), journal = new BrowserOperationJournal(new BrowserOperationFileStore(path))
  await expect(journal.list()).resolves.toEqual([])
  await expect(stat(path)).rejects.toMatchObject({ code: 'ENOENT' })
  expect(journal.getPersistenceWarning()).toBeUndefined()
  await expect(journal.start({ ...input, id: 'original-first' })).resolves.toMatchObject({ id: 'original-first' })
  expect(await new BrowserOperationJournal(new BrowserOperationFileStore(path)).get('original-first')).toMatchObject({ id: 'original-first', phase: 'indeterminate' })
})

it.each([100, 1000])('unrelated cold=%s changes identity coordinates, not loaded operation/step bodies', async cold => {
  const { store, journal, path } = await fixture(cold)
  expect(store.loadedEntities[0]).toEqual({ operations: 67, steps: 320 })
  expect(Reflect.get(store, 'positions').size).toBe(cold + 3)
  const observations = []
  // The existing full load API is the counterfactual, not a hand-built document or new product option.
  for (let n = 0; n < 4; n++) for (const full of n % 2 ? [false, true] : [true, false]) {
    const source = new ObservedStore(path, full), sample = new BrowserOperationJournal(source)
    const start = performance.now()
    await sample.ready()
    const ready = performance.now()
    const list = await sample.list()
    const end = performance.now()
    expect(list).toHaveLength(67)
    expect(source.loadedEntities[0]).toEqual({ operations: full ? cold + 3 : 67, steps: full ? cold * 5 : 320 })
    observations.push({ full, readyMs: ready - start, totalReadyAndListMs: end - start, entities: source.loadedEntities[0] })
  }
  expect(await journal.get('protected-0')).toMatchObject({ phase: 'indeterminate' })
  facts.push({ cold, initialBodies: store.loadedEntities[0], identityCoordinates: cold + 3, observations,
    boundary: 'Same original SQLite, same process alternating full/window. Total timings observational; identity index and native SQL still scale with history. No memory/App gain claim.' })
})

it('complete window keeps cold read, immutable native history order, subscribers and original step writer', async () => {
  const { journal, store, path } = await fixture()
  expect(Reflect.get(journal, 'operations').size).toBe(67)
  expect(Reflect.get(store, 'positions').size).toBe(1003)
  const history = await journal.list()
  const delivered = vi.fn(), subscription = await journal.subscribe('cold-0', undefined, delivered)
  expect(subscription.operation).toMatchObject({ id: 'cold-0', steps: expect.arrayContaining([expect.objectContaining({ sequence: 5 })]) })
  for (let n = 1; n < 11; n++) {
    expect(await journal.get('cold-' + n)).toMatchObject({ id: 'cold-' + n })
    expect(await journal.replayPlan('cold-' + n)).toMatchObject({ operationId: 'cold-' + n })
  }
  expect(Reflect.get(journal, 'operations').size).toBe(67)
  expect(Reflect.get(journal, 'steps').size).toBe(67)
  expect(Reflect.get(journal, 'document').operations.length).toBe(67)
  expect((await journal.list()).map(operation => operation.id)).toEqual(history.map(operation => operation.id))
  const next = await journal.startStep('cold-0', { method: 'snapshot', label: 'Original next step' })
  expect(next?.sequence).toBe(6)
  await journal.finishStep('cold-0', 6, { status: 'completed' })
  expect(delivered.mock.calls.map(([entry]) => entry.event.type)).toEqual(['step-started', 'step-finished'])
  await journal.setPhase('cold-0', 'waiting')
  expect((await journal.list()).map(operation => operation.id)).toEqual(['protected-0', 'protected-1', 'protected-2', 'cold-0', ...history.slice(3).map(operation => operation.id)])
  subscription.dispose()
  const reopened = new BrowserOperationJournal(new BrowserOperationFileStore(path))
  expect(await reopened.get('cold-0')).toMatchObject({ phase: 'indeterminate', steps: expect.arrayContaining([expect.objectContaining({ sequence: 6, status: 'completed' })]) })
  facts.push({ startupEntities: 67, startupPositions: 1003, coldReadAndOriginalOrder: true, originalStepNextSequence: 6, originalSubscription: true, restartedSameId: true })
})

it('known cold IDs never replay after readonly failure while fresh work uses original advisory', async () => {
  const { journal, store, path } = await fixture()
  await rename(path, path + '.offline')
  await expect(journal.get('cold-0')).rejects.toThrow()
  await expect(stat(path)).rejects.toMatchObject({ code: 'ENOENT' })
  await expect(journal.subscribe('cold-1', undefined, vi.fn())).rejects.toThrow()
  expect(Reflect.get(journal, 'subscribers').size).toBe(0)
  const save = vi.spyOn(store, 'save')
  const rejected = await Promise.allSettled(Array.from({ length: 20 }, () => journal.start({ ...input, id: 'cold-0' })))
  expect(rejected.every(result => result.status === 'rejected' && result.reason.code === 'BROWSER_OPERATION_ALREADY_EXISTS')).toBe(true)
  expect(save).not.toHaveBeenCalled()
  expect(await journal.get('fresh-unseen')).toBeNull()
  const delivered = vi.fn(), subscription = await journal.subscribe('fresh-unseen', undefined, delivered)
  await expect(journal.start({ ...input, id: 'fresh-unseen' })).resolves.toMatchObject({ id: 'fresh-unseen' })
  expect(journal.getPersistenceWarning()).toContain('temporarily missing')
  expect(delivered.mock.calls[0]?.[0].event).toMatchObject({ type: 'operation-started', operationId: 'fresh-unseen' })
  await expect(journal.start({ ...input, id: 'fresh-unseen' })).rejects.toMatchObject({ code: 'BROWSER_OPERATION_ALREADY_EXISTS' })
  subscription.dispose()
  await rename(path + '.offline', path)
  expect(await journal.get('cold-0')).toMatchObject({ id: 'cold-0', steps: expect.arrayContaining([expect.objectContaining({ sequence: 5 })]) })
  await journal.finish('fresh-unseen', 'completed')
  expect(await new BrowserOperationJournal(new BrowserOperationFileStore(path)).get('fresh-unseen')).toMatchObject({ id: 'fresh-unseen', phase: 'completed' })
  facts.push({ exactReadonlyFailure: 'unknown, no replacement file created', coldDuplicateRetries: 20, coldDuplicateSaves: 0, failedSubscriptionLeaks: 0, freshAdvisoryWork: true, originalStorageRestoredWithoutReseeding: true })
})

it('unknown get and follow skip both loaded-ID mapping and SQLite detail reads', async () => {
  const { journal, store } = await fixture()
  const map = vi.spyOn(Reflect.get(journal, 'document').operations, 'map'), read = vi.spyOn(store, 'readOperation')
  for (let n = 0; n < 20; n++) {
    expect(await journal.get('fresh-' + n)).toBeNull()
    expect(await journal.setPhase('fresh-' + n, 'running')).toBeNull()
    expect(await journal.startStep('fresh-' + n, { method: 'snapshot', label: 'Not an observed operation' })).toBeNull()
    const subscription = await journal.subscribe('fresh-' + n, undefined, vi.fn())
    expect(subscription.operation).toBeNull()
    subscription.dispose()
  }
  expect(map).not.toHaveBeenCalled(); expect(read).not.toHaveBeenCalled()
  expect(Reflect.get(journal, 'subscribers').size).toBe(0)
})

it('coordinates, window, steps and events share one SQLite snapshot across another writer', async () => {
  const { path } = await fixture()
  const writer = new DatabaseSync(path)
  writer.exec('PRAGMA journal_mode = WAL')
  const originalPrepare = DatabaseSync.prototype.prepare
  let writes = 0
  const intercepted = vi.spyOn(DatabaseSync.prototype, 'prepare').mockImplementation(function (this: DatabaseSync, sql: string) {
    if (!writes && sql.includes("COALESCE(json_extract(metadata, '$.phase')")) {
      writes++
      writer.exec('BEGIN IMMEDIATE')
      originalPrepare.call(writer, 'INSERT INTO writers(id) VALUES (?)').run('concurrent-writer')
      originalPrepare.call(writer, 'INSERT INTO operations(id, metadata, writer, revision) VALUES (?, ?, ?, ?)').run('new-after-snapshot', JSON.stringify({ ...input, id: 'new-after-snapshot', startedAt: 7, phase: 'running' }), 'concurrent-writer', 1)
      originalPrepare.call(writer, 'INSERT INTO steps(operation_id, sequence, body, writer, revision) VALUES (?, ?, ?, ?, ?)').run('new-after-snapshot', 1, JSON.stringify({ sequence: 1, method: 'snapshot', label: 'Private concurrent fact', startedAt: 7, status: 'running' }), 'concurrent-writer', 1)
      writer.exec('COMMIT')
    }
    return originalPrepare.call(this, sql)
  })
  try {
    const store = new ObservedStore(path), journal = new BrowserOperationJournal(store)
    await journal.ready()
    expect(writes).toBe(1)
    expect(store.loadedEntities[0]).toEqual({ operations: 67, steps: 320 })
    expect(Reflect.get(store, 'positions').size).toBe(1003)
    expect(await journal.get('new-after-snapshot')).toBeNull()
  } finally { intercepted.mockRestore(); writer.close() }
  const current = new BrowserOperationJournal(new BrowserOperationFileStore(path))
  expect(await current.get('new-after-snapshot')).toMatchObject({ id: 'new-after-snapshot', phase: 'indeterminate', steps: [expect.objectContaining({ sequence: 1, status: 'stopped' })] })
})

function exactMethod(name: string, ports: Record<string, unknown>) {
  const source = readFileSync('apps/desktop/src/main/browser-view-manager.ts', 'utf8'), file = ts.createSourceFile('browser-view-manager.ts', source, ts.ScriptTarget.Latest, true)
  const nodes: ts.Node[] = []
  const walk = (node: ts.Node) => { if (ts.isMethodDeclaration(node) && node.name.getText(file) === name) nodes.push(node); ts.forEachChild(node, walk) }
  walk(file); expect(nodes).toHaveLength(1)
  bindSource('apps/desktop/src/main/browser-view-manager.ts', source, nodes[0]!.getText(file), name)
  const code = ts.transpile(`const owner = {${nodes[0]!.getText(file)}}`, { target: ts.ScriptTarget.ES2022 })
  const owner = new Function(code + '; return owner')()
  return owner[name].bind(ports)
}
function actualBrowserHandler(name: string, ports: Record<string, unknown>) {
  const source = readFileSync('apps/desktop/src/main/ipc.ts', 'utf8'), file = ts.createSourceFile('ipc.ts', source, ts.ScriptTarget.Latest, true), nodes: ts.Node[] = []
  const walk = (node: ts.Node) => { if (ts.isCallExpression(node) && node.expression.getText(file) === 'handleWithEvent' && ts.isStringLiteral(node.arguments[0]!) && node.arguments[0].text === name) nodes.push(node.arguments[1]!); ts.forEachChild(node, walk) }
  walk(file); expect(nodes).toHaveLength(1)
  bindSource('apps/desktop/src/main/ipc.ts', source, nodes[0]!.getText(file), name)
  const code = ts.transpile(`const execute = ${nodes[0]!.getText(file)}`, { target: ts.ScriptTarget.ES2022 })
  return new Function(...Object.keys(ports), code + ';return execute')(...Object.values(ports))
}

function bindSource(path: string, source: string, selected: string, name: string) {
  if (process.env.AGENTMUX_PERFORMANCE_LOADED) {
    const hash = (value: string) => createHash('sha256').update(value).digest('hex')
    appendFileSync(process.env.AGENTMUX_PERFORMANCE_LOADED, JSON.stringify({ path, sha256: hash(source), selectedSHA256: hash(selected), name, kind: 'actual-original-consumer' }) + '\n')
  }
}

it('original Main IPC and exact manager consumers read cold original IDs before acquiring any page', async () => {
  const { journal, path } = await fixture()
  const owner = { operationJournal: journal, entries: new Map() }
  const getOperation = exactMethod('getOperation', owner), listOperationHistory = exactMethod('listOperationHistory', owner)
  const history = await listOperationHistory()
  expect(history).toHaveLength(67)
  expect(await getOperation('cold-0')).toMatchObject({ id: 'cold-0', phase: 'completed' })
  const runScript = vi.fn(async (_id: string, code: string, _operator: unknown, _replayOf: unknown, operationId: string) => {
    const operation = await journal.start({ ...input, id: operationId })
    const result = await runBrowserScript({ code })
    if (!result.completed) throw new Error('Private script runner did not complete')
    return { result: result.value, logs: result.logs, outcome: { kind: 'completed' as const }, runOperation: (await journal.finish(operationId, 'completed')) ?? operation }
  }), ensureBrowser = vi.fn()
  const handle = actualBrowserHandler('browser:runScript', { browsers: { getOperation, runScript }, ensureBrowser,
    browserAutomation: createBrowserAutomationGate({ automation: () => true, profileOf: async () => null, agentAccess: () => true }), config: { browser: { agentAutomation: true } }, browserRunResult, browserOperationAlreadyExistsError,
    externalBrowsers: { has: () => false, runScript: vi.fn() }, externalBridge: { require: vi.fn() }, workspace: vi.fn() })
  expect(await handle({}, input.browserId, 'return 1', input.operator, 'cold-1')).toMatchObject({ ok: false, error: { code: 'BROWSER_OPERATION_ALREADY_EXISTS' } })
  expect(runScript).not.toHaveBeenCalled(); expect(ensureBrowser).not.toHaveBeenCalled()
  await rename(path, path + '.offline')
  expect(await handle({}, input.browserId, 'return 1', input.operator, 'cold-2')).toMatchObject({ ok: false })
  expect(runScript).not.toHaveBeenCalled(); expect(ensureBrowser).not.toHaveBeenCalled()
  const fresh = unwrapBrowserRunResult(structuredClone(await handle({}, input.browserId, 'return {healthy:"原路🙂"}', input.operator, 'fresh-main-original')))
  expect(fresh).toMatchObject({ result: { healthy: '原路🙂' }, runOperation: { id: 'fresh-main-original', phase: 'completed' } })
  expect(ensureBrowser).toHaveBeenCalledExactlyOnceWith(input.browserId)
  expect(journal.getPersistenceWarning()).toContain('temporarily missing')
  facts.push({ actualMainManagerGetAndHistory: true, actualIPC: true, actualPermissionGate: true, coldDuplicatePageAcquisitions: 0, coldUnknownPageAcquisitions: 0, freshOriginalCarrierAndScriptRunnerWithAdvisory: true })
})

it('Desktop history applies the original Browser scope before the warm window', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'amux-window-scoped-warm-')); owned.push(directory)
  const journal = new BrowserOperationJournal(new BrowserOperationFileStore(join(directory, BROWSER_OPERATION_JOURNAL_FILE)), { maxOperations: 2 })
  await journal.start({ ...input, id: 'original-protected' })
  for (const [id, browserId] of [['original-outside', input.browserId], ['original-1', input.browserId], ['original-2', input.browserId], ['busy-1', 'busy'], ['busy-2', 'busy']] as const) {
    await journal.start({ ...input, id, browserId })
    await journal.startStep(id, { method: 'snapshot', label: 'Original step' })
    await journal.finishStep(id, 1, { status: 'completed' })
    await journal.finish(id, 'completed')
  }
  const listOperationHistory = exactMethod('listOperationHistory', { operationJournal: journal })
  const history = actualBrowserHandler('browser:listOperationHistory', { browsers: { listOperationHistory } })
  expect((await history({})).map((value: { id: string }) => value.id)).toEqual(['original-protected', 'busy-1', 'busy-2'])
  const scoped = await history({}, input.browserId)
  expect(scoped.map((value: { id: string }) => value.id)).toEqual(['original-protected', 'original-1', 'original-2'])
  expect(scoped[1]).toMatchObject({ browserId: input.browserId, steps: [{ sequence: 1, method: 'snapshot', status: 'completed' }] })
  expect(await history({}, 'absent')).toEqual([])
})

it('keeps scoped history unknown when original recovery never loaded the protected operations', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'amux-window-scoped-unconfirmed-')); owned.push(directory)
  const path = join(directory, BROWSER_OPERATION_JOURNAL_FILE)
  await new BrowserOperationJournal(new BrowserOperationFileStore(path)).start({ ...input, id: 'original-pending' })
  const database = new DatabaseSync(path)
  try { database.exec("UPDATE events SET body = 'unreadable'") } finally { database.close() }
  const journal = new BrowserOperationJournal(new BrowserOperationFileStore(path))
  await journal.ready()
  expect(journal.getPersistenceWarning()).toContain('unavailable')
  await expect(journal.list(input.browserId)).rejects.toThrow('Original Browser history could not be loaded')
  await expect(journal.start({ ...input, id: 'healthy-live' })).resolves.toMatchObject({ id: 'healthy-live' })
  await expect(journal.get('healthy-live')).resolves.toMatchObject({ id: 'healthy-live', phase: 'preparing' })
  await expect(journal.list(input.browserId)).rejects.toThrow()
})

it('standalone CLI history restores the same scoped steps cold after unrelated writes', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'amux-history-rpc-')); owned.push(directory)
  const path = join(directory, BROWSER_OPERATION_JOURNAL_FILE)
  const original = Array.from({ length: 66 }, (_, n) => ({
    metadata: { ...input, id: 'original-' + n, startedAt: 10, finishedAt: 11, phase: 'completed' as const },
    steps: [{ sequence: 1, method: 'snapshot', label: 'Original step', startedAt: 10, status: 'completed' as const }]
  }))
  const unrelated = Array.from({ length: 140 }, (_, n) => ({
    metadata: { ...input, id: 'busy-' + n, browserId: 'busy', startedAt: 10, finishedAt: 11, phase: 'completed' as const }, steps: []
  }))
  const protectedOperation = { metadata: { ...input, id: 'original-interrupted', startedAt: 1, phase: 'running' as const }, steps: [] }
  await new BrowserOperationFileStore(path).save({ writer: 'original', revision: 1, operations: [protectedOperation, ...original, ...unrelated], events: [], maxEvents: 512 })
  const socketPath = join(directory, 'control.sock')
  const host = await serveStandaloneBrowser({ directory, executablePath: join(directory, 'unused-executable'), socketPath })
  try {
    const args = await parseAgentMuxCliInvocation(['browser', 'history', '--browser', input.browserId])
    expect(args.command.method).toBe('browser.history')
    const client = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: socketPath } })
    try {
      const history = await client.call('browser.history', args.params as { browserId: string })
      expect(history.operations.map(operation => operation.id)).toEqual(['original-interrupted', ...original.slice(-64).map(operation => operation.metadata.id)])
      expect(history.operations[0]?.phase).toBe('indeterminate')
      expect(history.operations[1]?.steps).toMatchObject([{ sequence: 1, method: 'snapshot', status: 'completed' }])
      expect((await client.call('browser.history', {})).operations.map(operation => operation.id)).toEqual(['original-interrupted', ...unrelated.slice(-64).map(operation => operation.metadata.id)])
      expect((await client.call('browser.inspect', { operationId: 'original-0' })).runOperation).toMatchObject({ id: 'original-0' })
    } finally { await client.dispose() }
  } finally { await host.stop() }

  const store = new BrowserOperationFileStore(path)
  const journal = new BrowserOperationJournal(store, { maxOperations: 2 })
  await journal.ready()
  await journal.setPhase('original-0', 'waiting')
  await journal.start({ ...input, id: 'new-original' })
  await journal.finish('new-original', 'completed')
  const read = vi.spyOn(store, 'readOperations')
  const expected = ['original-interrupted', 'original-0', 'original-65', 'new-original']
  const scoped = await journal.list(input.browserId)
  expect(scoped.map(operation => operation.id)).toEqual(expected)
  expect(scoped[1]?.phase).toBe('waiting')
  expect(read).toHaveBeenCalledExactlyOnceWith(['original-65'])
  await rename(path, path + '.offline')
  try {
    await expect(journal.list(input.browserId)).rejects.toThrow()
    await expect(journal.get('new-original')).resolves.toMatchObject({ id: 'new-original', phase: 'completed' })
    await expect(stat(path)).rejects.toMatchObject({ code: 'ENOENT' })
  } finally { await rename(path + '.offline', path) }
  expect((await journal.list(input.browserId)).map(operation => operation.id)).toEqual(expected)
})

})
