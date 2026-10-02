import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { AgentMuxControlServer, BROWSER_COMPLETION_UNAVAILABLE_WARNING,
  connectAgentMuxRpc, type AgentMuxRpcClient, type AgentMuxRpcStreamInitial, type AgentMuxControlBrowserEvent,
  type AgentMuxControlBrowserOperation, type AgentMuxControlHost } from '@agentmux/core'
import { BrowserOperationFileStore, BrowserOperationJournal,
  type BrowserOperationJournalDocument, type BrowserOperationJournalStore } from '../src/main/browser-operation-journal'
import { projectBrowserControlEvent, projectBrowserControlOperation, projectBrowserControlResult } from '../src/main/browser-completion-control'
import type { BrowserOutcomeEvaluation, BrowserOutcomeRegistration } from '../src/shared/browser-outcome-criteria'

const context = { workspaceId: 'workspace-a', browserId: 'browser-a', operationId: 'operation-a', navigationId: 'navigation-a' }
const assetRun = { runId: 'asset-run-a', assetId: 'asset-a', version: 3 }
const registration: BrowserOutcomeRegistration = { context, assetRun, criteria: [{ kind: 'field-equals', key: 'result', expected: false,
  producer: { operationId: context.operationId, navigationId: context.navigationId, sequence: 1,
    request: { fields: [{ key: 'result', type: 'boolean', source: { selector: '#private-producer-selector', read: 'checked' } }] } } }] }
const evaluation: BrowserOutcomeEvaluation = { context, assetRun, status: 'passed', conditions: [
  { criterion: { kind: 'field-equals', key: 'result', expected: false }, status: 'passed', reason: 'The declared field matches.' }
] }
const roots: string[] = [], servers: AgentMuxControlServer[] = [], clients: AgentMuxRpcClient[] = [], disposers: Array<() => void | Promise<void>> = []
afterEach(async () => {
  for (const dispose of disposers.splice(0)) await dispose()
  for (const client of clients.splice(0)) await client.dispose()
  for (const server of servers.splice(0)) await server.stop()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})
async function root() { const path = await mkdtemp(join(tmpdir(), 'amux-completion-control-')); roots.push(path); return path }
async function completed(journal: BrowserOperationJournal) {
  await journal.start({ id: context.operationId, browserId: context.browserId, operator: { id: 'person', name: 'Person' }, summary: 'Check', url: 'https://generic.invalid/form' })
  await journal.registerOutcome(context.operationId, registration)
  await journal.startStep(context.operationId, { method: 'extractStructured', label: 'Observe' })
  await journal.finishStep(context.operationId, 1, { status: 'completed' })
  await journal.finish(context.operationId, 'completed')
}
async function host(path: string, journal: BrowserOperationJournal, delivery: 'microtask' | 'sync' = 'microtask') {
  const control: AgentMuxControlHost = {
    async execute(request) {
      if (request.operation === 'browser.history') return projectBrowserControlResult({ operation: request.operation, operations: await journal.list() })
      if (request.operation === 'browser.operation') return projectBrowserControlResult({ operation: request.operation, runOperation: await journal.get(request.operationId) })
      throw new Error('Unexpected fixture operation')
    },
    async subscribeBrowserOperation(request, onEvent) {
      const subscription = await journal.subscribe(request.operationId, request.afterSequence,
        item => onEvent({ sequence: item.sequence, event: projectBrowserControlEvent(item.event) }))
      const replay = () => { for (const item of subscription.backlog) onEvent({ sequence: item.sequence, event: projectBrowserControlEvent(item.event) }) }
      if (delivery === 'sync') replay()
      else queueMicrotask(replay)
      return { runOperation: projectBrowserControlOperation(subscription.operation), gap: subscription.gap, dispose: subscription.dispose }
    }
  }
  const server = new AgentMuxControlServer({ ...control, socketPath: path, coreClients: () => [] }); servers.push(server); await server.start(); return server
}
const historyParams = { browserId: context.browserId }
async function rpc(socketPath: string) {
  const client = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: socketPath } })
  clients.push(client); return client
}
async function follow(socketPath: string, operationId: string, afterSequence: number | undefined, events: AgentMuxControlBrowserEvent[]) {
  let initial!: AgentMuxRpcStreamInitial<'browser.follow'>
  const opened = await (await rpc(socketPath)).subscribe('browser.follow', { operationId,
    ...(afterSequence === undefined ? {} : { afterSequence }) }, {
    onInitial: value => { initial = value },
    onEvent: event => { if (event.type === 'progress') events.push(event.data) }
  })
  disposers.push(() => opened.dispose())
  return { ...initial, dispose: () => opened.dispose() }
}

