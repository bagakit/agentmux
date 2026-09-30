// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { AgentSessionHistoryPage, AgentTimelineItem } from '@agentmux/core'
import { parseAgentMuxMessagePrefix } from '@agentmux/core/agent-message-render'
import { projectSessionUserMessages } from '@agentmux/core/session-user-messages'
import { ActivityView } from '../src/renderer/src/components/ActivityView'
import { ConversationMessage } from '../src/renderer/src/components/ConversationMessage'
import { SessionHistoryView } from '../src/renderer/src/components/SessionHistoryView'
import { createSpeakerResolver } from '../src/renderer/src/lib/conversation-speaker'
import { api } from '../src/renderer/src/lib/api'
import type { AgentSessionControl } from '../src/shared/contracts'
vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
vi.stubGlobal('IntersectionObserver', class { observe() {} disconnect() {} })
let host: HTMLDivElement, root: Root
beforeEach(() => { host = document.createElement('div'); document.body.append(host); root = createRoot(host) })
afterEach(async () => { await act(async () => root.unmount()); host.remove(); window.getSelection()?.removeAllRanges(); vi.restoreAllMocks() })
const wire = '[Message From Agent reviewer]\n**Keep the original quote**\nA second line.\n'
const record = (id: string, extra: Partial<AgentTimelineItem> = {}): AgentTimelineItem => ({ id, agentSessionId: 'reader', kind: 'user_message', source: 'user', status: 'complete', createdAt: 1_000, updatedAt: 1_000, title: 'Input', content: wire, ...extra })
const control: AgentSessionControl = { kind: 'agent', hostId: 'local', agentSessionId: 'reader', run: { runId: 'original-run' } }
const describeSpeaker = createSpeakerResolver({ currentSession: { id: 'reader', label: 'Implementation', providerId: 'codex' }, lookupAgent: id => id === 'reviewer' ? { label: 'Review Agent', providerId: 'claude' } : undefined })
const page: AgentSessionHistoryPage = { agentSessionId: 'reader', source: { providerId: 'codex', nativeSessionId: 'original-native' }, items: [
  { id: 'native-prefix', kind: 'user-message', contentParts: [{ kind: 'text', text: wire }] },
  { id: 'native-answer', kind: 'assistant-message', contentParts: [{ kind: 'text', text: 'Current answer' }] },
  { id: 'native-prefix-again', kind: 'user-message', contentParts: [{ kind: 'text', text: wire }] }
], nextCursor: null }

it('recognizes only a complete leading reading wrapper and never authenticates it', () => {
  expect(parseAgentMuxMessagePrefix(wire)).toEqual({ sourceLabel: 'Agent reviewer', declaredAgentSessionId: 'reviewer', body: '**Keep the original quote**\nA second line.\n' })
  expect(parseAgentMuxMessagePrefix('[MESSAGE FROM unverified local process]\r\nraw <body>')).toEqual({ sourceLabel: 'unverified local process', declaredAgentSessionId: null, body: 'raw <body>' })
  expect(parseAgentMuxMessagePrefix('[Message from a named colleague]\ntext')?.declaredAgentSessionId).toBeNull()
  const rejected = ['[Message from Agent reviewer]', '[Message from Agent reviewer]\n   ', '[Message from ]\ntext', '> '+wire, '```\n'+wire+'```', 'Introduction\n'+wire, '[Message from Agent reviewer\ntext']
  expect(rejected).toHaveLength(7)
  for (const text of rejected) expect(parseAgentMuxMessagePrefix(text)).toBeNull()
})

it('routes actual Activity native and captured inputs right while preserving trusted speaker facts', async () => {
  const captured = [record('peer', { authorAgentSessionId: 'reviewer' }), record('human', { authorHuman: true, content: 'Manual input' }), record('declared', { content: '[Message from Agent stranger]\nDeclared input' })]
  const messages = projectSessionUserMessages({ agentSessionId: 'reader', historyPage: page, timeline: { agentSessionId: 'reader', revision: 1, items: captured } })
  expect(messages.map(m => [m.id,m.author.kind])).toEqual([['native:codex:original-native:native-prefix','unknown'],['native:codex:original-native:native-prefix-again','unknown'],['captured:peer','agent'],['captured:human','human'],['captured:declared','unknown']])
  await act(async () => root.render(<ActivityView sessionId="reader" capability="complete-events" displayState="done" userMessages={messages} describeSpeaker={describeSpeaker} items={[record('answer', { kind: 'assistant_message', source: 'native-hook', content: 'Current answer', createdAt: 2000 })]} />))
  const turns = [...host.querySelectorAll<HTMLElement>('.log-turn')]
  expect(turns.map(e=>[e.dataset.messageId,e.dataset.messageDirection])).toEqual([...messages.map(m=>[m.id,'incoming']),['answer','outgoing']])
  const peer = host.querySelector<HTMLElement>('[data-message-id="captured:peer"]')!
  expect(peer.dataset.speakerRelation).toBe('other-agent')
  expect(peer.querySelector('.log-turn__who')?.textContent).toBe('Review Agent')
  expect(peer.querySelector('.log-turn__declared-source')?.textContent).toBe('Message header: Agent reviewer')
  for (const id of [messages[0]!.id, messages[1]!.id, 'captured:declared']) {
    const el = turns.find(e=>e.dataset.messageId===id)!
    expect(el.dataset.speakerRole).toBe('human')
    expect(el.querySelector('.log-turn__sender-kind')?.textContent).toBe('Declared source')
    expect(el.querySelector('.log-turn__text')?.textContent).not.toContain('[Message')
  }
  expect(messages[0]!.author).toEqual({kind:'unknown'})
  expect(host.querySelector('[data-message-id="answer"]')?.getAttribute('data-speaker-relation')).toBeNull()
})

