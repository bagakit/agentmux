// @vitest-environment happy-dom
import { fixtureEpoch as _tailFixtureEpoch } from "../../../test/fixture-values.mjs"
import { act } from 'react'
import { beforeEach, expect, it, vi } from 'vitest'
import type { AgentMuxMessageMetadata, DurableAgentMuxMessage, AgentTimelineSnapshot, AgentTimelineItem } from '@agentmux/core'
import type { RuntimeEvent } from '../src/shared/contracts'
import { api } from '../src/renderer/src/lib/api'
import { SessionMailbox } from '../src/renderer/src/components/SessionMailbox'
import { useAppStore } from '../src/renderer/src/store'
import { composerDOM, composerSession } from './helpers/composer-dom-fixture'

vi.hoisted(() => vi.stubGlobal('__AGENTMUX_WEB_PREVIEW__', true))
const dom = composerDOM(), session = composerSession()
const listeners = new Set<(event: RuntimeEvent) => void>()
const body = '  Original peer body\n\n' + 'Unchanged source text. '.repeat(200) + '\nEND-ORIGINAL\n '
function record(messageId: string, direction: 'incoming' | 'outgoing' | 'self' = 'incoming'): DurableAgentMuxMessage {
  const senderSessionId = direction === 'incoming' ? 'peer' : session.id
  const recipientSessionId = direction === 'outgoing' ? 'other-peer' : session.id
  return { sequence: messageId === 'received' ? 50 : 51, envelope: { schema: 'agentmux.a2a.v1', messageId, operationId: `original-${messageId}`, createdAt: _tailFixtureEpoch(0, 0, 10),
    sender: { kind: 'agent-session', agentSessionId: senderSessionId }, recipient: { kind: 'agent-session', agentSessionId: recipientSessionId },
    senderSessionId, recipientSessionId, senderRunId: 'original-sender-run', recipientRunId: null,
    threadId: messageId, correlationId: messageId, replyTo: null, workspaceId: null, body: direction === 'outgoing' ? 'Original A2A outgoing' : body },
    delivery: { state: 'queued', at: _tailFixtureEpoch(0, 0, 11), reason: 'Original input ACK missing' } }
}
function metadata(value: DurableAgentMuxMessage): AgentMuxMessageMetadata {
  const { body: text, ...envelope } = value.envelope
  return { sequence: value.sequence, envelope, delivery: value.delivery, bodyPreview: text.slice(0, 240), bodyBytes: new TextEncoder().encode(text).byteLength }
}
const captured = (id: string, content: string, author?: string): AgentTimelineItem => ({ id, agentSessionId: session.id,
  kind: 'user_message', status: 'complete', source: 'native-hook', createdAt: _tailFixtureEpoch(0, 0, 2), updatedAt: _tailFixtureEpoch(0, 0, 2), title: 'Original input', content,
  ...(author ? { authorAgentSessionId: author } : { authorHuman: true }) })
let incoming: AgentMuxMessageMetadata[], outgoing: AgentMuxMessageMetadata[]
beforeEach(() => {
  listeners.clear(); incoming = [metadata(record('received')), metadata(record('self', 'self'))]; outgoing = [metadata(record('sent', 'outgoing')), metadata(record('self', 'self'))]
  useAppStore.setState({ sessions: [session], noticeReadReceipts: {} })
  vi.spyOn(api.sessions, 'listMessages').mockImplementation(async (reference, options) => ({ hostId: reference.hostId,
    participantSessionId: reference.agentSessionId, direction: options.direction, messages: options.direction === 'incoming' ? incoming : outgoing, nextBeforeSequence: null }))
  vi.spyOn(api.sessions, 'readMessage').mockImplementation(async (reference, messageId) => ({ hostId: reference.hostId,
    message: record(messageId, messageId === 'sent' ? 'outgoing' : 'incoming') }))
  vi.spyOn(api.sessions, 'onEvent').mockImplementation(listener => { listeners.add(listener); return () => { listeners.delete(listener) } })
  vi.spyOn(api.sessions, 'inputMailbox').mockResolvedValue({ agentSessionId: session.id, queueId: 'original-input-journal', cut: { incarnation: 'original', throughSequence: 0 }, budgetBytes: 4096, items: [], nextCursor: null, coverage: { kind: 'recorded-inputs', unrecorded: 'unconfirmed' } })
})
const system = () => ({ available: true, notices: [], unread: [], acknowledge: vi.fn() })
const toggle = async () => {
  const event = new Event('toggle'); Object.defineProperty(event, 'newState', { value: 'open' })
  await act(async () => dom.container.querySelector('.composer-mailbox')!.dispatchEvent(event))
}
const folder = async (name: string) => dom.click(`[role="tab"][id$="-${name}-tab"]`)
const timeline = (items: AgentTimelineItem[]): AgentTimelineSnapshot => ({ agentSessionId: session.id, revision: 1, items })

