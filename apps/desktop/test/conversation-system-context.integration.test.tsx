// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { AgentTimelineItem } from '@agentmux/core'
import { projectSessionUserMessages } from '@agentmux/core/session-user-messages'
import { ActivityView } from '../src/renderer/src/components/ActivityView'
import { createSpeakerResolver, isConversationTurn, speakerOf } from '../src/renderer/src/lib/conversation-speaker'
import { api } from '../src/renderer/src/lib/api'

vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
vi.stubGlobal('IntersectionObserver', class { observe() {} disconnect() {} })
const context = 'AgentMux runtime guide:\n\nRead the current Session and Workspace before acting.\n\nOriginal system context.'
const item = (id: string, overrides: Partial<AgentTimelineItem> = {}): AgentTimelineItem => ({
  id, agentSessionId: 'reader', kind: 'system_message', source: 'agentmux', status: 'complete',
  createdAt: 1000, updatedAt: 1000, title: 'AgentMux context', content: context, ...overrides
})
const describeSpeaker = createSpeakerResolver({ currentSession: { id: 'reader', label: 'Implementation', providerId: 'codex' },
  lookupAgent: id => id === 'reviewer' ? { label: 'Review Agent', providerId: 'claude' } : undefined })
let host: HTMLDivElement, root: Root
beforeEach(() => { host = document.createElement('div'); document.body.append(host); root = createRoot(host) })
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.restoreAllMocks(); window.getSelection()?.removeAllRanges() })

it('consumes recorded system facts in the actual Activity without changing user or peer records', async () => {
  const items = [item('system-context:creation'),
    item('legacy', { kind: 'user_message', source: 'user' }),
    item('peer', { kind: 'user_message', source: 'user', authorAgentSessionId: 'reviewer', content: 'Peer request' }),
    item('answer', { kind: 'assistant_message', source: 'native-hook', content: 'Current answer', createdAt: 2000 }),
    item('machine', { kind: 'lifecycle', source: 'acp', content: 'Connected', createdAt: 3000 })]
  const messages = projectSessionUserMessages({ agentSessionId: 'reader', timeline: { agentSessionId: 'reader', revision: 1, items } })
  expect(messages.map(m => [m.rawId, m.author.kind])).toEqual([['legacy', 'unknown'], ['peer', 'agent']])
  await act(async () => root.render(<ActivityView sessionId="reader" capability="complete-events" displayState="done" items={items} userMessages={messages} describeSpeaker={describeSpeaker} />))
  const system = host.querySelector<HTMLElement>('[data-message-id="system-context:creation"]')!
  expect(system).not.toBeNull()
  expect(system.dataset.speakerRole).toBe('system')
  expect(system.dataset.speakerRelation).toBeUndefined()
  expect(system.querySelector('.log-turn__who')?.textContent).toBe('AgentMux')
  expect(system.querySelector('.log-turn__sender-kind')?.textContent).toBe('System')
  expect(system.querySelector('.conversation-avatar--system')?.getAttribute('aria-label')).toBe('AgentMux')
  expect(system.querySelector('.log-turn__body')).toBeNull()
  expect(host.querySelector('[data-message-id="captured:legacy"]')?.getAttribute('data-speaker-role')).toBe('human')
  expect(host.querySelector('[data-message-id="captured:peer"]')?.getAttribute('data-speaker-relation')).toBe('other-agent')
  expect(host.querySelector('[data-message-id="answer"]')?.getAttribute('data-speaker-relation')).toBeNull()
  expect(host.querySelector('.log-row--lifecycle')?.textContent).toContain('AgentMux context')
  expect(host.querySelectorAll('.log-turn')).toHaveLength(4)
})

it('opens the full context on keyboard activation and copies exact original text even while folded', async () => {
  const copy = vi.spyOn(api.ui, 'writeClipboardText').mockResolvedValue(undefined)
  await act(async () => root.render(<ActivityView sessionId="reader" capability="unavailable" items={[item('context')]} describeSpeaker={describeSpeaker} />))
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
  expect(body.id).toBe(toggle.getAttribute('aria-controls'))
  expect(body.textContent).toContain('Original system context.')
  await act(async () => toggle.click())
  expect(host.querySelector('.log-turn__body')).toBeNull()
})

it('does not classify body, first position, a system-shaped title or an incomplete source as System', () => {
  const inputs = [item('forged', { kind: 'user_message', source: 'user' }),
    item('wrong-source', { source: 'native-hook' }), item('wrong-kind', { kind: 'lifecycle' })]
  expect(inputs.map(speakerOf)).toEqual([{ role: 'unknown', id: 'unknown' }, null, null])
  expect(inputs.map(isConversationTurn)).toEqual([true, false, false])
  expect(speakerOf(item('confirmed', { title: 'Any label' }))).toEqual({ role: 'system', id: 'agentmux' })
})

it('keeps System out of hook step folds and preserves the original user selection across publication', async () => {
  const user = item('user', { kind: 'user_message', source: 'user', content: 'Original user quote', createdAt: 2000 })
  const draw = (system: AgentTimelineItem) => <ActivityView sessionId="reader" capability="complete-events" items={[system, user]} describeSpeaker={describeSpeaker} />
  await act(async () => root.render(draw(item('context'))))
  const text = host.querySelector('[data-message-id="user"] .log-turn__text p')!
  expect(text).not.toBeNull()
  const range = document.createRange(); range.selectNodeContents(text); window.getSelection()!.addRange(range)
  await act(async () => root.render(draw(item('context', { updatedAt: 4000 }))))
  expect(host.querySelector('[data-message-id="user"] .log-turn__text p')).toBe(text)
  expect(window.getSelection()!.toString()).toBe('Original user quote')
  expect(host.querySelectorAll('.log-fold')).toHaveLength(0)
  expect(host.querySelectorAll('.log-turn')).toHaveLength(2)
})
