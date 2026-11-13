// @vitest-environment happy-dom
import { fixtureEpoch as _newTailFixtureEpoch } from "../../../test/fixture-values.mjs"
import { act } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { join, resolve } from 'node:path'
import { AgentMuxControlServer, agentInputSubmissionStatus, type AgentInputSubmissionReceipt, type AgentTimelineItem } from '@agentmux/core'
import { projectSessionUserMessages } from '@agentmux/core/session-user-messages'
import { createHistoryQueryFixture } from '../../../packages/core/test/helpers/session-history-query'
import { objectCliEnvironment, runCompiledObjectCli } from '../../../packages/core/test/helpers/object-cli-rpc'
import { fixture, raw } from './helpers/native-async-question-fixture'
import { composerDOM, composerSession } from './helpers/composer-dom-fixture'
import { SessionMailbox } from '../src/renderer/src/components/SessionMailbox'
import { AgentSessionComposer } from '../src/renderer/src/components/AgentSessionComposer'
import { createMailboxMessagesSelector } from '../src/renderer/src/lib/session-mailbox-messages'
import { api } from '../src/renderer/src/lib/api'
import { useAppStore } from '../src/renderer/src/store'

const dom = composerDOM(), cleanups: Array<() => Promise<unknown>> = []
const system = { available: true, notices: [], unread: [], acknowledge: vi.fn() }
const body = Array.from({ length: 32 }, (_, index) => `Original line ${index}: every word retained`).join('\n')
const panel = () => dom.container.querySelector<HTMLElement>('.composer-mailbox')!
async function open() {
  for (const type of ['beforetoggle', 'toggle']) {
    const event = new Event(type); Object.defineProperty(event, 'newState', { value: 'open' })
    await act(async () => panel().dispatchEvent(event))
  }
  await dom.click('[role="tab"][id$="-user-tab"]')
}
async function read(key: string) {
  const row = [...panel().querySelectorAll<HTMLButtonElement>('.composer-mailbox__row')].find(row => row.dataset.recordKey === key)
  expect(row, key).toBeDefined(); await act(async () => row!.click())
}
function captured(agentSessionId: string, id: string, status: AgentTimelineItem['status'] = 'complete'): AgentTimelineItem {
  return { agentSessionId, id, kind: 'user_message', source: 'user', title: 'Original input', status, content: body, createdAt: _newTailFixtureEpoch(0, 0, 1), updatedAt: _newTailFixtureEpoch(0, 0, 1) }
}
function inputReceipt(agentSessionId: string, runId: string, operationId: string, state: 'enabled' | 'dispatch-authorized'): AgentInputSubmissionReceipt {
  const key = { kind: 'prompt' as const, agentSessionId, expectedRun: { runId }, submissionId: operationId }, ref = { key, waitGeneration: 1 }
  const control = { ref, state, at: _newTailFixtureEpoch(0, 0, 1), ...(state === 'enabled' ? { waiting: { phase: 'runtime' as const, reason: 'runtime-unavailable' as const, wake: 'runtime-restored' as const } } : { gateId: 'original-gate' }) }
  return { key, ref, persistence: 'confirmed', control, admission: null, status: agentInputSubmissionStatus(control, null), observation: 'rejoin-needed' }
}
beforeEach(() => {
  vi.stubEnv('AGENTMUX_TEST_OBJECT_CLI', resolve('packages/core/bin/amux'))
  useAppStore.setState({ noticeReadReceipts: {}, timelines: {}, agentSteerInFlight: {}, agentSteerInFlightPhase: {} })
  vi.spyOn(api.continuousProgress, 'list').mockResolvedValue([])
  vi.spyOn(api.sessions, 'observeHistory').mockResolvedValue({ dispose: vi.fn() })
})
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); vi.unstubAllEnvs() })