it('uses that same parser in the actual History reader and keeps equal bodies as distinct records', async () => {
  vi.spyOn(api.sessions, 'historyPage').mockResolvedValue(page)
  await act(async () => root.render(<SessionHistoryView control={control} visible label="Implementation" themeId="graphite" fontSize={12} workspaceRoot="/private" openWorkspaceFile={vi.fn()} openHttpLink={vi.fn()} />))
  expect([...host.querySelectorAll<HTMLElement>('[data-history-item-id]')].map(e=>e.dataset.historyItemId)).toEqual(['native-prefix','native-answer','native-prefix-again'])
  for (const id of ['native-prefix','native-prefix-again']) {
    const el = host.querySelector<HTMLElement>(`[data-message-id="${id}"]`)!
    expect(el.dataset.messageDirection).toBe('incoming')
    expect(el.querySelector('.log-turn__who')?.textContent).toBe('Message from Agent reviewer')
    expect(el.querySelector('.log-turn__text')?.textContent).toBe('Keep the original quote\nA second line.')
  }
  expect(host.querySelector('[data-message-id="native-answer"]')?.getAttribute('data-message-direction')).toBe('outgoing')
})

it('keeps trusted Human and Agent names ahead of a conflicting textual declaration', async () => {
  const conflicting = '[Message from Agent stranger]\nConflicting declaration'
  await act(async () => root.render(<>
    <ConversationMessage messageId="trusted-human" conversationSessionId="reader" speaker={{role:'human',id:'human'}} name="You" content={conflicting} />
    <ConversationMessage messageId="trusted-peer" conversationSessionId="reader" speaker={{role:'agent',id:'reviewer'}} name="Review Agent" content={conflicting} />
  </>))
  expect([...host.querySelectorAll<HTMLElement>('.log-turn')].map(e=>[e.dataset.messageId,e.dataset.speakerRole,e.querySelector('.log-turn__who')?.textContent])).toEqual([['trusted-human','human','You'],['trusted-peer','agent','Review Agent']])
  expect([...host.querySelectorAll('.log-turn__declared-source')].map(e=>e.textContent)).toEqual(['Message header: Agent stranger','Message header: Agent stranger'])
  expect(host.querySelectorAll('.log-turn__body')).toHaveLength(2)
})

it('does not interpret a current answer, missing conversation, system context or machine text as a sender', async () => {
  await act(async () => root.render(<>
    <ConversationMessage messageId="answer" conversationSessionId="reader" speaker={{role:'agent',id:'reader'}} content={wire} />
    <ConversationMessage messageId="missing-context" speaker={{role:'agent',id:'reviewer'}} content={wire} />
    <ConversationMessage messageId="system" conversationSessionId="reader" speaker={{role:'system',id:'agentmux'}} content={wire} />
    <ConversationMessage messageId="machine" content={wire} />
    <ConversationMessage messageId="broken" speaker={{role:'unknown',id:'unknown'}} content="[Message from Agent reviewer]" />
  </>))
  expect([...host.querySelectorAll<HTMLElement>('.log-turn')].map(e=>[e.dataset.messageId,e.dataset.declaredSource])).toEqual([['answer',undefined],['missing-context',undefined],['system',undefined],['machine',undefined],['broken',undefined]])
  expect(host.querySelector('[data-message-id="answer"] .log-turn__text')?.textContent).toContain('[Message From Agent reviewer]')
  expect(host.querySelector('[data-message-id="broken"] .log-turn__text')?.textContent).toBe('[Message from Agent reviewer]')
})

it('keeps the raw wire copy, exact selected body node and mixed parts through a normal update', async () => {
  const copy=vi.spyOn(api.ui,'writeClipboardText').mockResolvedValue(undefined), annotate=vi.fn()
  const draw=()=> <ConversationMessage messageId="original" conversationSessionId="reader" speaker={{role:'unknown',id:'unknown'}} content={[{kind:'text',text:wire},{kind:'reasoning',text:'Recorded summary'},{kind:'resource',resourceType:'file',reference:'original.log'}]} onSelectAnnotation={annotate} />
  await act(async()=>root.render(draw()))
  const text=host.querySelector('.log-turn__text strong')!, range=document.createRange();range.selectNodeContents(text);window.getSelection()!.addRange(range)
  await act(async()=>text.dispatchEvent(new MouseEvent('mouseup',{bubbles:true})))
  expect(annotate).toHaveBeenCalledOnce();expect(annotate.mock.calls[0]![0].quote).toBe('Keep the original quote')
  expect([...host.querySelectorAll('.log-turn__body > *')].map(e=>e.className)).toEqual(['log-turn__text','log-turn__trace','log-turn__resource'])
  await act(async()=>root.render(draw()))
  expect(host.querySelector('.log-turn__text strong')).toBe(text);expect(window.getSelection()!.toString()).toBe('Keep the original quote')
  await act(async()=>host.querySelector<HTMLButtonElement>('[title="Copy message"]')!.click())
  expect(copy).toHaveBeenCalledExactlyOnceWith(wire+'\nRecorded summary\noriginal.log')
})
