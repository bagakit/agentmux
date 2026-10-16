// @vitest-environment happy-dom
import { act } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { appendFile } from 'node:fs/promises'
import type { AgentTimelineItem } from '@agentmux/core'
import { fixtureEpoch } from '../../../test/fixture-values.mjs'
import { nativeHistoryFixture, jsonl } from '../../../packages/core/test/fixtures/native-history-session'
import { consumeConversationWindowPage, projectConversationWindow } from '@agentmux/core/conversation'
import { desktopConversationReadBridge } from './helpers/conversation-read-bridge'
import { createClientUiRoot } from './helpers/client-ui-render'
import { createAgentInformationRoot } from './helpers/agent-information-root'
import { composerConfig, composerSession } from './helpers/composer-dom-fixture'
import { AgentInputRecap } from '../src/renderer/src/components/AgentInputRecap'
import { api } from '../src/renderer/src/lib/api'
import { useAppStore } from '../src/renderer/src/store'
import { agentContextForSession } from '../src/renderer/src/lib/focus-context'
import { WorkspaceAgentRow } from '../src/renderer/src/components/WorkspaceAgentRow'
import { agentInformationPreview, type AgentInformationPreview } from '../src/renderer/src/lib/agent-information-preview'
import { useSessionUserMessages } from '../src/renderer/src/lib/session-user-messages'

type Fixture = Awaited<ReturnType<typeof nativeHistoryFixture>>
const closes: Array<() => unknown | Promise<unknown>> = []
const intersections = new Set<{ targets: Set<Element>; callback: IntersectionObserverCallback }>()
let originalStore: ReturnType<typeof useAppStore.getState>
const prose = 'Keep **selected request** and its original records.'
const native = (id: string, text = prose, image = false) => ({ type: 'user', uuid: id, sessionId: 'native-main',
 timestamp: new Date(fixtureEpoch(0, 2, 1)).toISOString(), message: { role: 'user', content: image ? [
  { type: 'text', text }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: png } }
 ] : text } })
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII='
const wait = (check: () => void) => vi.waitFor(async () => { await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)) }); check() }, { timeout: 6000, interval: 20 })
beforeEach(() => {
 originalStore = useAppStore.getState()
 vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
 vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
 intersections.clear()
 vi.stubGlobal('IntersectionObserver', class {
  targets = new Set<Element>()
  constructor(public callback: IntersectionObserverCallback) { intersections.add(this) }
  observe(target: Element) { this.targets.add(target) }
  unobserve(target: Element) { this.targets.delete(target) }
  disconnect() { intersections.delete(this) }
 })
 Element.prototype.scrollIntoView = vi.fn()
})
afterEach(async () => {
 window.getSelection()?.removeAllRanges(); agentInformationPreview.detach()
 for (const close of closes.splice(0).reverse()) await close()
 useAppStore.setState(originalStore, true); vi.restoreAllMocks(); vi.unstubAllGlobals()
})
async function seed(rows: object[] = [], linked = false) {
 const f = await nativeHistoryFixture('claude', jsonl(rows)); closes.push(f.close)
 const item: AgentTimelineItem = { id: 'submission-original', agentSessionId: f.session.agentSessionId, kind: 'user_message', source: 'user', status: 'complete', title: 'Original submission', content: prose,
  createdAt: fixtureEpoch(0, 0, 1), updatedAt: fixtureEpoch(0, 0, 1), authorHuman: true,
  ...(linked ? { conversation: { sameEvent: target(f) } } : {}) }
 await persist(f, item)
 const bridge = await desktopConversationReadBridge(f, closes)
 const session = { ...composerSession(f.session.agentSessionId, 'claude'), control: { kind: 'agent' as const, hostId: 'local', agentSessionId: f.session.agentSessionId, run: f.session.run }, nativeHandle: { kind: 'provider' as const, providerId: 'claude', sessionId: 'native-main' } }
 useAppStore.setState({ config: composerConfig, sessions: [session], timelines: {}, demands: {}, agentNames: {}, agentComposerDrafts: { [session.id]: 'Keep this unsent draft' } })
 return { f, bridge, item, session }
}
const target = (f: Fixture) => ({ hostId: 'local', agentSessionId: f.session.agentSessionId, source: { kind: 'native' as const, providerId: 'claude', nativeSessionId: 'native-main', recordId: 'native-original' } })
async function persist(f: Fixture, item: AgentTimelineItem, type: 'append' | 'upsert' = 'append') {
 await Reflect.get(f.client, 'persistAndPublishTimeline').call(f.client, { type, agentSessionId: f.session.agentSessionId, item }, { source: 'agentmux', observedAt: fixtureEpoch(0, 0, 1) }, 'local')
}
function mount(information = false) {
 const host = document.createElement('div'); document.body.append(host)
 const root = information ? createAgentInformationRoot(host) : createClientUiRoot(host)
 closes.push(async () => { await act(async () => root.unmount()); host.remove() })
 return { host, root }
}
const rows = (host: ParentNode) => [...host.querySelectorAll<HTMLElement>('[data-hover-input-id]')]
async function opened(scene: Awaited<ReturnType<typeof seed>>) {
 const { host, root } = mount(true), context = agentContextForSession(scene.session, undefined, 'Original Agent', composerConfig.workspaces[0]!, null)
 const onOpen = vi.fn()
 await act(async () => root.render(<WorkspaceAgentRow context={context} selected={false} selecting={false} disabled={false} onToggle={() => {}} onOpen={onOpen} />))
 const trigger = host.querySelector<HTMLButtonElement>('.focus-context')!
 await act(async () => trigger.dispatchEvent(new PointerEvent('pointerover', { bubbles: true })))
 await wait(() => expect(document.querySelector('.agent-information-reader')).not.toBeNull())
 const panel = document.querySelector<HTMLElement>('.agent-information-reader')!
 expect(onOpen).not.toHaveBeenCalled()
 return { host, root, trigger, panel, onOpen }
}

