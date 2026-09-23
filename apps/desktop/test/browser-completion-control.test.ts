import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { AgentMuxControlServer, AGENTMUX_CONTROL_SCHEMA_VERSION, BROWSER_COMPLETION_UNAVAILABLE_WARNING,
  requestAgentMuxControl, subscribeAgentMuxControl, type AgentMuxControlBrowserEvent,
  type AgentMuxControlBrowserOperation, type AgentMuxControlHost } from '@agentmux/core'
import { BrowserOperationFileStore, BrowserOperationJournal,
  type BrowserOperationJournalDocument, type BrowserOperationJournalStore } from '../src/main/browser-operation-journal'
import { projectBrowserControlEvent, projectBrowserControlOperation, projectBrowserControlResult } from '../src/main/browser-completion-control'
import type { BrowserOutcomeEvaluation, BrowserOutcomeRegistration } from '../src/shared/browser-outcome-criteria'

const context = { workspaceId: 'workspace-a', browserId: 'browser-a', operationId: 'operation-a', navigationId: 'navigation-a' }
const registration: BrowserOutcomeRegistration = { context, criteria: [{ kind: 'field-equals', key: 'result', expected: false,
  producer: { operationId: context.operationId, navigationId: context.navigationId, sequence: 1,
    request: { fields: [{ key: 'result', type: 'boolean', source: { selector: '#private-producer-selector', read: 'checked' } }] } } }] }
const evaluation: BrowserOutcomeEvaluation = { context, status: 'passed', conditions: [
  { criterion: { kind: 'field-equals', key: 'result', expected: false }, status: 'passed', reason: 'The declared field matches.' }
] }
const roots: string[] = [], servers: AgentMuxControlServer[] = [], disposers: Array<() => void> = []
afterEach(async () => {
  for (const dispose of disposers.splice(0)) dispose()
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
async function host(path: string, journal: BrowserOperationJournal) {
  const control: AgentMuxControlHost = {
    async execute(request) {
      if (request.operation === 'browser.history') return projectBrowserControlResult({ operation: request.operation, operations: await journal.list() })
      if (request.operation === 'browser.operation') return projectBrowserControlResult({ operation: request.operation, runOperation: await journal.get(request.operationId) })
      throw new Error('Unexpected fixture operation')
    },
    async subscribeBrowserOperation(request, onEvent) {
      const subscription = await journal.subscribe(request.operationId, request.afterSequence,
        item => onEvent({ sequence: item.sequence, event: projectBrowserControlEvent(item.event) }))
      queueMicrotask(() => { for (const item of subscription.backlog) onEvent({ sequence: item.sequence, event: projectBrowserControlEvent(item.event) }) })
      return { runOperation: projectBrowserControlOperation(subscription.operation), gap: subscription.gap, dispose: subscription.dispose }
    }
  }
  const server = new AgentMuxControlServer(control, path); servers.push(server); await server.start(); return server
}
const historyRequest = { schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION, requestId: 'history', operation: 'browser.history' as const, browserId: context.browserId }

it('exposes exact Main completion through the public socket, history, operation, live event and ordinary file-store restart', async () => {
  const path = await root(), journalPath = join(path, 'journal.json'), socket = join(path, 'control.sock')
  const journal = new BrowserOperationJournal(new BrowserOperationFileStore(journalPath))
  await completed(journal)
  const server = await host(socket, journal)
  const before = await requestAgentMuxControl(historyRequest, socket)
  expect(before.operation).toBe('browser.history')
  if (before.operation !== 'browser.history') throw new Error('Wrong receipt')
  expect(before.result.operations.map(operation => [operation.id, operation.phase, operation.completion])).toEqual([[context.operationId, 'completed', undefined]])
  const events: AgentMuxControlBrowserEvent[] = []
  const opened = await subscribeAgentMuxControl({ schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION, requestId: 'subscribe', operation: 'browser.subscribe', operationId: context.operationId, afterSequence: 4 }, { onEvent: item => { events.push(item) } }, socket)
  disposers.push(opened.dispose)
  expect(opened.runOperation?.completion).toBeUndefined()
  expect((await journal.recordOutcome(context.operationId, evaluation))?.saved).toBe(true)
  await vi.waitFor(() => expect(events).toHaveLength(1), { timeout: 1500 })
  expect(events).toHaveLength(1)
  const event = events[0]!.event as { type: string; operation: AgentMuxControlBrowserOperation }
  expect(event.type).toBe('operation-checked')
  expect(event.operation.completion).toEqual(evaluation)
  const after = await requestAgentMuxControl(historyRequest, socket)
  if (after.operation !== 'browser.history') throw new Error('Wrong receipt')
  expect(after.result.operations).toHaveLength(1)
  expect(after.result.operations[0]!.completion).toEqual(evaluation)
  expect(JSON.stringify([after, event])).not.toContain('private-producer-selector')
  expect(JSON.stringify([after, event])).not.toContain('registration')
  const operation = await requestAgentMuxControl({ schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION, requestId: 'operation', operation: 'browser.operation', operationId: context.operationId }, socket)
  if (operation.operation !== 'browser.operation') throw new Error('Wrong receipt')
  expect(operation.result.runOperation?.completion).toEqual(evaluation)
  opened.dispose(); await server.stop()
  const restarted = new BrowserOperationJournal(new BrowserOperationFileStore(journalPath))
  await host(socket, restarted)
  const recovered = await requestAgentMuxControl(historyRequest, socket)
  if (recovered.operation !== 'browser.history') throw new Error('Wrong receipt')
  expect(recovered.result.operations[0]!.completion).toEqual(evaluation)
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
  expect(projectBrowserControlOperation({ ...operation, outcome: undefined, completion: evaluation }).completion).toBeUndefined()
  const socket = join(path, 'raw.sock')
  const server = new AgentMuxControlServer({ async execute() { return { operation: 'browser.history', operations: [
    { ...operation, warning: 'Existing notice.', completion: invalid }, { ...operation, id: 'healthy-other', outcome: undefined }
  ] } } }, socket)
  servers.push(server); await server.start()
  const result = await requestAgentMuxControl(historyRequest, socket)
  if (result.operation !== 'browser.history') throw new Error('Wrong receipt')
  expect(result.result.operations.map(item => [item.id, item.phase, item.completion, item.warning])).toEqual([
    [context.operationId, 'completed', undefined, `Existing notice. ${BROWSER_COMPLETION_UNAVAILABLE_WARNING}`],
    ['healthy-other', 'completed', undefined, undefined]
  ])
})
