// @vitest-environment happy-dom
import { beforeEach, expect, it, vi } from 'vitest'
import { composerDOM } from './helpers/composer-dom-fixture'
import { projectConversationRecords } from '@agentmux/client-ui/conversation-records'
import { FocusMessagePreview } from '../src/renderer/src/components/FocusMessagePreview'
import type { AgentTimelineItem } from '@agentmux/core'
import { fixtureEpoch as _historyFixtureEpoch } from '../../../test/fixture-values.mjs'


const dom = composerDOM()
let anchor: HTMLButtonElement
beforeEach(() => {
  const host = document.createElement('div'); host.className = 'recent-focus'; host.innerHTML = '<header class="recent-focus__header"></header><button class="recent-focus__message">Original marker</button>'; document.body.append(host)
  anchor = host.querySelector('button')!
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  vi.stubGlobal('IntersectionObserver', class { observe() {} unobserve() {} disconnect() {} })
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => window.setTimeout(() => callback(0), 0))
  vi.stubGlobal('cancelAnimationFrame', (id: number) => window.clearTimeout(id))
})
const item = (fields: Partial<AgentTimelineItem>): AgentTimelineItem => ({ id: 'original', agentSessionId: 'original-session', source: 'native-hook', kind: 'assistant_message', title: 'Original captured source', status: 'complete', content: 'Complete original contribution', createdAt: _historyFixtureEpoch(0, 0, 10), updatedAt: _historyFixtureEpoch(0, 0, 10), ...fields })
async function preview(original: AgentTimelineItem, host: string | null = 'local') {
  const records = projectConversationRecords({ agentSessionId: original.agentSessionId, executionHostId: host ?? undefined, timeline: { agentSessionId: original.agentSessionId, revision: 1, items: [original] } })
  await dom.render(<FocusMessagePreview message={records[0]} describeSpeaker={speaker => ({ name: speaker.role === 'human' ? 'You' : speaker.role === 'agent' ? speaker.id : 'Author unknown' })}
    sender={undefined} recipient={undefined} lane={undefined} hierarchy={undefined} interactive anchor={anchor} onSelect={() => {}} onClose={() => {}} />)
  expect(document.querySelector('.recent-focus__message-body')?.textContent ?? '').toContain(original.content)
  expect(records).toHaveLength(1)
  return records[0]!
}
it('the real Focus preview consumes Core observation role and complete body, instead of fabricating an Agent reply', async () => {
  const record = await preview(item({}))
  expect(document.querySelector('.recent-focus__message-caption')?.textContent).toContain('采集到的回复')
  expect(document.querySelector('[data-conversation-role="observation"]')?.textContent ?? '').toContain('Complete original contribution')
  expect(document.querySelector('.recent-focus__message-caption')?.textContent).not.toContain('Agent reply')
  expect(record.role).toBe('observation'); expect(record.speaker?.role).toBe('unknown')
})
it.each([{ authorHuman: true }, { authorAgentSessionId: 'actual-author' }])('the production Focus speaker preserves explicit captured attribution %j', async fields => {
  const record = await preview(item(fields))
  expect(document.querySelector('.recent-focus__message-caption')?.textContent).toContain('authorHuman' in fields ? 'Human message' : 'Agent reply')
  expect(record.role).toBe('message')
  expect(record.speaker).toEqual('authorHuman' in fields ? { role: 'human', id: 'human' } : { role: 'agent', id: 'actual-author' })
})
it('an unread canonical anchor or unknown Host never hides accepted contribution content in the actual Focus component', async () => {
  const original = item({ conversation: { sameEvent: { hostId: 'local', agentSessionId: 'original-session', source: { kind: 'native', providerId: 'claude', nativeSessionId: 'original-native', recordId: 'unread' } } } })
  const record = await preview(original)
  expect(record.event?.coalesces).toHaveLength(1)
  expect(document.querySelector('.recent-focus__message-body')?.textContent).toContain(original.content)
  const hostless = await preview(original, null)
  expect(hostless.event?.reference).toBeNull()
  expect(document.querySelector('.recent-focus__message-body')?.textContent).toContain(original.content)
})

it('the actual Core-to-client-ui-to-Focus body consumes every ordered mixed part and does not join an equal Hook snapshot', async () => {
  const sid = 'original-session', body = 'Repeated original body'
  const records = projectConversationRecords({ agentSessionId: sid, executionHostId: 'local', historyPage: { agentSessionId: sid, source: { providerId: 'claude', nativeSessionId: 'native-source' }, nextCursor: null,
    items: [{ id: 'native-mixed', kind: 'assistant-message', startedAt: _historyFixtureEpoch(0, 0, 1), contentParts: [{ kind: 'text', text: body }, { kind: 'reasoning', text: 'Original reasoning' }, { kind: 'text', text: 'Complete final ordered part' }] }] }, timeline: { agentSessionId: sid, revision: 1, items: [item({ content: body })] } })
  const native = records.find(record => record.source.kind === 'native')!
  await dom.render(<FocusMessagePreview message={native} describeSpeaker={speaker => ({ name: speaker.id })} sender={undefined} recipient={undefined} lane={undefined} hierarchy={undefined}
    interactive anchor={anchor} onSelect={() => {}} onClose={() => {}} reader={{ selectionOnly: true, messages: records, loading: false, coverage: 'Exact loaded source window', error: null, onMessage() {} }} />)
  expect(document.querySelector('.recent-focus__message-body')?.textContent).toContain('Complete final ordered part')
  expect(document.querySelectorAll('[data-conversation-record-id]')).toHaveLength(2)
  expect(document.querySelector('[data-conversation-role="observation"][data-conversation-record-id]')?.getAttribute('aria-label')).toContain('采集到的回复')
})