it('the real Agent hover consumes one entity while both exact original records and native resource references remain available', async () => {
 const scene = await seed([native('native-original', prose, true)], true), { panel, onOpen } = await opened(scene)
 await wait(() => expect(rows(panel)).toHaveLength(1))
 let reading!: ReturnType<typeof useSessionUserMessages>
 function Probe() { reading = useSessionUserMessages(scene.session.control); return null }
 const probe = mount(); await act(async () => probe.root.render(<Probe />))
 await wait(() => { expect(reading.loading).toBe(false); expect(reading.messages).toHaveLength(1) })
 const entity = reading.messages[0] as typeof reading.messages[number] & { event: { id: string }; records: Array<{ original: { item: { id: string } } }> }
 expect(entity.event, 'The shared reader must retain the authoritative message entity').toBeDefined()
 expect(entity.id).toBe(reading.conversation.reading!.records[0]!.id)
 expect(entity.records.map(record => record.original.item.id).sort()).toEqual(['native-original', 'submission-original'])
 expect(entity.source).toEqual({ kind: 'native', providerId: 'claude', nativeSessionId: 'native-main', recordId: 'native-original' })
 expect(entity.contentParts.some(part => part.kind === 'resource' && part.resourceType === 'image')).toBe(true)
 const resource = entity.contentParts.find(part => part.kind === 'resource' && part.resourceType === 'image')!
 const resourceRead = vi.spyOn(api.sessions, 'historyResource').mockImplementation((subject, input) => {
  expect(subject).toEqual({ hostId: 'local', agentSessionId: scene.session.id })
  return scene.f.client.sessionHistoryResource(subject.agentSessionId, input)
 })
 await act(async () => { for (const observer of [...intersections]) observer.callback([...observer.targets].map(target => ({ target, isIntersecting: true }) as IntersectionObserverEntry), {} as IntersectionObserver) })
 await wait(() => expect(resourceRead.mock.calls.length).toBeGreaterThan(0))
 expect(resourceRead.mock.calls.every(([, input]) => input.recordId === 'native-original' && input.source.providerId === 'claude' && input.source.nativeSessionId === 'native-main' && input.expectedReference === (resource as { reference: string }).reference)).toBe(true)
 expect(rows(panel)[0]!.textContent).toContain('selected request')
 expect(onOpen).not.toHaveBeenCalled(); expect(useAppStore.getState().agentComposerDrafts[scene.session.id]).toBe('Keep this unsent draft')
 expect(scene.f.controls.map(spy => spy.mock.calls.length)).toEqual([0, 0, 0, 0, 0, 0])
})

