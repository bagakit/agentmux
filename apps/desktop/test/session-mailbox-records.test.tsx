import { fixturePath as _historyFixturePath } from "../../../test/fixture-values.mjs"
// @vitest-environment happy-dom
import { act } from 'react'
import { expect, it, vi } from 'vitest'
import { projectSessionUserMessages } from '@agentmux/core/session-user-messages'
import { SessionMailbox } from '../src/renderer/src/components/SessionMailbox'
import type { useComposerInputHistory } from '../src/renderer/src/lib/use-composer-input-history'
import { composerDOM } from './helpers/composer-dom-fixture'
import { fixtureEpoch as _historyFixtureEpoch } from '../../../test/fixture-values.mjs'


const dom = composerDOM(), system = { available: true, notices: [], unread: [], acknowledge: vi.fn() }
const panel = () => dom.container.querySelector<HTMLElement>('.composer-mailbox')!
async function open(folder = 'outbox') {
  const event = new Event('toggle'); Object.defineProperty(event, 'newState', { value: 'open' })
  await act(async () => panel().dispatchEvent(event))
  await dom.click(`[role="tab"][id$="-${folder}-tab"]`)
}
function controller() {
  const messages = projectSessionUserMessages({ agentSessionId: 'agent-1', timeline: { agentSessionId: 'agent-1', revision: 1, items: [
    { id: 'in', agentSessionId: 'agent-1', kind: 'user_message', source: 'user', status: 'complete', authorAgentSessionId: 'original-peer', content: 'Exact incoming original', createdAt: _historyFixtureEpoch(0, 0, 50), updatedAt: _historyFixtureEpoch(0, 0, 50) },
    { id: 'out', agentSessionId: 'agent-1', sourceChannel: 'message-tool', kind: 'user_message', source: 'user', status: 'complete', authorHuman: true, content: 'Exact outgoing original', createdAt: _historyFixtureEpoch(0, 0, 30), updatedAt: _historyFixtureEpoch(0, 0, 30) }
  ] } })
  const fill = vi.fn(async () => undefined), fillText = vi.fn(async () => undefined), copy = vi.fn(async () => true)
  const history = { scope: 'local/agent-1', messages, draftQuery: '', query: '', setDraftQuery: vi.fn(), search: vi.fn(),
    pages: [], loadMore: vi.fn(), complete: true, loading: false, examined: 2 }
  return { messages, history, localEntries: [], fill, fillText, copy, fillLocal: vi.fn(), resourceReader: vi.fn(), entries: [], setMailboxOpen: vi.fn(), setFocused: vi.fn() } as unknown as ReturnType<typeof useComposerInputHistory>
}

it('unifies queued, archived and recorded rows without leaking Agent mail into Outbox or creating a second History reader', async () => {
  const inputHistory = controller()
  const queued = [
    { id: 'first', text: 'Original first pending', status: 'deferred' as const, deliverable: true, enqueuedAt: _historyFixtureEpoch(0, 0, 1) },
    { id: 'second', text: 'Original second pending', status: 'queued' as const, deliverable: true, enqueuedAt: _historyFixtureEpoch(0, 0, 100) },
    { id: 'archive', text: 'Original retained archive', status: 'deferred' as const, deliverable: false, archived: true as const, enqueuedAt: _historyFixtureEpoch(0, 0, 40) }
  ]
  const send = vi.fn(), archive = vi.fn()
  await dom.render(<SessionMailbox system={system} queued={queued} inputHistory={inputHistory} userMessages={inputHistory.messages}
    timeline={{ agentSessionId: 'agent-1', revision: 1, items: [] }} onSendQueued={send} onArchiveQueued={archive} />)
  await open()
  const rows = () => [...panel().querySelectorAll<HTMLButtonElement>('.composer-mailbox__row')]
  expect(rows().map(row => row.dataset.recordKey)).toEqual(['queue:first', 'queue:second', 'queue:archive', 'timeline:out'])
  expect(panel().textContent).not.toContain('Exact incoming original')
  expect(panel().querySelector('.composer-mailbox__history')).toBeNull()
  expect(panel().querySelectorAll('h3')).toHaveLength(0)
  expect(panel().querySelectorAll('.input-history__excerpt')).toHaveLength(0)
  const original = inputHistory.messages.find(message => message.rawId === 'out')!
  const outgoing = rows().at(-1)!.closest('li')!
  const fill = outgoing.querySelector<HTMLButtonElement>('[aria-label="填入草稿"]')!
  expect(fill.title).toContain('保留已有草稿与原记录')
  expect(fill.textContent).toBe('')
  await act(async () => fill.click())
  expect(inputHistory.fill).toHaveBeenCalledWith(original)
  expect(panel().querySelector('[role="status"]')?.textContent).toBeTruthy()
  const pending = rows()[0]!.closest('li')!
  await act(async () => pending.querySelector<HTMLButtonElement>('[aria-label="填入草稿"]')!.click())
  expect(inputHistory.fillText).toHaveBeenCalledWith('Original first pending')
  expect(send).not.toHaveBeenCalled(); expect(archive).not.toHaveBeenCalled()
  expect(rows().map(row => row.dataset.recordKey)).toEqual(['queue:first', 'queue:second', 'queue:archive', 'timeline:out'])
  await act(async () => rows()[1]!.closest('li')!.querySelector<HTMLButtonElement>('[aria-label="Send queued message"]')!.click())
  expect(send).toHaveBeenCalledExactlyOnceWith('second')
})

