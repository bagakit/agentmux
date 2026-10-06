// @vitest-environment happy-dom
import { fixtureEpoch as _newTailFixtureEpoch } from "../../../test/fixture-values.mjs"
import { act } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { join, resolve } from 'node:path'
import { AgentMuxControlServer, agentInputSubmissionStatus, type AgentInputSubmissionReceipt, type AgentSessionUserMessage, type AgentTimelineItem } from '@agentmux/core'
import { projectSessionUserMessages } from '@agentmux/core/session-user-messages'
import { conversationMessageSourceKey } from '@agentmux/client-ui/conversation-message-location'
import { createHistoryQueryFixture } from '../../../packages/core/test/helpers/session-history-query'
import { objectCliEnvironment, runCompiledObjectCli } from '../../../packages/core/test/helpers/object-cli-rpc'
import { fixture, raw } from './helpers/native-async-question-fixture'
import { composerDOM, composerSession } from './helpers/composer-dom-fixture'
import { SessionMailbox } from '../src/renderer/src/components/SessionMailbox'
import { AgentSessionComposer } from '../src/renderer/src/components/AgentSessionComposer'
import { mailboxMessages } from '../src/renderer/src/lib/session-mailbox-messages'
import { api } from '../src/renderer/src/lib/api'
import { useAppStore } from '../src/renderer/src/store'

