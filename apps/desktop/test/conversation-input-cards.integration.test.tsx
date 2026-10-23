import { fixturePath as _hygiene_fixturePath } from "../scripts/lib/fixture-values.mjs"
import { activityReadingProps } from './helpers/activity-reading-props'
import { conversationPagePortFixture } from './helpers/conversation-page-port-fixture'
import { inspectConversationConsumers } from '../src/renderer/src/lib/conversation-consumer-observation'
// @vitest-environment happy-dom
import { act } from 'react'
import { type Root } from 'react-dom/client'
import { createClientUiRoot as createRoot } from './helpers/client-ui-render'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { AgentSessionHistoryPage, AgentTimelineItem } from '@agentmux/core'
import { parseAgentMuxMessagePrefix, renderAgentMuxMessageEnvelope } from '@agentmux/core/agent-message-render'
import { projectSessionUserMessages } from '@agentmux/core/session-user-messages'
import { ActivityView } from '../src/renderer/src/components/ActivityView'
import { ConversationMessage } from '@agentmux/client-ui/components/ConversationMessage'

import { createSpeakerResolver } from '@agentmux/client-ui/conversation-speaker'
import { api } from '../src/renderer/src/lib/api'
import type { AgentSessionControl } from '../src/shared/contracts'
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
const envelope = (senderSessionId: string, body: string) => renderAgentMuxMessageEnvelope({ messageId: 'original-input-message',
  sender: { kind: 'agent-session', agentSessionId: senderSessionId }, senderSessionId, body })
