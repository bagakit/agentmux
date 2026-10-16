// @vitest-environment happy-dom
import { fixtureEpoch as _tailFixtureEpoch } from "../../../test/fixture-values.mjs"
import { act } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createJSONStorage } from 'zustand/middleware'
vi.hoisted(() => { vi.stubGlobal('__AGENTMUX_WEB_PREVIEW__', true) })
import { AgentSessionComposer } from '../src/renderer/src/components/AgentSessionComposer'
import { useAppStore } from '../src/renderer/src/store'
import { composerDOM, composerSession } from './helpers/composer-dom-fixture'
import { journalMessage, journalMetadata, mailboxJournal } from './helpers/mailbox-journal-fixture'

const dom = composerDOM()
const originalStorage = useAppStore.persist.getOptions().storage
let journal: ReturnType<typeof mailboxJournal>
beforeEach(() => { journal = mailboxJournal(); useAppStore.setState({ noticeReadReceipts: {}, timelines: {} }) })
afterEach(() => useAppStore.persist.setOptions({ storage: originalStorage }))
const trigger = () => dom.container.querySelector<HTMLButtonElement>('.composer__mailbox')!
const unread = () => trigger().getAttribute('data-unread')
const receiptKey = (id: string, hostId = 'local') => JSON.stringify([hostId, id])
async function toggle(state: 'open' | 'closed') {
  const event = new Event('toggle'); Object.defineProperty(event, 'newState', { value: state })
  await act(async () => dom.container.querySelector('.composer-mailbox')!.dispatchEvent(event))
  if (state === 'open') await dom.click('[id$="-inbox-tab"]')
}
async function show(sessionId = 'agent-1', hostId = 'local') {
  const session = composerSession(sessionId)
  await act(async () => useAppStore.setState({ sessions: [{ ...session, hostId, control: { ...session.control, hostId } }] }))
  await dom.render(<AgentSessionComposer sessionId={sessionId} />)
}

it('persists only immutable MID/sequence receipts for 200 large original messages through real persist hydration', async () => {
  let durable = ''
  useAppStore.persist.setOptions({ storage: createJSONStorage(() => ({
    getItem: () => durable || null, setItem: (_key, value) => { durable = value }, removeItem: () => { durable = '' }
  })) })
  const digest = vi.spyOn(crypto.subtle, 'digest')
  const records = Array.from({ length: 200 }, (_, i) => journalMessage({ id: `message-${i}`, sequence: i + 1,
    body: `${i}:` + 'private-body-'.repeat(2730) }))
  journal.set(records); await show()
  expect(unread()).toBe('true')
  expect(trigger().querySelector('.composer-mailbox__unread')!.textContent).toBe('25')
  expect(trigger().getAttribute('aria-label')).toContain('A2A Inbox 25 unread in loaded messages')
  expect(journal.list.mock.calls.every(([, query]) => query.limit === 25)).toBe(true)
  expect(journal.read).not.toHaveBeenCalled(); expect(digest).not.toHaveBeenCalled()
  await toggle('open')
  for (let page = 1; page < 8; ++page) {
    const earlier = [...dom.container.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'Read earlier messages')!
    expect(earlier).toBeDefined(); await act(async () => earlier.click())
  }
  expect(journal.list).toHaveBeenCalledTimes(8)
  expect(unread()).toBe('false')
  const receipts = useAppStore.getState().noticeReadReceipts['mail:agent-1']!
  expect(Object.keys(receipts)).toHaveLength(200)
  for (const record of records) expect(receipts[receiptKey(record.envelope.messageId)]).toBe(String(record.sequence))
  expect(new TextEncoder().encode(JSON.stringify(receipts)).length).toBeLessThan(20 * 1024)
  const saved = durable
  expect(JSON.parse(saved).state.noticeReadReceipts['mail:agent-1']).toEqual(receipts)
  expect(saved).not.toContain('private-body-')
  await dom.render(null); useAppStore.setState({ noticeReadReceipts: {}, timelines: {} }); durable = saved
  await useAppStore.persist.rehydrate(); await show(); await journal.publish(records)
  expect(unread()).toBe('false')
  expect(useAppStore.getState().noticeReadReceipts['mail:agent-1']).toEqual(receipts)
  expect(journal.read).not.toHaveBeenCalled(); expect(digest).not.toHaveBeenCalled()
})

it('keeps original human-read identity through delivery receipt updates and marks only a new MID unread', async () => {
  const original = journalMessage({ id: 'original', delivery: { state: 'queued', at: _tailFixtureEpoch(0, 0, 1) } })
  journal.set([original]); await show(); await toggle('open'); await toggle('closed')
  const previous = useAppStore.getState().noticeReadReceipts['mail:agent-1']!
  const delivered = { ...original, delivery: { state: 'delivered' as const, at: _tailFixtureEpoch(0, 0, 2) } }
  journal.set([delivered]); await journal.changed(delivered)
  expect(unread()).toBe('false'); expect(useAppStore.getState().noticeReadReceipts['mail:agent-1']).toEqual(previous)
  const next = journalMessage({ id: 'next', sequence: 2 })
  journal.set([delivered, next]); await journal.changed(next)
  expect(unread()).toBe('true')
  await toggle('open')
  expect(useAppStore.getState().noticeReadReceipts['mail:agent-1']).toEqual({ ...previous, [receiptKey('next')]: '2' })
})

