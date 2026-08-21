// @vitest-environment happy-dom
import { act } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createJSONStorage } from 'zustand/middleware'
import type { AgentTimelineItem } from '@agentmux/core'
vi.hoisted(() => { vi.stubGlobal('__AGENTMUX_WEB_PREVIEW__', true) })
import { AgentSessionComposer } from '../src/renderer/src/components/AgentSessionComposer'
import { useAppStore } from '../src/renderer/src/store'
import { composerDOM, composerSession } from './helpers/composer-dom-fixture'

const dom = composerDOM()
const originalStorage = useAppStore.persist.getOptions().storage
beforeEach(() => useAppStore.setState({ noticeReadReceipts: {}, timelines: {} }))
afterEach(() => useAppStore.persist.setOptions({ storage: originalStorage }))
const trigger = () => dom.container.querySelector<HTMLButtonElement>('.composer__mailbox')!
const unread = () => trigger().getAttribute('data-unread')
async function toggle(state: 'open' | 'closed') {
  const event = new Event('toggle')
  Object.defineProperty(event, 'newState', { value: state })
  await act(async () => dom.container.querySelector('.composer-mailbox')!.dispatchEvent(event))
}
function message(id: string, content = 'Actual private message', agentSessionId = 'agent-1'): AgentTimelineItem {
  return { id, agentSessionId, authorAgentSessionId: 'reviewer', kind: 'user_message', status: 'complete',
    source: 'user', title: 'Prompt', content, createdAt: 1, updatedAt: 1 }
}
async function show(items: AgentTimelineItem[], sessionId = 'agent-1') {
  await act(async () => useAppStore.setState({ sessions: [composerSession(sessionId)],
    timelines: { [sessionId]: { agentSessionId: sessionId, revision: 1, items } } }))
  await dom.render(<AgentSessionComposer sessionId={sessionId} />)
}

it('persists bounded digests for 200 large messages and restores read status through real persist hydration', async () => {
  let durable = ''
  useAppStore.persist.setOptions({ storage: createJSONStorage(() => ({
    getItem: () => durable || null, setItem: (_key, value) => { durable = value }, removeItem: () => { durable = '' }
  })) })
  const digest = vi.spyOn(crypto.subtle, 'digest')
  const items = Array.from({ length: 200 }, (_, i) => message(`prompt:${i}`, `${i}:` + 'private-body-'.repeat(2730)))
  expect(new TextEncoder().encode(JSON.stringify(items)).length).toBeLessThan(8 * 1024 * 1024)
  await show(items)
  await act(async () => { await Promise.all(digest.mock.results.map((result) => result.value)) })
  expect(unread()).toBe('true')
  await toggle('open')
  expect(unread()).toBe('false')
  const receipts = useAppStore.getState().noticeReadReceipts['mail:agent-1']!
  expect(Object.keys(receipts)).toHaveLength(200)
  expect(Object.values(receipts).map((value) => value.length)).toEqual(Array(200).fill(64))
  expect(JSON.stringify(receipts)).not.toContain('private-body-')
  expect(new TextEncoder().encode(JSON.stringify(receipts)).length).toBeLessThan(20 * 1024)
  const saved = durable
  expect(JSON.parse(saved).state.noticeReadReceipts['mail:agent-1']).toEqual(receipts)
  expect(saved).not.toContain('private-body-')
  await dom.render(null)
  useAppStore.setState({ noticeReadReceipts: {}, timelines: {} })
  durable = saved
  await useAppStore.persist.rehydrate()
  await dom.render(<AgentSessionComposer sessionId="agent-1" />)
  expect(useAppStore.getState().noticeReadReceipts['mail:agent-1']).toEqual(receipts)
  await show(JSON.parse(JSON.stringify(items)))
  await act(async () => { await Promise.all(digest.mock.results.map((result) => result.value)) })
  expect(unread()).toBe('false')
  expect(useAppStore.getState().noticeReadReceipts['mail:agent-1']).toEqual(receipts)
})

it.each([
  { content: 'Changed words at the same timestamp' },
  { authorAgentSessionId: 'different-author' },
  { status: 'failed' as const }
])('marks changed mail unread without duplicating its body: %j', async (change) => {
  await show([message('prompt:one')])
  await vi.waitFor(() => expect(unread()).toBe('true'))
  await toggle('open')
  const previous = useAppStore.getState().noticeReadReceipts['mail:agent-1']!['prompt:one']
  expect(previous).toHaveLength(64)
  await toggle('closed')
  await show([{ ...message('prompt:one'), ...change }])
  await vi.waitFor(() => expect(unread()).toBe('true'))
  await toggle('open')
  expect(useAppStore.getState().noticeReadReceipts['mail:agent-1']!['prompt:one']).not.toBe(previous)
})

it('keeps receipts while hashing is pending and ignores late hashes from an old snapshot', async () => {
  const digest = crypto.subtle.digest.bind(crypto.subtle)
  let resolveOld!: (value: ArrayBuffer) => void
  const oldResult = new Promise<ArrayBuffer>((resolve) => { resolveOld = resolve })
  vi.spyOn(crypto.subtle, 'digest').mockImplementationOnce(() => oldResult)
  const prior = { 'prompt:old': 'read-receipt' }
  useAppStore.setState({ noticeReadReceipts: { 'mail:agent-1': prior } })
  await show([message('prompt:old')])
  expect(useAppStore.getState().noticeReadReceipts['mail:agent-1']).toEqual(prior)
  await show([message('prompt:new', 'Current snapshot words')])
  await vi.waitFor(() => expect(unread()).toBe('true'))
  await act(async () => { resolveOld(await digest('SHA-256', new TextEncoder().encode('old'))); await oldResult })
  expect(unread()).toBe('true')
  await toggle('open')
  expect(Object.keys(useAppStore.getState().noticeReadReceipts['mail:agent-1']!)).toEqual(['prompt:new'])
})

it('cleans only the retired Session receipt scopes on an authoritative Run removal', () => {
  const unrelated = { 'mail:agent-2': { incoming: 'keep' }, 'agent-2': { service: 'keep' }, 'global:shell': { environment: 'keep' } }
  useAppStore.setState({ sessions: [composerSession()], noticeReadReceipts: {
    ...unrelated, 'agent-1': { delivery: 'read' }, 'mail:agent-1': { incoming: 'read' }
  } })
  useAppStore.getState().applyEvent({ type: 'core', hostId: 'local', event: {
    type: 'run-removed', agentSessionId: 'agent-1', run: { runId: 'run-agent-1' },
    evidence: { source: 'run-process', observedAt: 2, run: { runId: 'run-agent-1' } }
  } })
  expect(useAppStore.getState().sessions).toEqual([])
  expect(useAppStore.getState().noticeReadReceipts).toEqual(unrelated)
  expect(useAppStore.persist.getOptions().partialize!(useAppStore.getState()).noticeReadReceipts).toEqual(unrelated)
})


it('does not rehash or hide unread messages for activity-only timeline revisions', async () => {
  const digest = vi.spyOn(crypto.subtle, 'digest')
  const incoming = message('prompt:one')
  await show([incoming])
  await vi.waitFor(() => expect(unread()).toBe('true'))
  expect(digest).toHaveBeenCalledTimes(1)
  await show([{ ...incoming }, { ...message('tool'), kind: 'tool_call' }])
  expect(unread()).toBe('true')
  expect(digest).toHaveBeenCalledTimes(1)
})