it('mounted original Mailbox keeps unknown delivery, exact record refs and native question answers on Inputs', async () => {
  const f = await fixture(), page = await f.client.sessionHistoryPage(f.input.agentSessionId, f.invocation)
  const session = { ...composerSession(f.input.agentSessionId), control: { kind: 'agent' as const, hostId: 'local', agentSessionId: f.input.agentSessionId, run: f.input.expectedRun } }
  const incoming = { ...captured(session.id, 'incoming'), authorAgentSessionId: 'original-peer' }
  const uncertain = captured(session.id, 'uncertain', 'streaming')
  const timeline = { agentSessionId: session.id, revision: 1, sourceHostId: 'local', items: [incoming, uncertain] }
  const native = projectSessionUserMessages({ agentSessionId: session.id, historyPage: page })
  const reply = native.find(message => message.questionAnswers)!
  const projected = createMailboxMessagesSelector()(session.id, timeline, native, 'local')
  expect(projected.find(item => item.message.rawId === incoming.id)!.original).toBe(incoming)
  useAppStore.setState({ sessions: [session] })
  vi.spyOn(api.sessions, 'historyPage').mockResolvedValue(page)
  const copy = vi.fn(async () => true)
  await dom.render(<SessionMailbox control={session.control} system={system} queued={[]} timeline={timeline} userMessages={native} onCopyQueued={copy} />)
  await open()
  expect(panel().querySelector('[data-record-key="timeline:incoming"]')).toBeNull()
  const unknown = panel().querySelector('[data-record-key="timeline:uncertain"]')!
  expect(unknown.parentElement!.textContent).toContain('Delivery not confirmed')
  await read(`native:${reply.id}`)
  const detail = panel().querySelector<HTMLElement>('.log-turn')!
  expect(detail.dataset.conversationItemRef).toBe(JSON.stringify({ hostId: 'local', agentSessionId: session.id, source: { ...reply.source } }))
  expect(detail.textContent).toContain(reply.questionAnswers![0]!.prompt!)
  expect(detail.textContent).toContain('Keep original')
  await dom.click('[aria-label="Message details"]')
  expect(detail.textContent).toContain('Recorded · not a delivery receipt')
  await dom.click('[aria-label="Copy message"]')
  expect(copy).toHaveBeenCalledWith(raw)
  expect(system.acknowledge).not.toHaveBeenCalled()
})

it.each(['enabled', 'dispatch-authorized'] as const)('original Composer and compiled pending/history keep saved %s input separate from recorded native history', async state => {
  const f = await createHistoryQueryFixture(cleanups, 'claude', 3), sid = f.reference.agentSessionId
  const session = { ...composerSession(sid, 'claude'), control: { kind: 'agent' as const, ...f.reference, run: f.session.run } }
  const operationId = 'original-input', receipt = inputReceipt(sid, session.control.run.runId, operationId, state)
  const entry = { operationId, runId: session.control.run.runId, text: body, status: 'deferred' as const, execution: 'immediate' as const,
    promptCondition: null, directInputBinding: { expectedRun: session.control.run, admissionIntent: { kind: 'manual-actor' as const } }, directInputControl: session.control,
    inputIntakeStarted: true, inputReceipt: receipt, sourceChannel: 'message-tool' as const }
  const timeline = await f.client.sessionTimeline(sid)
  useAppStore.setState({ sessions: [session], timelines: { [sid]: timeline }, agentComposerDrafts: { [sid]: 'Original unsent draft' }, agentSteerQueues: { [sid]: [entry] } })
  vi.spyOn(api.sessions, 'historyPage').mockImplementation((_control, options) => f.client.sessionHistoryPage(sid, options))
  vi.spyOn(api.sessions, 'readHistory').mockImplementation((reference, input, context) => f.client.readAgentSessionHistory({ ...input, ...reference }, context))
  const submit = vi.spyOn(api.sessions, 'submitPrompt')
  await dom.render(<AgentSessionComposer sessionId={sid} />); await open()
  const originalRow = panel().querySelector<HTMLElement>(`[data-operation-id="${operationId}"]`)!
  expect(originalRow).not.toBeNull()
  await read(`queue:${operationId}`)
  expect(originalRow.textContent).toContain(state === 'enabled' ? '已保存 · 等待连接' : '已保存 · 结果待核实')
  expect(originalRow.textContent).not.toContain('输入已确认')
  expect(originalRow.querySelector('.log-turn__body')!.textContent).toBe(body)
  expect(useAppStore.getState().agentSteerQueues[sid]).toEqual([entry])
  expect(dom.draft(sid)).toBe('Original unsent draft')
  const server = new AgentMuxControlServer({ socketPath: join(f.root, 'control.sock'), coreClients: () => [{ hostId: 'local', client: f.client }],
    execute: request => useAppStore.getState().executeControl(request) })
  await server.start(); cleanups.push(() => server.stop())
  const run = async (args: string[]) => {
    const result = await runCompiledObjectCli(['--endpoint', `unix://${server.path}`, ...args], objectCliEnvironment(f.root))
    expect(result.code, result.stderr).toBe(0); return JSON.parse(result.stdout).result
  }
  const pending = await run(['message', 'pending', 'ls', '--session', sid])
  expect(pending.messages).toHaveLength(1)
  expect(pending.messages[0]).toMatchObject({ pendingId: operationId, text: body, delivery: state === 'enabled' ? 'not-submitted' : 'unconfirmed', editable: false, inputWait: { status: receipt.status, ref: receipt.ref } })
  for (const source of ['native', 'captured']) {
    const history = await run(['agent', 'history', '--host', 'local', '--session', sid, '--source', source, '--kind', 'user-message'])
    expect(history.userMessages.length).toBeGreaterThan(0)
    expect(history.userMessages.some((message: { rawId: string }) => message.rawId === `prompt:${operationId}`)).toBe(false)
  }
  const edit = await runCompiledObjectCli(['--endpoint', `unix://${server.path}`, 'message', 'pending', 'edit', '--session', sid,
    '--pending-id', operationId, '--expected-text', body, '--text', 'A replacement cannot overwrite original input'], objectCliEnvironment(f.root))
  expect(edit.code).not.toBe(0); expect(JSON.parse(edit.stderr).error.code).toBe('AGENT_PROMPT_INPUT_UNCONFIRMED')
  expect(useAppStore.getState().agentSteerQueues[sid]).toEqual([entry])
  expect(submit).not.toHaveBeenCalled(); await f.noControls()
})