it('rejects changed immutable original content instead of deriving a new read identity from its body', async () => {
  const original = journalMessage({ id: 'original' }); journal.set([original]); await show(); await toggle('open'); await toggle('closed')
  const previous = useAppStore.getState().noticeReadReceipts['mail:agent-1']
  const changed = { ...original, envelope: { ...original.envelope, body: 'A different body under the same MID is a source conflict' } }
  journal.set([changed]); await journal.changed(changed)
  expect(unread()).toBe('false'); expect(useAppStore.getState().noticeReadReceipts['mail:agent-1']).toEqual(previous)
  await toggle('open')
  expect(dom.container.textContent).toContain('An original message changed immutable content')
  expect(dom.container.textContent).not.toContain(changed.envelope.body)
})

it('does not prune older human reads when a fresh bounded page is incomplete or temporarily empty', async () => {
  const old = journalMessage({ id: 'old' }); journal.set([old]); await show(); await toggle('open'); await toggle('closed')
  const prior = useAppStore.getState().noticeReadReceipts['mail:agent-1']!
  await dom.render(null); journal.set([]); await show()
  expect(useAppStore.getState().noticeReadReceipts['mail:agent-1']).toEqual(prior)
  const next = journalMessage({ id: 'new', sequence: 2 }); journal.set([next]); await journal.changed(next)
  expect(unread()).toBe('true'); await toggle('open')
  expect(useAppStore.getState().noticeReadReceipts['mail:agent-1']).toEqual({ ...prior, [receiptKey('new')]: '2' })
})

it('keeps the same MID independent across exact Hosts and Sessions', async () => {
  const original = journalMessage({ id: 'same-mid' }); journal.set([original]); await show(); await toggle('open'); await toggle('closed')
  journal.set([original], 'remote'); await show('agent-1', 'remote')
  expect(unread()).toBe('true'); await toggle('open'); await toggle('closed')
  expect(useAppStore.getState().noticeReadReceipts['mail:agent-1']).toEqual({ [receiptKey('same-mid')]: '1', [receiptKey('same-mid', 'remote')]: '1' })
  const other = journalMessage({ id: 'same-mid', recipient: 'agent-2' }); journal.set([other], 'remote'); await show('agent-2', 'remote')
  expect(unread()).toBe('true'); await toggle('open')
  expect(useAppStore.getState().noticeReadReceipts['mail:agent-2']).toEqual({ [receiptKey('same-mid', 'remote')]: '1' })
})

it('ignores a late page from the previous Session and retains the current original read identity', async () => {
  let complete!: (page: Awaited<ReturnType<typeof journal.list>>) => void
  journal.list.mockImplementationOnce(() => new Promise(resolve => { complete = resolve }))
  await show()
  const current = journalMessage({ id: 'current', recipient: 'agent-2' }); journal.set([current]); await show('agent-2')
  expect(unread()).toBe('true'); await toggle('open')
  await act(async () => complete({ hostId: 'local', participantSessionId: 'agent-1', direction: 'incoming',
    messages: [journalMetadata(journalMessage({ id: 'obsolete' }))], nextBeforeSequence: null }))
  expect(unread()).toBe('false')
  expect(useAppStore.getState().noticeReadReceipts['mail:agent-2']).toEqual({ [receiptKey('current')]: '1' })
  expect(dom.container.textContent).not.toContain('Original obsolete')
})

it('cleans only the retired Session receipt scopes on authoritative Run removal', () => {
  const unrelated = { 'mail:agent-2': { incoming: 'keep' }, 'agent-2': { service: 'keep' }, 'global:shell': { environment: 'keep' } }
  useAppStore.setState({ sessions: [composerSession()], noticeReadReceipts: { ...unrelated,
    'agent-1': { delivery: 'read' }, 'mail:agent-1': { [receiptKey('original')]: '1' } } })
  useAppStore.getState().applyEvent({ type: 'core', hostId: 'local', event: {
    type: 'run-removed', agentSessionId: 'agent-1', run: { runId: 'run-agent-1' },
    evidence: { source: 'run-process', observedAt: _tailFixtureEpoch(0, 0, 2), run: { runId: 'run-agent-1' } }
  } })
  expect(useAppStore.getState().sessions).toEqual([]); expect(useAppStore.getState().noticeReadReceipts).toEqual(unrelated)
  expect(useAppStore.persist.getOptions().partialize!(useAppStore.getState()).noticeReadReceipts).toEqual(unrelated)
})

it('does not query or hash messages for activity-only timeline revisions', async () => {
  const digest = vi.spyOn(crypto.subtle, 'digest'), original = journalMessage({ id: 'original' })
  journal.set([original]); await show()
  const calls = journal.list.mock.calls.length
  await act(async () => useAppStore.setState({ timelines: { 'agent-1': { agentSessionId: 'agent-1', revision: 2,
    items: [{ id: 'tool', agentSessionId: 'agent-1', kind: 'tool_call', status: 'complete', source: 'test', title: 'Unrelated activity', content: 'Tool output', createdAt: _tailFixtureEpoch(0, 0, 1), updatedAt: _tailFixtureEpoch(0, 0, 1) }] } } }))
  expect(unread()).toBe('true'); expect(journal.list).toHaveBeenCalledTimes(calls); expect(digest).not.toHaveBeenCalled()
})