it('reads typed original A2A pages instead of inferring them from Conversation, and keeps human input on User Messages', async () => {
  await dom.render(<SessionMailbox system={system()} queued={[{ id: 'pending-human', text: 'My unsent draft', status: 'queued', deliverable: true }]} control={session.control}
    timeline={timeline([captured('old-peer-input', 'Captured Agent input with no journal message', 'old-peer'), captured('human-input', 'Original human input')])} />)
  await toggle()
  const labels = [...dom.container.querySelectorAll('[role="tab"]')].map(button => button.textContent)
  expect(labels.slice(0, 4)).toEqual(['A2A Inbox', 'A2A Outbox', 'User Messages1', 'Notices'])
  expect(api.sessions.listMessages).toHaveBeenCalledExactlyOnceWith({ hostId: 'local', agentSessionId: session.id }, { direction: 'incoming', limit: 25 })
  expect(dom.container.querySelector('[data-record-key="a2a:received"]')).not.toBeNull()
  expect(dom.container.querySelector('[data-record-key="a2a:self"]')).toBeNull()
  expect(dom.container.textContent).not.toContain('Captured Agent input with no journal message')
  expect(dom.container.textContent).not.toContain('END-ORIGINAL')
  expect(api.sessions.readMessage).not.toHaveBeenCalled()
  await folder('outbox')
  expect(dom.container.querySelector('[data-record-key="a2a:sent"]')).not.toBeNull()
  expect(dom.container.querySelector('[data-record-key="queue:pending-human"]')).toBeNull()
  expect(dom.container.querySelector('[aria-label*="Send"]')).toBeNull()
  await folder('user')
  expect(dom.container.textContent).toContain('Original human input')
  expect(dom.container.textContent).toContain('My unsent draft')
  expect(dom.container.textContent).not.toContain('Original A2A outgoing')
})

it('reads and copies the one original MID without submitting, replaying or consuming an Agent message', async () => {
  const copy = vi.fn(async () => true), submit = vi.spyOn(api.sessions, 'submitMessage'), write = vi.spyOn(api.sessions, 'write'), rejoin = vi.spyOn(api.sessions, 'rejoinInputWaiting')
  await dom.render(<SessionMailbox system={system()} queued={[]} control={session.control} onCopyQueued={copy} />)
  await toggle(); await dom.click('[data-record-key="a2a:received"]')
  expect(api.sessions.readMessage).toHaveBeenCalledExactlyOnceWith({ hostId: 'local', agentSessionId: session.id }, 'received')
  expect(dom.container.textContent).toContain('END-ORIGINAL')
  await dom.click('button[aria-label="Message details"]')
  expect(dom.container.textContent).toContain('Not determined at first save')
  await dom.click('[aria-label="Copy message"]')
  expect(copy).toHaveBeenCalledExactlyOnceWith(body)
  expect(submit).not.toHaveBeenCalled(); expect(write).not.toHaveBeenCalled(); expect(rejoin).not.toHaveBeenCalled()
  expect(dom.draft()).toBe('Keep my draft')
})

it('only offers Conversation navigation for an exact typed original Input message reference', async () => {
  const fake = captured('prompt:received', body, 'peer'), reveal = vi.fn(async () => ({ kind: 'located' as const }))
  const props = { system: system(), queued: [], control: session.control, onRevealMessage: reveal }
  await dom.render(<SessionMailbox {...props} timeline={timeline([fake])} />)
  await toggle()
  const close = vi.fn()
  Object.defineProperty(dom.container.querySelector('.composer-mailbox'), 'hidePopover', { configurable: true, value: close })
  expect(dom.container.querySelector('[aria-label="在对话中查看"]')).toBeNull()
  const genuine = { ...fake, inputRef: { kind: 'message' as const, agentSessionId: session.id, messageId: 'received', expectedRun: session.control.run } }
  await dom.render(<SessionMailbox {...props} timeline={timeline([genuine])} />)
  await dom.click('[aria-label="在对话中查看"]')
  expect(reveal).toHaveBeenCalledTimes(1)
  expect(close).toHaveBeenCalledTimes(1)
  expect(reveal.mock.calls[0]?.[0]).toHaveProperty('source.submissionId', 'prompt:received')
})

it('does not make transport updates unread again and keeps the selected body and Range', async () => {
  await dom.render(<SessionMailbox system={system()} queued={[]} control={session.control} />)
  await toggle(); await dom.click('[data-record-key="a2a:received"]')
  const node = dom.container.querySelector('.log-turn__body')!
  const range = document.createRange(); range.selectNodeContents(node); getSelection()!.addRange(range)
  const selected = getSelection()!.toString()
  incoming = [{ ...incoming[0]!, delivery: { state: 'delivered', at: _tailFixtureEpoch(0, 0, 20) } }]
  await act(async () => { for (const listener of listeners) listener({ type: 'core', hostId: 'local', event: { type: 'agent-message-changed', messageId: 'received', sequence: 52, senderSessionId: 'peer', recipientSessionId: session.id } }) })
  expect(dom.container.querySelector('.log-turn__body')).toBe(node)
  expect(getSelection()!.toString()).toBe(selected)
  expect(dom.container.querySelector('.composer-mailbox__unread')).toBeNull()
  incoming = [metadata(record('new-arrival')), ...incoming]
  await act(async () => { for (const listener of listeners) listener({ type: 'core', hostId: 'local', event: { type: 'agent-message-changed', messageId: 'new-arrival', sequence: 53, senderSessionId: 'peer', recipientSessionId: session.id } }) })
  expect(dom.container.querySelector('.log-turn__body')).toBe(node)
  expect(dom.container.querySelector('.composer-mailbox__unread')?.textContent).toBe('1')
})
