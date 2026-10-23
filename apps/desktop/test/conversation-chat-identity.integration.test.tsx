import { fixturePath as _hygiene_fixturePath } from "../scripts/lib/fixture-values.mjs"
import { activityReadingProps } from './helpers/activity-reading-props'
import { conversationPagePortFixture } from './helpers/conversation-page-port-fixture'
import { processNativeRecordIds } from './helpers/conversation-process-members'
import { inspectConversationConsumers } from '../src/renderer/src/lib/conversation-consumer-observation'
// @vitest-environment happy-dom
import { act } from 'react'
import { type Root } from 'react-dom/client'
import { createClientUiRoot as createRoot } from './helpers/client-ui-render'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { AgentSessionHistoryPage, AgentTimelineItem } from '@agentmux/core'
import { projectSessionUserMessages } from '@agentmux/core/session-user-messages'
import { ActivityView } from '../src/renderer/src/components/ActivityView'
import { ConversationMessage } from '@agentmux/client-ui/components/ConversationMessage'

import { createSpeakerResolver, speakerOfUserMessage } from '@agentmux/client-ui/conversation-speaker'
import { api } from '../src/renderer/src/lib/api'
import type { AgentSessionControl } from '../src/shared/contracts'

const control: AgentSessionControl = { kind: 'agent', hostId: 'local', agentSessionId: 'reader', run: { runId: 'original-run' } }
const describeSpeaker = createSpeakerResolver({
  currentSession: { id: 'reader', label: 'Implementation', providerId: 'codex' },
  lookupAgent: id => id === 'reviewer' ? { label: 'Review Agent', providerId: 'claude' } : undefined
})
const record = (id: string, overrides: Partial<AgentTimelineItem> = {}): AgentTimelineItem => ({
  id, agentSessionId: 'reader', kind: 'user_message', source: 'user', status: 'complete',
  createdAt: 1_000, updatedAt: overrides.createdAt ?? 1_000, title: 'Prompt', content: 'original input', ...overrides
})
const page: AgentSessionHistoryPage = { agentSessionId: 'reader', source: { providerId: 'codex', nativeSessionId: 'original-native' },
  items: [
    { id: 'native-input', kind: 'user-message', contentParts: [{ kind: 'text', text: 'Original native input' }] },
    { id: 'native-answer', kind: 'assistant-message', contentParts: [
      { kind: 'reasoning', text: 'Preserve the original reading state.' }, { kind: 'text', text: 'Original answer' }
    ] },
    { id: 'native-activity', kind: 'activity', title: 'Native event', contentParts: [{ kind: 'resource', resourceType: 'file', reference: 'original.log' }] }
  ], nextCursor: null }
let host: HTMLDivElement, root: Root
let source: Awaited<ReturnType<typeof conversationPagePortFixture>> | undefined
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  vi.stubGlobal('IntersectionObserver', class { observe() {} unobserve() {} disconnect() {} })
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
})
afterEach(async () => {
  await act(async () => root.unmount()); host.remove(); window.getSelection()?.removeAllRanges()
  const original = source; source = undefined
  try { if (original) expect(original.controls.every(control => control.mock.calls.length === 0)).toBe(true) }
  finally { if (original) await original.close(); vi.restoreAllMocks(); vi.unstubAllGlobals() }
})
async function showReading(items: readonly AgentTimelineItem[] = [], nativePage: AgentSessionHistoryPage = { ...page, items: [] }) {
  source = await conversationPagePortFixture(control, nativePage.source, async agentSessionId => {
    expect(agentSessionId).toBe(control.agentSessionId); return nativePage
  })
  const stream = items.length ? await source.publishCaptured(items) : null
  await act(async () => root.render(<ActivityView {...activityReadingProps({ control, label: 'Implementation', describeSpeaker,
    visible: true, workspaceRoot: _hygiene_fixturePath('private'), openWorkspaceFile: vi.fn(), openHttpLink: vi.fn() })} />))
  await vi.waitFor(() => {
    const consumer = inspectConversationConsumers(control).consumers[0]
    expect(consumer?.accepted).not.toBeNull()
    expect(consumer).toMatchObject({ loading: false, inFlight: false, watch: { binding: false } })
    if (stream) expect(source!.acceptedCaptured(stream)).toBe(true)
  })
  await act(async () => {
    for (const details of host.querySelectorAll<HTMLDetailsElement>('.message-disclosure')) {
      details.open = true; details.dispatchEvent(new Event('toggle'))
    }
  })
}

