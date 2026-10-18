// @vitest-environment happy-dom
import { act } from 'react'
import { type Root } from 'react-dom/client'
import { createClientUiRoot as createRoot } from './helpers/client-ui-render'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { AgentTimelineItem } from '@agentmux/core'
import { projectSessionUserMessages } from '@agentmux/core/session-user-messages'
import { ActivityView } from '../src/renderer/src/components/ActivityView'
import { createSpeakerResolver } from '@agentmux/client-ui/conversation-speaker'
import { isConversationTurn, speakerOf } from '../src/renderer/src/lib/conversation-speaker'
import { api } from '../src/renderer/src/lib/api'
import { activityReadingProps } from './helpers/activity-reading-props'
import { conversationPagePortFixture } from './helpers/conversation-page-port-fixture'

vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
vi.stubGlobal('IntersectionObserver', class { observe() {} unobserve() {} disconnect() {} })
const context = 'AgentMux runtime guide:\n\nRead the current Session and Workspace before acting.\n\nOriginal system context.'
const item = (id: string, overrides: Partial<AgentTimelineItem> = {}): AgentTimelineItem => {
  const createdAt = overrides.createdAt ?? 1000
  return { id, agentSessionId: 'reader', kind: 'system_message', source: 'agentmux', status: 'complete',
    createdAt, updatedAt: createdAt, title: 'AgentMux context', content: context, ...overrides }
}
const describeSpeaker = createSpeakerResolver({ currentSession: { id: 'reader', label: 'Implementation', providerId: 'codex' },
  lookupAgent: id => id === 'reviewer' ? { label: 'Review Agent', providerId: 'claude' } : undefined })
const reference = { hostId: 'local', agentSessionId: 'reader' }
const nativeSource = { providerId: 'codex', nativeSessionId: 'reader-native' }
let host: HTMLDivElement, root: Root, source: Awaited<ReturnType<typeof conversationPagePortFixture>>
beforeEach(async () => {
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
  source = await conversationPagePortFixture(reference, nativeSource, async () => ({ agentSessionId: reference.agentSessionId,
    source: nativeSource, items: [], nextCursor: null }))
})
afterEach(async () => {
  await act(async () => root.unmount()); host.remove(); window.getSelection()?.removeAllRanges()
  await source.close(); vi.restoreAllMocks()
})
async function draw(items: AgentTimelineItem[], capability: 'unavailable' | 'complete-events' = 'complete-events') {
  const stream = await source.publishCaptured(items)
  await act(async () => root.render(<ActivityView {...activityReadingProps({ control: reference, describeSpeaker })}
    capability={capability} displayState="done" />))
  await vi.waitFor(async () => {
    await act(async () => { await Promise.resolve() })
    expect(source.acceptedCaptured(stream), 'The real Activity Reader must accept the exact original captured publication').toBe(true)
  }, { timeout: 3000, interval: 10 })
}
async function openRecordedMessages() {
  await act(async () => {
    for (const disclosure of host.querySelectorAll<HTMLDetailsElement>('.conversation-submission-record .message-disclosure')) {
      disclosure.open = true; disclosure.dispatchEvent(new Event('toggle'))
    }
    for (const toggle of host.querySelectorAll<HTMLButtonElement>('.conversation-reply-observation__toggle[aria-expanded="false"]')) toggle.click()
  })
}