const body = '**Keep the original quote**\nA second line.\n'
const wire = envelope('reviewer', body)
const record = (id: string, extra: Partial<AgentTimelineItem> = {}): AgentTimelineItem => ({ id, agentSessionId: 'reader', kind: 'user_message', source: 'user', status: 'complete', createdAt: 1_000, updatedAt: 1_000, title: 'Input', content: wire, ...extra })
const control: AgentSessionControl = { kind: 'agent', hostId: 'local', agentSessionId: 'reader', run: { runId: 'original-run' } }
const describeSpeaker = createSpeakerResolver({ currentSession: { id: 'reader', label: 'Implementation', providerId: 'codex' }, lookupAgent: id => id === 'reviewer' ? { label: 'Review Agent', providerId: 'claude' } : undefined })
const page: AgentSessionHistoryPage = { agentSessionId: 'reader', source: { providerId: 'codex', nativeSessionId: 'original-native' }, items: [
  { id: 'native-prefix', kind: 'user-message', contentParts: [{ kind: 'text', text: wire }] },
  { id: 'native-answer', kind: 'assistant-message', contentParts: [{ kind: 'text', text: 'Current answer' }] },
  { id: 'native-prefix-again', kind: 'user-message', contentParts: [{ kind: 'text', text: wire }] }
], nextCursor: null }
async function showReading(items: readonly AgentTimelineItem[] = [], nativePage: AgentSessionHistoryPage = page) {
  source = await conversationPagePortFixture(control, nativePage.source, async agentSessionId => {
    expect(agentSessionId).toBe(control.agentSessionId); return nativePage
  })
  const stream = items.length ? await source.publishCaptured(items) : null
  await act(async () => root.render(<ActivityView {...activityReadingProps({ control, visible: true, label: 'Implementation', describeSpeaker,
    workspaceRoot: _hygiene_fixturePath('private'), openWorkspaceFile: vi.fn(), openHttpLink: vi.fn() })} />))
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

it('recognizes only a complete leading reading wrapper and never authenticates it', () => {
  expect(parseAgentMuxMessagePrefix(wire)).toMatchObject({ kind: 'content', sourceLabel: 'Agent reviewer', declaredAgentSessionId: 'reviewer',
    declaredMessageId: 'original-input-message', body })
  expect(parseAgentMuxMessagePrefix('[MESSAGE FROM unverified local process]\r\nraw <body>')).toBeNull()
  expect(parseAgentMuxMessagePrefix('[Message from a named colleague]\ntext')).toBeNull()
  const rejected = ['[Message from Agent reviewer]', '[Message from Agent reviewer]\n   ', '[Message from ]\ntext', '> '+wire, '```\n'+wire+'```', 'Introduction\n'+wire, '<amux:a2a from="reviewer" msg-id="incomplete">\ntext']
  expect(rejected).toHaveLength(7)
  for (const text of rejected) expect(parseAgentMuxMessagePrefix(text)).toBeNull()
})

it('routes actual Activity native and captured inputs right while preserving trusted speaker facts', async () => {
  const captured = [record('peer', { authorAgentSessionId: 'reviewer' }), record('human', { authorHuman: true, content: 'Manual input' }), record('declared', { content: envelope('stranger', 'Declared input') })]
  const messages = projectSessionUserMessages({ agentSessionId: 'reader', historyPage: page, timeline: { agentSessionId: 'reader', revision: 1, items: captured } })
  expect(messages.map(m => [m.id,m.author.kind])).toEqual([['native:codex:original-native:native-prefix','unknown'],['native:codex:original-native:native-prefix-again','unknown'],['captured:peer','agent'],['captured:human','human'],['captured:declared','unknown']])
  await showReading(captured)
  const turns = [...host.querySelectorAll<HTMLElement>('.log-turn')]
  const answer = host.querySelector<HTMLElement>('[data-native-record-id="native-answer"] .log-turn')
  expect(answer).not.toBeNull(); expect(answer!.dataset.messageId).toBeTruthy()
  expect(turns.map(e=>[e.dataset.messageId,e.dataset.messageDirection]).sort()).toEqual([
    [messages[0]!.id, 'incoming'], [answer!.dataset.messageId, 'outgoing'], [messages[1]!.id, 'incoming'],
    ['captured:peer', 'incoming'], ['captured:human', 'incoming'], ['captured:declared', 'incoming']
  ].sort())
  const peer = host.querySelector<HTMLElement>('[data-message-id="captured:peer"]')!
  expect(peer.dataset.speakerRelation).toBe('other-agent')
  expect(peer.querySelector('.log-turn__who')?.textContent).toBe('Review Agent')
  expect(peer.querySelector('.log-turn__declared-source')?.textContent).toBe('Message header: Agent reviewer')
  for (const id of [messages[0]!.id, messages[1]!.id, 'captured:declared']) {
    const el = turns.find(e=>e.dataset.messageId===id)!
    expect(el.dataset.speakerRole).toBe('human')
    expect(el.querySelector('.log-turn__sender-kind')?.textContent).toBe('Declared source')
    expect(el.querySelector('.conversation-avatar--agent')).not.toBeNull()
    const prose = el.querySelector('.log-turn__text [data-markdown-root]')
    expect(prose).not.toBeNull(); expect(prose!.textContent).not.toContain('<amux:a2a')
  }
  expect(messages[0]!.author).toEqual({kind:'unknown'})
  expect(answer!.getAttribute('data-speaker-relation')).toBeNull()
  expect((await source!.client.sessionTimeline('reader')).items).toEqual(captured)
})

it('uses that same parser in the actual History reader and keeps equal bodies as distinct records', async () => {
  await showReading()
  expect([...host.querySelectorAll<HTMLElement>('.activity-feed [data-native-record-id]')].map(e=>e.dataset.nativeRecordId)).toEqual(['native-prefix','native-answer','native-prefix-again'])
  for (const id of ['native-prefix','native-prefix-again']) {
    const el = host.querySelector<HTMLElement>(`[data-native-record-id="${id}"] .log-turn`)!
    expect(el).not.toBeNull()
    expect(el.dataset.messageDirection).toBe('incoming')
    expect(el.querySelector('.log-turn__who')?.textContent).toBe('Review Agent')
    expect(el.querySelector('.log-turn__sender-id code')?.textContent).toBe('reviewer')
    expect(el.querySelector('.log-turn__sender-kind')?.textContent).toBe('Declared source')
    expect(el.querySelector('.log-turn__text [data-markdown-root]')?.textContent).toBe('Keep the original quote\nA second line.')
    expect(el.querySelector('.conversation-protocol__original pre')?.textContent).toBe(wire)
  }
  const answer = host.querySelector('[data-native-record-id="native-answer"] .log-turn')
  expect(answer).not.toBeNull(); expect(answer!.getAttribute('data-message-direction')).toBe('outgoing')
})

it('keeps trusted Human and Agent names ahead of a conflicting textual declaration', async () => {
  const conflicting = envelope('stranger', 'Conflicting declaration')
  await act(async () => root.render(<>
    <ConversationMessage messageId="trusted-human" conversationSessionId="reader" speaker={{role:'human',id:'human'}} name="You" content={conflicting} />
    <ConversationMessage messageId="trusted-peer" conversationSessionId="reader" speaker={{role:'agent',id:'reviewer'}} name="Review Agent" content={conflicting} />
  </>))
  expect([...host.querySelectorAll<HTMLElement>('.log-turn')].map(e=>[e.dataset.messageId,e.dataset.speakerRole,e.querySelector('.log-turn__who')?.textContent])).toEqual([['trusted-human','human','You'],['trusted-peer','agent','Review Agent']])
  expect([...host.querySelectorAll('.log-turn__declared-source')].map(e=>e.textContent)).toEqual(['Message header: Agent stranger','Message header: Agent stranger'])
  expect(host.querySelectorAll('.log-turn__body')).toHaveLength(2)
})

it('does not authenticate a declaration as the sender of an answer, missing conversation, system context or machine record', async () => {
  const legacy = '[Message From Agent reviewer]\nThe retired header remains literal.'
  const copy = vi.spyOn(api.ui, 'writeClipboardText').mockResolvedValue(undefined)
  await act(async () => root.render(<>
    <ConversationMessage messageId="answer" conversationSessionId="reader" speaker={{role:'agent',id:'reader'}} content={wire} />
    <ConversationMessage messageId="missing-context" speaker={{role:'agent',id:'reviewer'}} content={wire} />
    <ConversationMessage messageId="system" conversationSessionId="reader" speaker={{role:'system',id:'agentmux'}} content={wire} />
    <ConversationMessage messageId="machine" content={wire} />
    <ConversationMessage messageId="broken" speaker={{role:'unknown',id:'unknown'}} content="[Message from Agent reviewer]" />
    <ConversationMessage messageId="legacy" conversationSessionId="reader" speaker={{role:'unknown',id:'unknown'}} content={legacy} />
  </>))
  expect([...host.querySelectorAll<HTMLElement>('.log-turn')].map(e=>[e.dataset.messageId,e.dataset.declaredSource])).toEqual([['answer','Agent reviewer'],['missing-context','Agent reviewer'],['system','Agent reviewer'],['machine','Agent reviewer'],['broken',undefined],['legacy',undefined]])
  expect([...host.querySelectorAll<HTMLElement>('.log-turn')].map(e=>[e.dataset.messageId,e.dataset.speakerRole,e.dataset.speakerRelation])).toEqual([
    ['answer','agent',undefined],['missing-context','agent',undefined],['system','system',undefined],['machine',undefined,undefined],['broken','human',undefined],['legacy','human',undefined]
  ])
  expect(host.querySelector('[data-message-id="answer"] .log-turn__sender-id code')?.textContent).toBe('reader')
  expect(host.querySelector('[data-message-id="broken"] .log-turn__text')?.textContent).toBe('[Message from Agent reviewer]')
  expect(host.querySelector('[data-message-id="legacy"] .log-turn__text')?.textContent).toContain('[Message From Agent reviewer]')
  await act(async () => host.querySelector<HTMLButtonElement>('[data-message-id="answer"] [title="Copy message"]')!.click())
  expect(copy).toHaveBeenLastCalledWith(wire)
  await act(async () => host.querySelector<HTMLButtonElement>('[data-message-id="legacy"] [title="Copy message"]')!.click())
  expect(copy).toHaveBeenCalledTimes(2); expect(copy).toHaveBeenLastCalledWith(legacy)
})

it('keeps the raw wire copy, exact selected body node and mixed parts through a normal update', async () => {
  const copy=vi.spyOn(api.ui,'writeClipboardText').mockResolvedValue(undefined), annotate=vi.fn()
  const draw=()=> <ConversationMessage messageId="original" conversationSessionId="reader" speaker={{role:'unknown',id:'unknown'}} content={[{kind:'text',text:wire},{kind:'reasoning',text:'Recorded summary'},{kind:'resource',resourceType:'file',reference:'original.log'}]} onSelectAnnotation={annotate} />
  await act(async()=>root.render(draw()))
  const text=host.querySelector('.log-turn__text strong')!, range=document.createRange();range.selectNodeContents(text);window.getSelection()!.addRange(range)
  await act(async()=>text.dispatchEvent(new MouseEvent('mouseup',{bubbles:true})))
  expect(annotate).toHaveBeenCalledOnce();expect(annotate.mock.calls[0]![0].quote).toBe('Keep the original quote')
  expect([...host.querySelectorAll('.log-turn__body > *')].map(element => element.matches('.log-turn__text') ? 'text'
    : element.matches('.log-turn__trace[data-trace-kind="reasoning"]') ? 'reasoning'
    : element.matches('.conversation-resource-file') ? 'resource' : 'unexpected')).toEqual(['text','reasoning','resource'])
  const resource = host.querySelector('.conversation-resource-file')!
  expect(resource).not.toBeNull(); expect(resource.querySelector('summary')?.textContent).toBe('Reference')
  await act(async () => { const details = resource.querySelector('details')!; details.open = true; details.dispatchEvent(new Event('toggle')) })
  await act(async () => resource.querySelector<HTMLButtonElement>('[aria-label="Copy file reference"]')!.click())
  expect(copy).toHaveBeenCalledExactlyOnceWith('original.log')
  await act(async()=>root.render(draw()))
  expect(host.querySelector('.log-turn__text strong')).toBe(text);expect(window.getSelection()!.toString()).toBe('Keep the original quote')
  await act(async()=>host.querySelector<HTMLButtonElement>('[title="Copy message"]')!.click())
  expect(copy).toHaveBeenCalledTimes(2); expect(copy).toHaveBeenLastCalledWith(wire+'\nRecorded summary\noriginal.log')
})