it('uses recorded peer identity and the user display default in the actual Activity caller', async () => {
  const inputs = [record('peer', { authorAgentSessionId: 'reviewer', content: 'Review from another Agent' }),
    record('legacy', { content: 'Unattributed input' }), record('manual', { authorHuman: true, content: 'Manual input' })]
  const messages = projectSessionUserMessages({ agentSessionId: 'reader', timeline: { agentSessionId: 'reader', revision: 1, items: inputs } })
  expect(messages.map(m => [m.id, m.author.kind])).toEqual([['captured:peer', 'agent'], ['captured:legacy', 'unknown'], ['captured:manual', 'human']])
  await showReading([...inputs, record('answer', { kind: 'assistant_message', source: 'native-hook', authorAgentSessionId: 'reader', createdAt: 2_000, content: 'Current Agent answer' })])
  expect([...host.querySelectorAll<HTMLElement>('.log-turn')].map(e => e.dataset.messageId)).toEqual(['captured:peer', 'captured:legacy', 'captured:manual', 'answer'])
  const peer = host.querySelector<HTMLElement>('[data-message-id="captured:peer"]')!
  expect(peer.dataset.speakerRelation).toBe('other-agent')
  expect(peer.querySelector('.log-turn__who')?.textContent).toBe('Review Agent')
  expect(peer.querySelector('.log-turn__sender-kind')?.textContent).toBe('Agent')
  expect(peer.querySelector('.conversation-avatar--agent')?.getAttribute('aria-label')).toBe('Review Agent')
  const own = host.querySelector<HTMLElement>('[data-message-id="answer"]')!
  expect(own.dataset.speakerRelation).toBeUndefined()
  expect(own.querySelector('.log-turn__who')?.textContent).toBe('Implementation')
  for (const id of ['captured:legacy', 'captured:manual']) {
    const user = host.querySelector<HTMLElement>(`[data-message-id="${id}"]`)!
    expect(user.dataset.speakerRole).toBe('human')
    expect(user.querySelector('.log-turn__who')?.textContent).toBe('You')
    expect(user.querySelector('.conversation-avatar--human')).not.toBeNull()
    expect(user.querySelector('[role="note"]')).toBeNull()
  }
  expect(speakerOfUserMessage(messages[1]!)).toEqual({ role: 'unknown', id: 'unknown' })
  expect(messages[1]!.author).toEqual({ kind: 'unknown' })
  expect((await source!.client.sessionTimeline('reader')).items.slice(0, 3)).toEqual(inputs)
})

it('keeps native attribution unknown while History presents the same user appearance', async () => {
  const copy = vi.spyOn(api.ui, 'writeClipboardText').mockResolvedValue(undefined)
  await showReading([], page)
  const thread = host.querySelector('.conversation-native-thread')!
  expect([...thread.children].flatMap(node => {
    const element = node as HTMLElement
    return element.dataset.nativeRecordId ? [element.dataset.nativeRecordId] : processNativeRecordIds(element)
  })).toEqual(['native-input', 'native-answer', 'native-activity'])
  const originalInput = projectSessionUserMessages({ agentSessionId: 'reader', historyPage: page })[0]!
  const native = host.querySelector<HTMLElement>(`[data-message-id="${originalInput.id}"]`)!
  expect(native).not.toBeNull()
  expect(native.dataset.speakerRole).toBe('human')
  expect(native.querySelector('.log-turn__who')?.textContent).toBe('You')
  expect(native.querySelector('.conversation-avatar--human')).not.toBeNull()
  expect(native.textContent).not.toContain('作者未记录')
  expect(originalInput.author).toEqual({ kind: 'unknown' })
  const answer = host.querySelector('[data-native-record-id="native-answer"] .log-turn')
  expect(answer).not.toBeNull(); expect(answer!.getAttribute('data-speaker-relation')).toBeNull()
  const processGroup = host.querySelector<HTMLElement>('[data-conversation-process-members]')!
  await act(async () => processGroup.querySelector<HTMLButtonElement>('.wf-head')!.click())
  const step = processGroup.querySelector<HTMLElement>('[data-native-step-id="native-activity"]')!
  expect(step.getAttribute('data-speaker-role')).toBeNull()
  const disclosure = step.querySelector<HTMLButtonElement>('[aria-expanded="false"]')
  if (disclosure) await act(async () => disclosure.click())
  const resource = step.querySelector('.conversation-resource-file')
  expect(resource).not.toBeNull()
  await act(async () => { const details = resource!.querySelector('details')!; details.open = true; details.dispatchEvent(new Event('toggle')) })
  await act(async () => resource!.querySelector<HTMLButtonElement>('[aria-label="Copy file reference"]')!.click())
  expect(copy).toHaveBeenCalledExactlyOnceWith('original.log')
})