it('uses one selected full original reader with Back, while list copy and native source remain explicit', async () => {
  const inputHistory = controller()
  const reveal = vi.fn(async () => ({ kind: 'unavailable' as const, message: 'Original position unavailable; record retained.' }))
  await dom.render(<SessionMailbox system={system} queued={[]} inputHistory={inputHistory} userMessages={inputHistory.messages}
    timeline={{ agentSessionId: 'agent-1', revision: 1, items: [] }} onRevealMessage={reveal} />)
  await open()
  expect(panel().textContent).toContain('Message Tool')
  expect(panel().querySelector('[aria-label="复制全文"]')).not.toBeNull()
  await dom.click('[aria-label="复制全文"]')
  expect(inputHistory.copy).toHaveBeenCalledWith(inputHistory.messages.find(message => message.rawId === 'out'))
  await dom.click('.composer-mailbox__row')
  expect(panel().querySelectorAll('.log-turn__body')).toHaveLength(1)
  expect(panel().querySelector('.log-turn__body')?.textContent).toBe('Exact outgoing original')
  expect(panel().querySelectorAll('.composer-mailbox__row')).toHaveLength(0)
  await dom.click('[aria-label="在对话中查看"]')
  expect(reveal).toHaveBeenCalledWith(inputHistory.messages.find(message => message.rawId === 'out'))
  expect(panel().textContent).toContain('Original position unavailable; record retained.')
  await dom.click('[aria-label="Back to Outbox"]')
  expect(panel().querySelectorAll('.composer-mailbox__row')).toHaveLength(1)
})

it('keeps secondary identity, source declarations and location in Info with one primary Copy and an immediate original body', async () => {
  const reading = { describeSpeaker: (speaker: { id: string }) => ({ name: 'Original reviewer', providerId: 'codex',
    project: { workspaceId: 'review-project', name: 'Source project', path: _historyFixturePath("original/review"), branch: 'review-branch' } }) }
  await dom.render(<SessionMailbox system={system} queued={[]} reading={reading}
    timeline={{ agentSessionId: 'agent-1', revision: 1, items: [{ id: 'original', agentSessionId: 'agent-1', kind: 'user_message', status: 'complete', source: 'user', title: 'Original message', authorAgentSessionId: 'original-reviewer',
      content: '[Message from Agent declared-only]\nOriginal body comes first.', createdAt: _historyFixtureEpoch(0, 0, 1), updatedAt: _historyFixtureEpoch(0, 0, 1) }] }} />)
  await open('inbox'); await dom.click('.composer-mailbox__row')
  expect(panel().querySelector('.log-turn__body')?.textContent).toBe('Original body comes first.')
  expect(panel().querySelector('.log-turn__who')?.textContent).toBe('Original reviewer')
  expect(panel().querySelector('.log-turn__sender-id')).toBeNull()
  expect(panel().querySelector('.log-turn__meta')).toBeNull()
  expect(panel().querySelector('[data-mailbox-location="summary"]')).toBeNull()
  expect(panel().querySelectorAll('[aria-label="Copy message"]')).toHaveLength(1)
  expect(panel().querySelector('[aria-label="复制全文"]')).toBeNull()
  await dom.click('[aria-label="Message details"]')
  expect(panel().querySelector('.conversation-input-details__body')?.textContent).toContain('original-reviewer')
  expect(panel().querySelector('.conversation-input-details__body')?.textContent).toContain('Source project')
  expect(panel().querySelector('.conversation-input-details__body')?.textContent).toContain('Message header: Agent declared-only')
  expect(panel().querySelector('[data-mailbox-location="summary"]')).not.toBeNull()
})
