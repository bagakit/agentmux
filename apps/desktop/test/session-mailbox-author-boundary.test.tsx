// @vitest-environment happy-dom
import { fixtureEpoch as _tailFixtureEpoch } from "../../../test/fixture-values.mjs"
import { act } from 'react'
import { expect, it, vi } from 'vitest'
import { parseAgentInputMailboxPage, type AgentInputMailboxItem } from '@agentmux/core/agent-input-mailbox'
import type { DurableAgentMuxMessage } from '@agentmux/core'
import { InputMailboxRecords, inputMailboxPresentation } from '@agentmux/client-ui/components/InputMailboxRecords'
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

const noticeWire = '<amux:a2a from="peer-agent" msg-id="unopened-original" read-via="message --skill" />'
const notification = (id: string, sequence: number, typed: boolean): AgentInputMailboxItem => {
  const key = { kind: 'prompt' as const, agentSessionId: session.id, expectedRun: session.control.run, submissionId: id }
  return { kind: 'submission', sequence, recordedAt: _tailFixtureEpoch(0, 0, 10), key,
    record: { agentSessionId: session.id, run: session.control.run,
      admission: { inputKey: key, submissionId: id, operationId: id, startByte: 0, endByte: 1, acknowledged: true,
        intent: { run: session.control.run, ownerInstanceId: 'original-input-owner', prompt: noticeWire,
          plan: { kind: 'single-phase', data: noticeWire },
          message: typed ? { a2aNotificationId: id, systemContext: noticeWire } : { userContent: noticeWire } } } } }
}

it('excludes typed Agent and platform inputs from User Messages while retaining human and unknown authored lookalikes', async () => {
  const sourceItems = [notification('platform-notice', 6, true), notification('authored-lookalike', 5, false),
    controlled('controlled-agent', 4, 'agent'), submitted(), controlled('human-input', 2, 'human'), controlled('unknown-input', 1, 'unknown')]
  const read = vi.spyOn(api.sessions, 'inputMailbox').mockImplementation(async (_target, options) => {
    const page = { agentSessionId: session.id, queueId: 'isolated-original-input-journal', cut: { incarnation: 'original-cut', throughSequence: 6 },
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
  await vi.waitFor(() => {
    expect(read).toHaveBeenCalled()
    expect(dom.container.querySelector('.input-history__coverage')?.textContent).toContain('已登记输入 ·')
    expect(dom.container.textContent).toContain('ORIGINAL-human-input')
  })
  const rows = [...dom.container.querySelectorAll('[data-input-mailbox-key]')]
  expect(rows.map(row => row.querySelector('.composer-mailbox__row strong')?.textContent)).toEqual(['Author unknown', 'Human', 'Author unknown'])
  expect(rows.some(row => row.getAttribute('data-input-mailbox-key')?.includes('platform-notice'))).toBe(false)
  expect(rows.some(row => row.getAttribute('data-input-mailbox-key')?.includes('authored-lookalike'))).toBe(true)
  expect(sourceItems).toHaveLength(6)
  expect(dom.container.textContent).toContain('ORIGINAL-human-input')
  expect(dom.container.textContent).toContain('ORIGINAL-unknown-input')
  expect(dom.container.textContent).not.toContain('ORIGINAL-controlled-agent')
  expect(dom.container.textContent).not.toContain('ORIGINAL-submitted-agent')
  expect(dom.container.textContent).not.toContain('OBSERVATION-controlled-agent')
})

it('retains platform notices in the shared inventory with typed reference reading and exact Copy', async () => {
  const item = notification('platform-notice', 1, true), copy = vi.fn(async () => true), refresh = vi.fn(async () => {})
  const page = parseAgentInputMailboxPage({ agentSessionId: session.id, queueId: 'original-input-journal', cut: { incarnation: 'original-cut', throughSequence: 1 },
    budgetBytes: 128 * 1024, items: [{ kind: 'item', item }], nextCursor: null, coverage: { kind: 'recorded-inputs', unrecorded: 'unconfirmed' } },
    { agentSessionId: session.id, maxBytes: 128 * 1024 })
  const mailbox = { scope: 'original-scope', items: [item], failures: [], page, loading: false, error: null, refresh, loadEarlier: vi.fn(async () => {}), hasMore: false }
  await dom.render(<InputMailboxRecords mailbox={mailbox} hostId="original-host" onCopy={copy} />)
  expect(dom.container.querySelector('[data-mailbox-author]')?.textContent).toBe('AgentMux')
  const details = dom.container.querySelector<HTMLDetailsElement>('[data-input-mailbox-key] > details')!
  await act(async () => { details.open = true; details.dispatchEvent(new Event('toggle')) })
  const turn = dom.container.querySelector('.log-turn')!
  expect(turn.getAttribute('data-speaker-role')).toBe('system')
  expect(turn.getAttribute('data-a2a-notification-id')).toBe('platform-notice')
  expect(turn.querySelector('.log-turn__system-summary')?.textContent).toBe('1 A2A Inbox reference')
  await dom.click('.log-turn__system-toggle')
  expect(turn.textContent).toContain('unopened-original')
  expect(turn.textContent).toContain('message --skill')
  await dom.click('[aria-label="Copy message"]')
  expect(copy).toHaveBeenCalledExactlyOnceWith(noticeWire)
  expect(refresh).not.toHaveBeenCalled(); expect(mailbox.loadEarlier).not.toHaveBeenCalled()
})

it.each(['missing-producer-key', 'mismatched-marker', 'mismatched-context', 'authored-content'] as const)(
  'keeps %s unknown rather than removing an authored input from User Messages', variant => {
    const item = notification('unknown-input', 1, true)
    if (item.kind !== 'submission' || !item.record?.admission?.intent?.message) throw new Error('The original submission fixture exists')
    const admission = item.record.admission, message = admission.intent!.message!
    if (variant === 'missing-producer-key') delete admission.inputKey
    if (variant === 'mismatched-marker') message.a2aNotificationId = 'another-input'
    if (variant === 'mismatched-context') message.systemContext = 'another-context'
    if (variant === 'authored-content') message.userContent = noticeWire
    expect(inputMailboxPresentation(item).speaker.role).toBe('unknown')
    expect(inputMailboxPresentation(item).a2aNotificationId).toBeUndefined()
  })