it('does not guess peer identity from names, body, missing context or colliding sentinels', async () => {
  await act(async () => root.render(<>
    <ConversationMessage messageId="self" conversationSessionId="reader" speaker={{ role: 'agent', id: 'reader' }} name="Other Agent" content="Agent: from elsewhere" />
    <ConversationMessage messageId="no-context" speaker={{ role: 'agent', id: 'reviewer' }} content="Peer without host context" />
    <ConversationMessage messageId="empty-context" conversationSessionId="" speaker={{ role: 'agent', id: 'reviewer' }} content="Unknown context" />
    <ConversationMessage messageId="empty-author" conversationSessionId="reader" speaker={{ role: 'agent', id: '' }} content="Missing identity" />
    <ConversationMessage messageId="sentinel" conversationSessionId="reader" speaker={{ role: 'agent', id: 'unknown' }} content="Known Agent with sentinel-shaped ID" />
    <ConversationMessage messageId="machine" content="Machine event" />
  </>))
  expect([...host.querySelectorAll<HTMLElement>('.log-turn')].map(e => [e.dataset.messageId, e.dataset.speakerRelation])).toEqual([
    ['self', undefined], ['no-context', undefined], ['empty-context', undefined], ['empty-author', undefined], ['sentinel', 'other-agent'], ['machine', undefined]
  ])
  expect(host.querySelector('[data-message-id="machine"]')?.getAttribute('data-speaker-role')).toBeNull()
})

it('preserves peer text nodes, exact copied content and the selected quote across an update', async () => {
  const copy = vi.spyOn(api.ui, 'writeClipboardText').mockResolvedValue(undefined)
  const annotate = vi.fn()
  const draw = () => <ConversationMessage messageId="original-peer-id" conversationSessionId="reader" speaker={{ role: 'agent', id: 'reviewer' }}
    name="Review Agent" content={'  **Keep the original quote**\n'} onSelectAnnotation={annotate} />
  await act(async () => root.render(draw()))
  const text = host.querySelector('.log-turn__text strong')!
  const range = document.createRange(); range.selectNodeContents(text)
  window.getSelection()!.addRange(range)
  await act(async () => text.dispatchEvent(new MouseEvent('mouseup', { bubbles: true })))
  expect(annotate).toHaveBeenCalledOnce()
  expect(annotate.mock.calls[0]![0].messageId).toBe('original-peer-id')
  expect(annotate.mock.calls[0]![0].quote).toBe('Keep the original quote')
  await act(async () => root.render(draw()))
  expect(host.querySelector('.log-turn__text strong')).toBe(text)
  expect(window.getSelection()!.toString()).toBe('Keep the original quote')
  await act(async () => host.querySelector<HTMLButtonElement>('[title="Copy message"]')!.click())
  expect(copy).toHaveBeenCalledExactlyOnceWith('  **Keep the original quote**\n')
})

it('uses the same user avatar on the Activity speaker axis without changing raw marker identity', async () => {
  const messages = projectSessionUserMessages({ agentSessionId: 'reader', timeline: { agentSessionId: 'reader', revision: 1,
    items: [record('legacy-axis', { content: 'A legacy input', createdAt: 1_000 }), record('peer-axis', { authorAgentSessionId: 'reviewer', createdAt: 2_000 })] } })
  await showReading([record('legacy-axis', { content: 'A legacy input', createdAt: 1_000 }), record('peer-axis', { authorAgentSessionId: 'reviewer', createdAt: 2_000 })])
  const marks = [...host.querySelectorAll('.conversation-axis__mark')]
  expect(marks).toHaveLength(2)
  expect(marks[0]!.getAttribute('aria-label')).toBe('You')
  expect(marks[0]!.querySelector('.conversation-avatar--human')).not.toBeNull()
  expect(marks[1]!.getAttribute('aria-label')).toBe('Review Agent')
  expect(messages.map(m => m.author.kind)).toEqual(['unknown', 'agent'])
})