const dom = composerDOM(), cleanups: Array<() => Promise<unknown>> = []
const system = { available: true, notices: [], unread: [], acknowledge: vi.fn() }
const body = Array.from({ length: 32 }, (_, index) => `Original line ${index}: every word retained`).join('\n')
const panel = () => dom.container.querySelector<HTMLElement>('.composer-mailbox')!
async function open(folder: 'inbox' | 'outbox' | 'system') {
  const event = new Event('toggle'); Object.defineProperty(event, 'newState', { value: 'open' })
  await act(async () => panel().dispatchEvent(event))
  await dom.click(`[role="tab"][id$="-${folder}-tab"]`)
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

it('mounted original Mailbox preserves Core author, unknown delivery, exact record refs and native question answers', async () => {
  const f = await fixture(), page = await f.client.sessionHistoryPage(f.input.agentSessionId, f.invocation)
  const session = { ...composerSession(f.input.agentSessionId), control: { kind: 'agent' as const, hostId: 'local', agentSessionId: f.input.agentSessionId, run: f.input.expectedRun } }
  const incoming = { ...captured(session.id, 'incoming'), authorAgentSessionId: 'original-peer' }
  const uncertain = captured(session.id, 'uncertain', 'streaming')
  const timeline = { agentSessionId: session.id, revision: 1, items: [incoming, uncertain] }
  const native = projectSessionUserMessages({ agentSessionId: session.id, historyPage: page })
  const reply = native.find(message => message.questionAnswers)!
  const projected = mailboxMessages(session.id, timeline, native, 'local')
  expect(projected.find(item => item.message.rawId === incoming.id)!.original).toBe(incoming)
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify([incoming.authorAgentSessionId, incoming.content, incoming.createdAt, incoming.status])))
  const marker = Array.from(new Uint8Array(digest), value => value.toString(16).padStart(2, '0')).join('')
  useAppStore.setState({ sessions: [session], noticeReadReceipts: { [`mail:${session.id}`]: { incoming: marker } } })
  vi.spyOn(api.sessions, 'historyPage').mockResolvedValue(page)
  const copy = vi.fn(async () => true), reveal = vi.fn(async (_message: AgentSessionUserMessage) => ({ kind: 'unavailable' as const, message: 'Original location unavailable; record retained.' }))
  await dom.render(<SessionMailbox control={session.control} system={system} queued={[]} timeline={timeline} userMessages={native} onCopyQueued={copy} onRevealMessage={reveal} />)
  await act(async () => { await vi.waitFor(() => expect(dom.container.querySelector('.composer__mailbox')?.getAttribute('aria-label')).toContain('Inbox 0 unread')) })
  await open('inbox'); await read('timeline:incoming')
  let detail = panel().querySelector<HTMLElement>('.log-turn')!
  expect(detail.dataset.conversationItemRef).toBe(JSON.stringify({ hostId: 'local', agentSessionId: session.id, source: { kind: 'captured', recordId: incoming.id } }))
  expect(detail.dataset.messageSourceKey).toBe(conversationMessageSourceKey(session.id, { kind: 'captured', recordId: incoming.id }))
  expect(detail.textContent).toContain('original-peer')
  const originalBody = detail.querySelector('.log-turn__body')!
  expect(originalBody.textContent).toBe(body)
  const text = originalBody.querySelector('p')!.firstChild!, range = document.createRange()
  range.setStart(text, 0); range.setEnd(text, 8)
  window.getSelection()!.removeAllRanges(); window.getSelection()!.addRange(range)
  await dom.click('.composer-mailbox__record-actions .composer-mailbox__reveal')
  expect(reveal.mock.calls[0]![0]).toMatchObject({ agentSessionId: session.id, source: { kind: 'captured', submissionId: incoming.id }, author: { kind: 'agent', agentSessionId: incoming.authorAgentSessionId } })
  expect(useAppStore.getState().noticeReadReceipts[`mail:${session.id}`]!.incoming).toBe(marker)
  expect(panel().querySelector('.log-turn__body')).toBe(originalBody)
  expect(window.getSelection()!.toString()).toBe('Original')
  await dom.click(`[role="tab"][id$="-outbox-tab"]`)
  const unknown = panel().querySelector('[data-record-key="timeline:uncertain"]')!
  expect(unknown.parentElement!.textContent).toContain('Delivery not confirmed')
  await read(`native:${reply.id}`)
  detail = panel().querySelector<HTMLElement>('.log-turn')!
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
  await dom.render(<AgentSessionComposer sessionId={sid} />); await open('outbox')
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
  const [item] = mailboxMessages(f.input.agentSessionId, undefined, source)
  expect(item!.reference).toBeNull()
  expect(item!.message).toBe(source[0]); expect(item!.original).toBe(source[0])
  expect(item!.message.questionAnswers).toEqual(source[0]!.questionAnswers)
  useAppStore.setState({ sessions: [] })
  const readNative = vi.spyOn(api.sessions, 'historyPage')
  await dom.render(<SessionMailbox system={system} queued={[]} timeline={{ agentSessionId: f.input.agentSessionId, revision: 0, items: [] }} userMessages={source} />)
  await open('outbox'); await read(`native:${source[0]!.id}`)
  const detail = panel().querySelector<HTMLElement>('.log-turn')!
  expect(detail.dataset.conversationItemRef).toBeUndefined()
  expect(detail.textContent).toContain('Keep original')
  expect(detail.querySelector('[aria-label="Copy message"]')).not.toBeNull()
  expect(readNative).not.toHaveBeenCalled()
  // The original input-history reader can still supply a known record without a current Host binding.
  await dom.render(<SessionMailbox system={system} queued={[]} inputHistory={readMessage => readMessage(source[0]!)} />)
  await open('outbox')
  const retained = panel().querySelector<HTMLElement>('.log-turn')!
  expect(retained.textContent).toContain('Keep original')
  expect(retained.dataset.conversationItemRef).toBeUndefined()
  expect(readNative).not.toHaveBeenCalled()
  // Pure presentation preserves typed data with an incomplete source; this does not assert native reader qualification.
  const partial = { ...source[0]!, source: { kind: 'native' as const, providerId: page.source.providerId, nativeSessionId: '', recordId: source[0]!.rawId } }
  const [unknown] = mailboxMessages(f.input.agentSessionId, undefined, [partial], 'local')
  expect(unknown!.message).toBe(partial); expect(unknown!.reference).toBeNull()
  await dom.render(<SessionMailbox system={system} queued={[]} timeline={{ agentSessionId: f.input.agentSessionId, revision: 0, items: [] }} userMessages={[partial]} />)
  await open('outbox'); await read(`native:${partial.id}`)
  expect(panel().querySelector<HTMLElement>('.log-turn')!.textContent).toContain('Keep original')
  expect(panel().querySelector<HTMLElement>('.log-turn')!.dataset.conversationItemRef).toBeUndefined()
})