it('exposes exact Main completion through the public socket, history, operation, live event and ordinary file-store restart', async () => {
  const path = await root(), journalPath = join(path, 'journal.json'), socket = join(path, 'control.sock')
  const journal = new BrowserOperationJournal(new BrowserOperationFileStore(journalPath))
  await completed(journal)
  const server = await host(socket, journal)
  const before = await (await rpc(socket)).call('browser.history', historyParams)
  expect(before.operations.map(operation => [operation.id, operation.phase, operation.completion])).toEqual([[context.operationId, 'completed', undefined]])
  const events: AgentMuxControlBrowserEvent[] = []
  const opened = await follow(socket, context.operationId, 4, events)
  expect(opened.runOperation?.completion).toBeUndefined()
  expect((await journal.recordOutcome(context.operationId, evaluation))?.saved).toBe(true)
  await vi.waitFor(() => expect(events).toHaveLength(1), { timeout: 1500 })
  expect(events).toHaveLength(1)
  const event = events[0]!.event as { type: string; operation: AgentMuxControlBrowserOperation }
  expect(event.type).toBe('operation-checked')
  expect(event.operation.completion).toEqual(evaluation)
  const after = await (await rpc(socket)).call('browser.history', historyParams)
  expect(after.operations).toHaveLength(1)
  expect(after.operations[0]!.completion).toEqual(evaluation)
  expect(JSON.stringify([after, event])).not.toContain('private-producer-selector')
  expect(JSON.stringify([after, event])).not.toContain('registration')
  const operation = await (await rpc(socket)).call('browser.inspect', { operationId: context.operationId })
  expect(operation.runOperation?.completion).toEqual(evaluation)
  await opened.dispose(); await server.stop()
  const restarted = new BrowserOperationJournal(new BrowserOperationFileStore(journalPath))
  await host(socket, restarted)
  const recovered = await (await rpc(socket)).call('browser.history', historyParams)
  expect(recovered.operations[0]!.completion).toEqual(evaluation)
  const backlog = await restarted.subscribe(context.operationId, 4, () => {})
  disposers.push(backlog.dispose)
  expect(backlog.backlog.map(item => item.event.type)).toEqual(['operation-checked'])
  expect((await restarted.get(context.operationId))?.steps.map(step => [step.method, step.status])).toEqual([['extractStructured', 'completed']])
})

it('delivers one truthful checked event after the optional save acknowledges, including a failed save notice', async () => {
  let release!: () => void, entered = false, hold = false
  const ack = new Promise<void>(resolve => { release = resolve })
  const store: BrowserOperationJournalStore = { async load() { return { version: 1, operations: [], events: [] } },
    async save(_document: BrowserOperationJournalDocument) { if (hold) { entered = true; await ack; throw new Error('Private optional store failure') } } }
  const journal = new BrowserOperationJournal(store)
  await completed(journal)
  const events: unknown[] = [], subscription = await journal.subscribe(context.operationId, 4, item => events.push(projectBrowserControlEvent(item.event)))
  disposers.push(subscription.dispose); hold = true
  const checking = journal.recordOutcome(context.operationId, evaluation)
  await vi.waitFor(() => expect(entered).toBe(true), { timeout: 1500 })
  expect(events).toEqual([])
  release()
  expect((await checking)?.saved).toBe(false)
  expect(events).toHaveLength(1)
  const event = events[0] as { type: string; operation: AgentMuxControlBrowserOperation }
  expect(event.type).toBe('operation-checked')
  expect(event.operation.phase).toBe('completed')
  expect(event.operation.completion?.warning).toContain('could not be saved')
  expect(JSON.stringify(event)).not.toContain('Private optional store failure')
  expect((await journal.get(context.operationId))?.outcome?.evaluation).toEqual(event.operation.completion)
})

it('removes an invalid optional projection at both boundaries while preserving healthy operations and existing notices', async () => {
  const path = await root(), journal = new BrowserOperationJournal(new BrowserOperationFileStore(join(path, 'journal.json')))
  await completed(journal)
  const operation = (await journal.get(context.operationId))!
  const invalid = { ...evaluation, context: { ...context, operationId: 'foreign' } }
  const outgoing = projectBrowserControlOperation({ ...operation, warning: 'Existing notice.', outcome: { evaluation: invalid } })
  expect(outgoing.completion).toBeUndefined()
  expect(outgoing.warning).toBe(`Existing notice. ${BROWSER_COMPLETION_UNAVAILABLE_WARNING}`)
  expect(outgoing.phase).toBe('completed')
  expect(outgoing).not.toHaveProperty('outcome')
  const { outcome: _outcome, ...withoutOutcome } = operation
  expect(projectBrowserControlOperation({ ...withoutOutcome, completion: evaluation }).completion).toBeUndefined()
  const socket = join(path, 'raw.sock')
  const server = new AgentMuxControlServer({ socketPath: socket, coreClients: () => [], async execute() { return { operation: 'browser.history', operations: [
    { ...operation, warning: 'Existing notice.', completion: invalid }, { ...operation, id: 'healthy-other', outcome: undefined }
  ] } } })
  servers.push(server); await server.start()
  const result = await (await rpc(socket)).call('browser.history', historyParams)
  expect(result.operations.map(item => [item.id, item.phase, item.completion, item.warning])).toEqual([
    [context.operationId, 'completed', undefined, `Existing notice. ${BROWSER_COMPLETION_UNAVAILABLE_WARNING}`],
    ['healthy-other', 'completed', undefined, undefined]
  ])
})