it.each([true, false])('a frozen recap keeps exact coalescence=%s distinct from an independent in-flight native input', async linked => {
 const scene = await seed(), { host, root } = mount()
 const request = { token: {}, id: 'private-input-preview', control: scene.session.control, anchor: document.createElement('button'), pinned: false, sourceKey: 'original-source' } as AgentInformationPreview
 const render = (pinned = false, enabled = true) => act(async () => root.render(<AgentInputRecap request={{ ...request, pinned }} enabled={enabled} available />))
 await render(); await wait(() => expect(rows(host)).toHaveLength(1))
 await wait(() => expect(vi.mocked(api.conversation.readConversationChanges).mock.calls.length).toBeGreaterThan(0))
 let release: (() => void) | undefined, entered!: () => void, page: any
 const entry = new Promise<void>(resolve => { entered = resolve })
 vi.mocked(api.conversation.readConversationChanges).mockImplementation(async (input, options) => {
  const result = await scene.bridge.readConversationChanges(input, options)
  if (!release && result.items.some(unit => unit.kind === 'item' && unit.item.records.some(record => record.original.item.id === 'native-original'))) {
   page = result; entered(); await new Promise<void>(resolve => { release = resolve })
  }
  return result
 })
 closes.push(() => release?.())
 await appendFile(scene.f.path, jsonl([native('native-original')]))
 await persist(scene.f, { ...scene.item, updatedAt: fixtureEpoch(0, 2, 2), ...(linked ? { conversation: { sameEvent: target(scene.f) } } : {}) }, 'upsert')
 await entry; await render(true)
 const old = rows(host)[0]!, range = document.createRange(); range.selectNodeContents(old.querySelector('p')!); window.getSelection()!.addRange(range)
 const selected = window.getSelection()!.toString()
 const releasedBefore = vi.mocked(api.conversation.releaseConversationView).mock.calls.length
 await act(async () => release!())
 await wait(() => expect(vi.mocked(api.conversation.releaseConversationView).mock.calls.slice(releasedBefore)
  .some(([input]) => input.agentSessionId === scene.session.id && input.view === page.window.view), 'Wait for this completed frame to be retained and then parked by the frozen recap').toBe(true))
 expect(rows(host), 'Only an exact contributor is already represented; an independent input fills a spare slot').toHaveLength(linked ? 1 : 2)
 expect(rows(host)[0]).toBe(old); expect(window.getSelection()!.getRangeAt(0)).toBe(range); expect(window.getSelection()!.toString()).toBe(selected)
 const accepted = consumeConversationWindowPage(page); expect(accepted.kind).toBe('complete')
 if (accepted.kind !== 'complete') throw Error('Expected complete private Core frame')
 const projection = projectConversationWindow(accepted.snapshot)
 expect(projection.records).toHaveLength(linked ? 1 : 2)
 if (linked) expect(projection.records[0]!.records).toHaveLength(2)
 const reads = vi.mocked(api.conversation.readAgentConversation).mock.calls.length, changes = vi.mocked(api.conversation.readConversationChanges).mock.calls.length
 await render(true, false); await appendFile(scene.f.path, jsonl([native('hidden-independent', 'Hidden native input')]))
 await act(async () => { await new Promise(resolve => setTimeout(resolve, 180)) })
 expect(api.conversation.readAgentConversation).toHaveBeenCalledTimes(reads); expect(api.conversation.readConversationChanges).toHaveBeenCalledTimes(changes)
 expect(rows(host)[0]).toBe(old); expect(scene.f.controls.map(spy => spy.mock.calls.length)).toEqual([0, 0, 0, 0, 0, 0])
})

it('the real bookmark Pin keeps one confirmed entity and its expanded original Range through later source activity', async () => {
 const scene = await seed([native('native-original')], true), { panel, onOpen } = await opened(scene)
 await wait(() => expect(rows(panel)).toHaveLength(1))
 await act(async () => panel.querySelector<HTMLButtonElement>('.agent-information-reader__pin')!.click())
 expect(agentInformationPreview.get()?.bookmark).toBeDefined()
 const entry = rows(panel)[0]!.querySelector<HTMLElement>('[role="button"]')!
 await act(async () => entry.click())
 await wait(() => expect(panel.querySelector('.agent-input-recall__original-body strong')).not.toBeNull())
 const selectedNode = panel.querySelector('.agent-input-recall__original-body strong')!, range = document.createRange(); range.selectNodeContents(selectedNode); window.getSelection()!.addRange(range)
 await appendFile(scene.f.path, jsonl([native('independent-later', 'Independent later input')]))
 await act(async () => { await new Promise(resolve => setTimeout(resolve, 180)) })
 expect(panel.querySelector('.agent-input-recall__original-body strong')).toBe(selectedNode); expect(window.getSelection()!.getRangeAt(0)).toBe(range); expect(window.getSelection()!.toString()).toBe('selected request')
 expect(rows(panel).filter(row => row.textContent?.includes('selected request'))).toHaveLength(1)
 expect(onOpen).not.toHaveBeenCalled(); expect(useAppStore.getState().agentComposerDrafts[scene.session.id]).toBe('Keep this unsent draft')
})

it('the real hover keeps same-text inputs separate when Core has no exact relation', async () => {
 const scene = await seed([native('native-original')]), { panel } = await opened(scene)
 await wait(() => expect(rows(panel)).toHaveLength(2))
 expect(rows(panel).every(row => row.textContent?.includes('selected request'))).toBe(true)
 expect(new Set(rows(panel).map(row => row.dataset.hoverInputId)).size).toBe(2)
})