it('unknown Host retains original mail and opaque question data without inventing a reference', async () => {
  const f = await fixture(), page = await f.client.sessionHistoryPage(f.input.agentSessionId, f.invocation)
  const source = projectSessionUserMessages({ agentSessionId: f.input.agentSessionId, historyPage: page }).filter(message => message.questionAnswers)
  const [item] = createMailboxMessagesSelector()(f.input.agentSessionId, undefined, source)
  expect(item!.reference).toBeNull()
  expect(item!.message).toBe(source[0]); expect(item!.original).toBe(source[0])
  expect(item!.message.questionAnswers).toEqual(source[0]!.questionAnswers)
  useAppStore.setState({ sessions: [] })
  const readNative = vi.spyOn(api.sessions, 'historyPage')
  await dom.render(<SessionMailbox system={system} queued={[]} timeline={{ agentSessionId: f.input.agentSessionId, revision: 0, items: [] }} userMessages={source} />)
  await open(); await read(`native:${source[0]!.id}`)
  const detail = panel().querySelector<HTMLElement>('.log-turn')!
  expect(detail.dataset.conversationItemRef).toBeUndefined()
  expect(detail.textContent).toContain('Keep original')
  expect(detail.querySelector('[aria-label="Copy message"]')).not.toBeNull()
  expect(readNative).not.toHaveBeenCalled()
  // Pure presentation preserves typed data with an incomplete source; this does not assert native reader qualification.
  const partial = { ...source[0]!, source: { kind: 'native' as const, providerId: page.source.providerId, nativeSessionId: '', recordId: source[0]!.rawId } }
  const [unknown] = createMailboxMessagesSelector()(f.input.agentSessionId, undefined, [partial], 'local')
  expect(unknown!.message).toBe(partial); expect(unknown!.reference).toBeNull()
  await dom.render(<SessionMailbox system={system} queued={[]} timeline={{ agentSessionId: f.input.agentSessionId, revision: 0, items: [] }} userMessages={[partial]} />)
  await open(); await read(`native:${partial.id}`)
  expect(panel().querySelector<HTMLElement>('.log-turn')!.textContent).toContain('Keep original')
  expect(panel().querySelector<HTMLElement>('.log-turn')!.dataset.conversationItemRef).toBeUndefined()
})
