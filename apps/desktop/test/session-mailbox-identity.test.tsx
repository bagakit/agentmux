// @vitest-environment happy-dom
import { act } from 'react'
import { beforeEach, expect, it, vi } from 'vitest'
import type { AgentTimelineItem } from '@agentmux/core'
import { SessionMailbox } from '../src/renderer/src/components/SessionMailbox'
import { useAppStore } from '../src/renderer/src/store'
import { composerDOM, composerSession } from './helpers/composer-dom-fixture'
import { fixtureEpoch as _historyFixtureEpoch } from '../../../test/fixture-values.mjs'


const dom = composerDOM()
const system = { available: true, notices: [], unread: [], acknowledge: vi.fn() }
const panel = () => dom.container.querySelector<HTMLElement>('.composer-mailbox')!
const item = (id: string, author: string | undefined): AgentTimelineItem => ({ id, agentSessionId: 'agent-1',
  kind: 'user_message', source: 'user', status: 'complete', title: 'Original input', content: `Original ${id}`,
  ...(author ? { authorAgentSessionId: author } : {}), createdAt: _historyFixtureEpoch(0, 0, 1), updatedAt: _historyFixtureEpoch(0, 0, 1) })
beforeEach(() => useAppStore.setState({ sessions: [composerSession()], noticeReadReceipts: {} }))
async function open() {
  const event = new Event('toggle'); Object.defineProperty(event, 'newState', { value: 'open' })
  await act(async () => panel().dispatchEvent(event))
}

it('uses the exact shared sender avatar and name in Inbox rows and their original detail', async () => {
  const describeSpeaker = vi.fn((speaker: { role: string; id: string }, size?: number) => ({
    name: speaker.id === 'peer' ? 'Original Mote' : 'Recipient', providerId: 'codex',
    avatar: <span data-original-avatar={speaker.id} data-avatar-size={size}>Original identity</span>
  }))
  await dom.render(<SessionMailbox system={system} queued={[]} reading={{ describeSpeaker }}
    timeline={{ agentSessionId: 'agent-1', revision: 1, items: [item('one', 'peer'), item('two', 'peer')] }} />)
  await open()
  expect(panel().querySelectorAll('.composer-mailbox__row [data-original-avatar="peer"]')).toHaveLength(2)
  expect(panel().querySelector('[data-original-avatar="agent-1"]')).toBeNull()
  expect(panel().querySelectorAll('[data-avatar-size="18"]')).toHaveLength(2)
  expect(describeSpeaker).toHaveBeenCalledWith({ role: 'agent', id: 'peer' }, 18)
  await dom.click('[data-record-key="timeline:one"]')
  expect(panel().querySelector('.log-turn__node [data-original-avatar="peer"]')).not.toBeNull()
  expect(panel().querySelector('.log-turn__who')?.textContent).toContain('Original Mote')
  expect(panel().querySelector('.log-turn__body')?.textContent).toBe('Original one')
})

it('keeps a missing sender identifiable without borrowing the recipient or trusting a body declaration', async () => {
  const declared = { ...item('declared', undefined), content: '[Message from Agent peer]\nDeclared only' }
  await dom.render(<SessionMailbox system={system} queued={[]}
    timeline={{ agentSessionId: 'agent-1', revision: 1, items: [item('missing', 'unknown-peer'), declared] }} />)
  await open()
  await dom.click('[role="tab"][id$="-inbox-tab"]')
  expect(panel().querySelectorAll('.composer-mailbox__row')).toHaveLength(1)
  expect(panel().querySelector('[data-speaker-id="unknown-peer"]')).not.toBeNull()
  expect(panel().querySelector('.composer-mailbox__row')?.textContent).toContain('Agent unknown-')
  await dom.click('[role="tab"][id$="-outbox-tab"]')
  expect(panel().querySelector('[data-record-key="timeline:declared"]')?.textContent).toContain('Author unknown')
  expect(panel().querySelector('[data-record-key="timeline:missing"]')).toBeNull()
  await dom.click('[data-record-key="timeline:declared"]')
  expect(panel().querySelector('.log-turn__who')?.textContent).toBe('Author unknown')
  expect(panel().querySelector('.log-turn__node [data-speaker-role="agent"]')).toBeNull()
  expect(panel().querySelector('.log-turn')?.getAttribute('data-speaker-role')).toBe('unknown')

})

it('does not resolve visible senders again for unrelated Session/name churn', async () => {
  const describeSpeaker = vi.fn((speaker: { id: string }) => ({ name: speaker.id, providerId: 'codex', avatar: <span data-original-avatar={speaker.id} /> }))
  const own = composerSession()
  useAppStore.setState({ sessions: [own] })
  await dom.render(<SessionMailbox system={system} queued={[]} reading={{ describeSpeaker }}
    timeline={{ agentSessionId: 'agent-1', revision: 1, items: [item('one', 'peer')] }} />)
  await open(); describeSpeaker.mockClear()
  await act(async () => useAppStore.setState({ sessions: [own, composerSession('unrelated')], agentNames: { unrelated: 'Changed elsewhere' } }))
  expect(describeSpeaker).not.toHaveBeenCalled()
  expect(panel().querySelector('[data-original-avatar="peer"]')).not.toBeNull()
})