it('consumes recorded system facts in the actual Activity without changing user or peer records', async () => {
  const items = [item('system-context:creation'),
    item('legacy', { kind: 'user_message', source: 'user' }),
    item('peer', { kind: 'user_message', source: 'user', authorAgentSessionId: 'reviewer', content: 'Peer request' }),
    item('answer', { kind: 'assistant_message', source: 'native-hook', content: 'Current answer', createdAt: 2000 }),
    item('machine', { kind: 'lifecycle', source: 'acp', content: 'Connected', createdAt: 3000 })]
  const messages = projectSessionUserMessages({ agentSessionId: 'reader', timeline: { agentSessionId: 'reader', revision: 1, items } })
  expect(messages.map(m => [m.rawId, m.author.kind])).toEqual([['legacy', 'unknown'], ['peer', 'agent']])
  await draw(items)
  await openRecordedMessages()
  await act(async () => host.querySelector<HTMLButtonElement>('.conversation-record-process .wf-head')!.click())
  const system = host.querySelector<HTMLElement>('[data-message-id="system-context:creation"]')!
  expect(system).not.toBeNull()
  expect(system.dataset.speakerRole).toBe('system')
  expect(system.dataset.speakerRelation).toBeUndefined()
  expect(system.querySelector('.log-turn__system-toggle')?.getAttribute('aria-expanded')).toBe('false')
  expect(system.querySelector('.log-turn__system-title')?.textContent).toBe('AgentMux context')
  expect(system.querySelector('.conversation-avatar--system')?.getAttribute('aria-label')).toBe('AgentMux')
  expect(system.querySelector('.log-turn__body')).toBeNull()
  expect(host.querySelector('[data-message-id="captured:legacy"]')?.getAttribute('data-speaker-role')).toBe('human')
  const originalInput = host.querySelector<HTMLElement>('[data-submission-id="legacy"]')!
  expect(JSON.parse(originalInput.dataset.conversationAuthor!)).toEqual({ kind: 'unknown' })
  expect(host.querySelector('[data-message-id="captured:peer"]')?.getAttribute('data-speaker-relation')).toBe('other-agent')
  expect(host.querySelector('[data-message-id="answer"]')?.getAttribute('data-speaker-relation')).toBeNull()
  expect(host.querySelector('.log-row--lifecycle')?.textContent).toContain('AgentMux context')
  expect(host.querySelectorAll('.log-turn')).toHaveLength(4)
})

it('opens the full context on keyboard activation and copies exact original text even while folded', async () => {
  const copy = vi.spyOn(api.ui, 'writeClipboardText').mockResolvedValue(undefined)
  await draw([item('context')], 'unavailable')
  const toggle = host.querySelector<HTMLButtonElement>('.log-turn__system-toggle')!
  expect(toggle).not.toBeNull()
  expect(toggle.getAttribute('aria-expanded')).toBe('false')
  toggle.focus(); expect(document.activeElement).toBe(toggle)
  await act(async () => host.querySelector<HTMLButtonElement>('[title="Copy message"]')!.click())
  expect(copy).toHaveBeenCalledExactlyOnceWith(context)
  await act(async () => toggle.click())
  expect(toggle.getAttribute('aria-expanded')).toBe('true')
  const body = host.querySelector<HTMLElement>('.log-turn__body')!
  expect(body).not.toBeNull()
  const panel = host.querySelector<HTMLElement>('.log-turn__system-body')!
  expect(panel.id).toBe(toggle.getAttribute('aria-controls')); expect(panel.hidden).toBe(false)
  expect(body.textContent).toContain('Original system context.')
  await act(async () => toggle.click())
  expect(host.querySelector('.log-turn__body')).toBe(body)
  expect(panel.hidden).toBe(true); expect(panel.hasAttribute('inert')).toBe(true)
})

it('does not classify body, first position, a system-shaped title or an incomplete source as System', () => {
  const inputs = [item('forged', { kind: 'user_message', source: 'user' }),
    item('wrong-source', { source: 'native-hook' }), item('wrong-kind', { kind: 'lifecycle' })]
  expect(inputs.map(speakerOf)).toEqual([{ role: 'unknown', id: 'unknown' }, { role: 'unknown', id: 'unknown' }, null])
  expect(inputs.map(isConversationTurn)).toEqual([true, true, false])
  expect(speakerOf(item('confirmed', { title: 'Any label' }))).toEqual({ role: 'system', id: 'agentmux' })
  expect(speakerOf(item('agent-recorded', { authorAgentSessionId: 'reviewer' }))).toEqual({ role: 'agent', id: 'reviewer' })
  expect(speakerOf(item('human-recorded', { authorHuman: true }))).toEqual({ role: 'human', id: 'human' })
})

it('keeps System out of hook step folds and preserves the original user selection across publication', async () => {
  const user = item('user', { kind: 'user_message', source: 'user', content: 'Original user quote', createdAt: 2000 })
  await draw([item('context'), user])
  await openRecordedMessages()
  const text = host.querySelector('[data-submission-id="user"] .log-turn__text p')!
  expect(text).not.toBeNull()
  const range = document.createRange(); range.selectNodeContents(text); window.getSelection()!.addRange(range)
  await draw([item('context', { updatedAt: 4000 }), user])
  expect(host.querySelector('[data-submission-id="user"] .log-turn__text p')).toBe(text)
  expect(window.getSelection()!.toString()).toBe('Original user quote')
  expect(host.querySelectorAll('.conversation-record-process')).toHaveLength(0)
  expect(host.querySelectorAll('.log-turn')).toHaveLength(2)
})