it('preserves ACK order and exactly-once facts for a public socket opened while FileStore acknowledgement is pending', async () => {
  const path = await root(), journalPath = join(path, 'journal.json'), socket = join(path, 'control.sock')
  const fileStore = new BrowserOperationFileStore(journalPath)
  let hold = false, entered = false, release!: () => void
  const ack = new Promise<void>(resolve => { release = resolve })
  const journal = new BrowserOperationJournal({ load: () => fileStore.load(), async save(document) {
    if (hold) { hold = false; entered = true; await ack; throw new Error('Private optional store failure') }
    await fileStore.save(document)
  } })
  await completed(journal)
  const server = await host(socket, journal)
  hold = true
  const checking = journal.recordOutcome(context.operationId, evaluation)
  try {
    await vi.waitFor(() => expect(entered).toBe(true), { timeout: 1500 })
    const own: AgentMuxControlBrowserEvent[] = [], other: AgentMuxControlBrowserEvent[] = []
    const opened = await follow(socket, context.operationId, 4, own)
    const healthy = await follow(socket, 'operation-b', undefined, other)
    await journal.setPhase(context.operationId, 'human')
    await journal.start({ id: 'operation-b', browserId: 'browser-b', operator: { id: 'person', name: 'Person' }, summary: 'Other healthy work', url: 'https://generic.invalid/other' })
    await vi.waitFor(() => expect(other.map(item => [item.sequence, (item.event as { type: string }).type])).toEqual([[7, 'operation-started']]), { timeout: 1500 })
    expect(own).toEqual([])
    release(); const reply = await checking
    expect(reply?.saved).toBe(false)
    await vi.waitFor(() => expect(own).toHaveLength(2), { timeout: 1500 })
    expect(own.map(item => [item.sequence, (item.event as { type: string }).type])).toEqual([[5, 'operation-checked'], [6, 'phase-changed']])
    const checked = own[0]!.event as { type: string; operation: AgentMuxControlBrowserOperation }
    expect(checked.operation.completion).toEqual({ ...evaluation, warning: expect.stringContaining('could not be saved') })
    expect(JSON.stringify(checked)).not.toContain('Private optional store failure')
    expect(JSON.stringify(checked)).not.toContain('private-producer-selector')
    const operation = await (await rpc(socket)).call('browser.inspect', { operationId: context.operationId })
    expect(operation.runOperation?.completion).toEqual(checked.operation.completion)
    await journal.finish(context.operationId, 'completed') // a later healthy save persists the retained failed-save notice
    await opened.dispose(); await healthy.dispose(); await server.stop()
    const restarted = new BrowserOperationJournal(new BrowserOperationFileStore(journalPath))
    const restartedSocket = join(path, 'restarted.sock')
    await host(restartedSocket, restarted)
    const recovered: AgentMuxControlBrowserEvent[] = []
    const reopened = await follow(restartedSocket, context.operationId, 4, recovered)
    await vi.waitFor(() => expect(recovered).toHaveLength(3), { timeout: 1500 })
    expect(recovered.map(item => [item.sequence, (item.event as { type: string }).type])).toEqual([[5, 'operation-checked'], [6, 'phase-changed'], [8, 'operation-finished']])
    expect(reopened.runOperation?.completion).toEqual(checked.operation.completion)
    const recoveredChecked = recovered[0]!.event as { operation: AgentMuxControlBrowserOperation }
    expect(recoveredChecked.operation.completion).toEqual(checked.operation.completion)
  } finally { release(); await checking }
})


it('opens before a synchronous host replay and preserves the first real completion event', async () => {
  const path = await root(), socket = join(path, 'sync.sock')
  const journal = new BrowserOperationJournal(new BrowserOperationFileStore(join(path, 'journal.json')))
  await completed(journal)
  expect((await journal.recordOutcome(context.operationId, evaluation))?.saved).toBe(true)
  await host(socket, journal, 'sync')
  const events: AgentMuxControlBrowserEvent[] = []
  const opened = await follow(socket, context.operationId, 4, events)
  expect(opened.runOperation?.completion).toEqual(evaluation)
  await vi.waitFor(() => expect(events).toHaveLength(1), { timeout: 1500 })
  expect(events.map(item => [item.sequence, (item.event as { type: string }).type])).toEqual([[5, 'operation-checked']])
  expect((events[0]!.event as { operation: AgentMuxControlBrowserOperation }).operation.completion).toEqual(evaluation)
})
