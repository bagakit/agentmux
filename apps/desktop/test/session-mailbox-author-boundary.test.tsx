// @vitest-environment happy-dom
import { fixtureEpoch as _tailFixtureEpoch } from "../../../test/fixture-values.mjs"
import { act } from 'react'
import { expect, it, vi } from 'vitest'
import { parseAgentInputMailboxPage, type AgentInputMailboxItem } from '@agentmux/core/agent-input-mailbox'
import type { DurableAgentMuxMessage } from '@agentmux/core'
import { SessionMailbox } from '../src/renderer/src/components/SessionMailbox'
import { api } from '../src/renderer/src/lib/api'
import { composerDOM, composerSession } from './helpers/composer-dom-fixture'

vi.hoisted(() => vi.stubGlobal('__AGENTMUX_WEB_PREVIEW__', true))
const dom = composerDOM(), session = composerSession()
const message = (id: string): DurableAgentMuxMessage => ({ sequence: id === 'controlled-agent' ? 4 : 3,
  envelope: { schema: 'agentmux.a2a.v1', messageId: id, operationId: 'op-' + id, createdAt: _tailFixtureEpoch(0, 0, 10),
    sender: { kind: 'agent-session', agentSessionId: 'peer-agent' }, recipient: { kind: 'agent-session', agentSessionId: session.id },
    senderSessionId: 'peer-agent', recipientSessionId: session.id, senderRunId: 'peer-original-run', recipientRunId: session.control.run.runId,
    threadId: id, correlationId: id, replyTo: null, workspaceId: null, body: 'ORIGINAL-' + id },
  delivery: { state: 'queued', at: _tailFixtureEpoch(0, 0, 11) } })
const controlled = (id: string, sequence: number, author: 'agent' | 'human' | 'unknown'): AgentInputMailboxItem => ({
  kind: 'controlled', sequence, recordedAt: _tailFixtureEpoch(0, 0, 10),
  intent: { key: author === 'agent' ? { kind: 'message', agentSessionId: session.id, expectedRun: session.control.run, messageId: id }
    : { kind: 'prompt', agentSessionId: session.id, expectedRun: session.control.run, submissionId: id },
    admissionIntent: { kind: 'manual-actor', expectedRun: session.control.run }, execution: 'immediate',
    source: author === 'agent' ? { kind: 'message', messageId: id, originalControlOperationId: 'op-' + id }
      : { kind: 'prompt', prompt: 'ORIGINAL-' + id, ...(author === 'human' ? { authorHuman: true } : {}) } },
  ...(author === 'agent' ? { message: message(id).envelope } : {}), receipt: null,
  failure: { name: 'Error', code: 'PRIVATE_OBSERVATION_UNKNOWN', message: 'OBSERVATION-' + id } })
const submitted = (): AgentInputMailboxItem => {
  const id = 'submitted-agent', key = { kind: 'message' as const, agentSessionId: session.id, expectedRun: session.control.run, messageId: id }
  return { kind: 'submission', sequence: 3, recordedAt: _tailFixtureEpoch(0, 0, 10), key, record: { agentSessionId: session.id, run: session.control.run,
    admission: { inputKey: key, submissionId: id, operationId: id, startByte: 0, endByte: 1, acknowledged: true,
      intent: { run: session.control.run, ownerInstanceId: 'original-input-owner', prompt: 'ORIGINAL-' + id,
        plan: { kind: 'single-phase', data: 'ORIGINAL-' + id },
        message: { userContent: 'ORIGINAL-' + id, authorAgentSessionId: 'peer-agent' } } } } }
}

it('keeps typed Agent controlled/submission inputs in A2A Inbox while User Messages retains Human and Unknown only', async () => {
  const sourceItems = [controlled('controlled-agent', 4, 'agent'), submitted(), controlled('human-input', 2, 'human'), controlled('unknown-input', 1, 'unknown')]
  const read = vi.spyOn(api.sessions, 'inputMailbox').mockImplementation(async (_target, options) => {
    const page = { agentSessionId: session.id, queueId: 'isolated-original-input-journal', cut: { incarnation: 'original-cut', throughSequence: 4 },
      budgetBytes: options.maxBytes ?? 64 * 1024, items: sourceItems.map(item => ({ kind: 'item' as const, item })), nextCursor: null,
      coverage: { kind: 'recorded-inputs' as const, unrecorded: 'unconfirmed' as const } }
    return parseAgentInputMailboxPage(page, { agentSessionId: session.id, ...options })
  })
  vi.spyOn(api.sessions, 'onEvent').mockImplementation(() => () => {})
  vi.spyOn(api.sessions, 'listMessages').mockImplementation(async (reference, options) => ({ hostId: reference.hostId,
    participantSessionId: reference.agentSessionId, direction: options.direction, messages: ['controlled-agent', 'submitted-agent'].map(id => {
      const original = message(id), { body, ...envelope } = original.envelope
      return { sequence: original.sequence, envelope, delivery: original.delivery, bodyPreview: body, bodyBytes: body.length }
    }), nextBeforeSequence: null }))
  vi.spyOn(api.sessions, 'readMessage').mockImplementation(async (reference, messageId) => ({ hostId: reference.hostId, message: message(messageId) }))
  await dom.render(<SessionMailbox system={{ available: true, notices: [], unread: [], acknowledge: vi.fn() }} control={session.control} queued={[]} />)
  const toggle = new Event('toggle'); Object.defineProperty(toggle, 'newState', { value: 'open' })
  await act(async () => dom.container.querySelector('.composer-mailbox')!.dispatchEvent(toggle))
  for (const id of ['controlled-agent', 'submitted-agent']) {
    await dom.click(`[data-record-key="a2a:${id}"]`)
    expect(dom.container.textContent).toContain('ORIGINAL-' + id)
    await dom.click('[aria-label="Back to A2A Inbox"]')
  }
  await dom.click('[role="tab"][id$="-user-tab"]')
  await vi.waitFor(() => expect(read).toHaveBeenCalled())
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)) })
  const rows = [...dom.container.querySelectorAll('[data-input-mailbox-key]')]
  expect(rows.map(row => row.querySelector('[data-mailbox-author]')?.textContent)).toEqual(['Human', 'Author unknown'])
  expect(dom.container.textContent).toContain('ORIGINAL-human-input')
  expect(dom.container.textContent).toContain('ORIGINAL-unknown-input')
  expect(dom.container.textContent).not.toContain('ORIGINAL-controlled-agent')
  expect(dom.container.textContent).not.toContain('ORIGINAL-submitted-agent')
  expect(dom.container.textContent).not.toContain('OBSERVATION-controlled-agent')
})
