// @vitest-environment happy-dom
import { act } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createClientUiRoot } from './helpers/client-ui-render'
import { MoteWorkThreads } from '@agentmux/client-ui/components/MoteConversationThreads'
import { MobileMoteConversation } from '../../mobile/src/conversation/MobileMoteConversation'
import { MobileMoteThreads } from '../../mobile/src/navigation/MobileMoteThreads'
import type { MoteDialogueLink, MoteDialoguePage } from '@agentmux/core/mote-dialogue'
import { createMoteApp, moteClick, settleMoteApp, type MoteAppFixture } from './fixtures/mote-app'
import { defaultAgent, defaultTab, neighborAgent, moteTopics, scratchWorkspace } from './fixtures/mote-workface'
import { useAppStore } from '../src/renderer/src/store'
import { api } from '../src/renderer/src/lib/api'
import { requestPmoTeamsTopicFloatingOpen } from '../src/renderer/src/lib/pmo-teams-topic-floating'
import { scratchTopicsScope } from '../src/renderer/src/lib/scratch-topic-snapshots'
import { MoteWorkface } from '../src/renderer/src/components/MoteWorkface'
import { MoteActivityConversation } from '../src/renderer/src/components/MoteActivityConversation'

type Work = Extract<MoteDialogueLink, { kind: 'work' }>
const current = { hostId: 'local', sessionId: defaultAgent.id, displayWorkspaceId: scratchWorkspace.id, groupId: 'mote-group', tabId: defaultTab.id, regionId: defaultTab.layout.activeRegionId }
const identity = { hostId: 'local', moteId: moteTopics[0]!.id }
const target = { spaceId: 'mote-space', zoneId: 'mote-zone', expectedResource: { hostId: 'local', workspaceId: scratchWorkspace.id, workspacePath: scratchWorkspace.path } }
function work(id: string, hostId = 'local'): Work {
  return { kind: 'work', sequence: id === 'login' ? 1 : id === 'cache' ? 2 : 3, identity, operationId: 'link-' + id, associatedAt: 999999,
    eventId: id, mainRoleRevision: 'original-role', main: { hostId, agentSessionId: current.sessionId },
    origin: { hostId, messageId: id, threadId: 'thread-' + id, senderSessionId: current.sessionId, recipientSessionId: neighborAgent.id, createdAt: 2 } }
}
const sources = [work('login'), work('cache'), work('foreign', 'other-host')]
const page = (links = sources): MoteDialoguePage => ({ main: { target, identity, status: 'ready', resource: null, documentRevision: 'original-doc', roleRevision: 'original-role', current, issue: null },
  links: [...links].sort((a, b) => b.sequence - a.sequence), incarnation: 'original-links', throughSequence: 3, next: null, coverage: 'linked-sources-only', sourceStatus: 'read', sourceIssue: null })
function dispatch(source: Work) {
  const title = source.eventId === 'login' ? '登录方案' : source.eventId === 'cache' ? '缓存排查' : '另一个执行端'
  return { hostId: source.origin.hostId, source: { envelope: { ...source.origin, body: title } },
    dispatch: { sourceMessageId: source.origin.messageId, ownerAgentSessionId: source.main.agentSessionId, workerAgentSessionId: source.origin.recipientSessionId, threadId: source.origin.threadId,
      openedAt: 2, originAwaits: true, events: source.eventId === 'foreign' ? [] : [{ kind: source.eventId === 'login' ? 'worker_done' : 'question', replyMessageId: source.eventId + '-reply', at: 3 }] },
    replies: [{ envelope: { messageId: source.eventId + '-reply', threadId: source.origin.threadId, senderSessionId: source.origin.recipientSessionId, recipientSessionId: current.sessionId, body: title + '的**原回复**', createdAt: 3 } }], identityDiagnostics: [] } as any
}
let container: HTMLDivElement, root: ReturnType<typeof createClientUiRoot>, app: MoteAppFixture | undefined
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 390, 50))
  vi.stubGlobal('IntersectionObserver', class { constructor(readonly cb: IntersectionObserverCallback) {} observe(target: Element) { this.cb([{ target, isIntersecting: true } as IntersectionObserverEntry], this as unknown as IntersectionObserver) } disconnect() {} unobserve() {} })
  container = document.createElement('div'); document.body.append(container); root = createClientUiRoot(container)
})
afterEach(async () => { await act(async () => root.unmount()); if (app) { await app.dispose(); app = undefined }; container.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals() })
const click = async (node: HTMLElement) => { await act(async () => node.click()) }
const button = (parent: ParentNode, text: string) => [...parent.querySelectorAll<HTMLButtonElement>('button')].find(node => node.textContent?.trim() === text)!
async function search(parent: ParentNode, value: string) {
  const input = parent.querySelector<HTMLInputElement>('[aria-label="查找工作标题或执行者"]')!
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value); input.dispatchEvent(new Event('input', { bubbles: true })) })
}
const shown = (parent: ParentNode) => [...parent.querySelectorAll<HTMLElement>('.mote-threads__list > li:not([hidden]) [data-mote-work-event]')].map(node => node.dataset.moteWorkEvent)

it('shared Threads searches original titles and executors, filters exact report records and retains expanded DOM without rereads', async () => {
  const read = vi.fn(async (source: Work) => dispatch(source)), open = vi.fn()
  await act(async () => root.render(<MoteWorkThreads page={page()} issue={null} loading={false} visible readWork={read} memberName={() => '资料研究员'} onRefresh={() => {}} onOpenWork={open} />))
  await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(3))
  await click(container.querySelector<HTMLElement>('[data-mote-work-event="login"] .mote-work-event__summary')!)
  const original = container.querySelector('[data-mote-work-event="login"]')
  expect(original?.textContent).toContain('登录方案的原回复')
  expect(original?.querySelector('.mote-work-event__reply strong')?.textContent).toBe('原回复')
  await search(container, '登录'); expect(shown(container)).toEqual(['login'])
  await search(container, '研究员'); expect(shown(container)).toHaveLength(3)
  await search(container, ''); await click(button(container, '含问题')); expect(shown(container)).toEqual(['cache'])
  await click(button(container, '已回报')); expect(shown(container)).toEqual(['login'])
  await click(button(container, '事件历史'))
  expect(container.querySelector('[data-mote-work-event="login"]')).toBe(original)
  expect(original?.getAttribute('data-expanded')).toBe('true'); expect(read).toHaveBeenCalledTimes(3)
  await click(button(original!, '继续原工作')); expect(open).toHaveBeenCalledExactlyOnceWith(sources[0])
  await search(container, '不存在'); expect(shown(container)).toHaveLength(0); expect(container.textContent).toContain('没有匹配的已载入工作')
})

it('actual Mobile Threads adapter uses the same search and report filters with exact public source reads', async () => {
  const rpc = vi.fn(async (_method: string, params: any) => dispatch(sources.find(source => source.origin.hostId === params.hostId && source.origin.messageId === params.sourceMessageId)!))
  const open = vi.fn(), work = vi.fn(), dialogue = { page: page(), issue: null, loading: false, refresh() {}, older: async () => {} } as any
  await act(async () => root.render(<MobileMoteThreads client={{ forwardRpc: rpc } as any} dialogue={dialogue} team={null} issue={null} visible currentSessionId={current.sessionId}
    onOpen={open} onWork={work} onMain={() => {}} onConfigure={() => {}} onRefresh={() => {}} />))
  await vi.waitFor(() => expect(rpc).toHaveBeenCalledTimes(3))
  await search(container, '缓存'); expect(shown(container)).toEqual(['cache'])
  expect(rpc).toHaveBeenCalledWith('message.dispatch.read', { hostId: 'local', sourceMessageId: 'cache' })
  await click(container.querySelector<HTMLElement>('[data-mote-work-event="cache"] .mote-work-event__summary')!)
  await click(button(container.querySelector('[data-mote-work-event="cache"]')!, '继续原工作'))
  expect(work).toHaveBeenCalledExactlyOnceWith(sources[1]); expect(open).not.toHaveBeenCalled()
})

it('actual Mobile Discussion exposes only its original Main Host/SID related work and reads lazily without remounting the current body', async () => {
  const rpc = vi.fn(async (_method: string, params: any) => dispatch(sources.find(source => source.origin.hostId === params.hostId && source.origin.messageId === params.sourceMessageId)!)), show = vi.fn()
  const dialogue = { page: page(), issue: null, older: async () => {} } as any
  await act(async () => root.render(<MobileMoteConversation client={{ forwardRpc: rpc } as any} target={target} dialogue={dialogue} agentSessionId={current.sessionId} hostId={current.hostId} name="搭档" visible
    memberName={() => '研究员'} onShowThreads={show} renderCurrent={() => <textarea data-main-draft defaultValue="原主对话草稿" />} readingGeometry={{ viewport: () => null, following: () => false, pinToBottom() {} }} describeSpeaker={() => ({ name: '搭档' } as any)} />))
  const body = container.querySelector('[data-main-draft]')
  expect(rpc).not.toHaveBeenCalled(); expect(container.querySelector('[data-mote-work-event]')).toBeNull()
  const disclosure = container.querySelector<HTMLDetailsElement>('[data-mote-related-work]')!
  await act(async () => { disclosure.open = true; disclosure.dispatchEvent(new Event('toggle')) })
  await vi.waitFor(() => expect(rpc).toHaveBeenCalledTimes(2))
  expect(container.querySelector('[data-mote-work-event="foreign"]')).toBeNull()
  await click(container.querySelector<HTMLElement>('[data-mote-work-event="login"] .mote-work-event__summary')!)
  expect(container.textContent).toContain('登录方案的原回复'); expect(container.querySelector('[data-main-draft]')).toBe(body)
  await click(button(container, '查看全部 Threads')); expect(show).toHaveBeenCalledTimes(1)
  await act(async () => { disclosure.open = false; disclosure.dispatchEvent(new Event('toggle')) })
  await act(async () => { disclosure.open = true; disclosure.dispatchEvent(new Event('toggle')) })
  expect(rpc).toHaveBeenCalledTimes(2); expect(container.querySelector('[data-main-draft]')).toBe(body)
})

function prepareDesktop() {
  app = createMoteApp()
  const topics = moteTopics.map((topic, i) => i ? topic : { ...topic, quickMode: { status: 'saved' as const, version: 'original-doc', defaults: { conversation: current } } })
  useAppStore.setState({ scratchTopicSnapshots: { [scratchWorkspace.id]: { scope: scratchTopicsScope(scratchWorkspace), topics, revision: 0, error: null, reading: false } } })
  vi.mocked(api.scratch.listTopics).mockResolvedValue(topics); vi.mocked(api.scratch.readTopic).mockImplementation(async (_w, id) => topics.find(topic => topic.id === id) ?? null)
  vi.spyOn(api.moteDialogue, 'read').mockImplementation(async input => ({ ...page(), main: { ...page().main, target: input.target } }))
  vi.spyOn(api.motePreferences, 'read').mockResolvedValue({ status: 'unconfirmed', issue: 'Read-only settings fixture', choices: { executors: [], conversations: [], destinations: [] }, defaults: {}, maintenance: { status: 'unconfirmed', schedule: null, issue: null } } as any)
  vi.spyOn(api.moteDialogue, 'inspectRecovery').mockResolvedValue({ operation: null } as any); vi.spyOn(api.moteDialogue, 'ensureRecovery').mockRejectedValue(Error('Controlled recovery boundary'))
  vi.spyOn(api.files, 'readDirectory').mockResolvedValue([])
  return vi.spyOn(api.sessions, 'dispatch').mockImplementation(async (actor, mid) => dispatch(sources.find(source => source.origin.hostId === actor.hostId && source.origin.messageId === mid)!))
}

it('real Desktop App Threads searches the same original dispatch records and returns to its preserved Main body', async () => {
  const read = prepareDesktop()
  await app!.mount(); await act(async () => requestPmoTeamsTopicFloatingOpen({ targetTopicId: moteTopics[0]!.id })); await settleMoteApp()
  const body = app!.panel().querySelector('[data-activity-session="' + current.sessionId + '"]')
  await moteClick(button(app!.panel(), 'Threads'))
  expect(app!.panel().querySelector('.mote-threads-panel:not([hidden])')).not.toBeNull()
  await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(3))
  await search(app!.panel(), '缓存'); expect(shown(app!.panel())).toEqual(['cache'])
  await moteClick(button(app!.panel(), 'Discussion')); await settleMoteApp()
  expect(app!.panel().querySelector('[data-activity-session="' + current.sessionId + '"]')).toBe(body)
  expect(app!.send).not.toHaveBeenCalled(); expect(app!.launch).not.toHaveBeenCalled(); expect(app!.stop).not.toHaveBeenCalled()
})

it('actual Desktop dialogue consumer embeds the exact Main related work without replacing its current body', async () => {
  const read = prepareDesktop(), reference = { displayWorkspaceId: current.displayWorkspaceId, groupId: current.groupId, tabId: current.tabId, regionId: current.regionId }
  await act(async () => root.render(<MoteWorkface workspaceId={scratchWorkspace.id} topicId={moteTopics[0]!.id} floating visible recoverOnOpen={false} reference={reference}>
    <MoteActivityConversation sessionId={current.sessionId} executionHostId={current.hostId} visible enabled sourceRevision="original-native-revision" records={[]}
      renderCurrent={() => <textarea data-original-main defaultValue="保留原稿" />} />
  </MoteWorkface>))
  await vi.waitFor(() => expect(container.querySelector('[data-mote-related-work]')).not.toBeNull())
  const body = container.querySelector('[data-original-main]'), disclosure = container.querySelector<HTMLDetailsElement>('[data-mote-related-work]')!
  await act(async () => { disclosure.open = true; disclosure.dispatchEvent(new Event('toggle')) })
  await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(2))
  expect(disclosure.querySelector('[data-mote-work-event="foreign"]')).toBeNull()
  await click(disclosure.querySelector<HTMLElement>('[data-mote-work-event="cache"] .mote-work-event__summary')!)
  expect(container.textContent).toContain('缓存排查的原回复'); expect(container.querySelector('[data-original-main]')).toBe(body)
  await click(button(container, '查看全部 Threads'))
  expect(container.querySelector('.mote-threads-panel:not([hidden])')).not.toBeNull()
  expect(container.querySelector('[data-original-main]')).toBe(body)
})

it('repeated dispatch sources preserve both originals without counting the same Host/Agent as two workers', async () => {
  const original = sources[0]!, repeated = { ...original, sequence: 4, operationId: 'repeat-link', origin: { ...original.origin, messageId: 'repeat-source' } }
  const read = vi.fn(async (source: Work) => dispatch(source))
  await act(async () => root.render(<MoteWorkThreads page={{ ...page([repeated, original]), throughSequence: 4 }} issue={null} loading={false} visible readWork={read} memberName={() => '同一研究员'} onRefresh={() => {}} onOpenWork={() => {}} />))
  await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(2))
  const event = container.querySelector<HTMLElement>('[data-mote-work-event="login"]')!
  expect(event.querySelector('.mote-work-event__summary')?.textContent).toContain('同一研究员')
  expect(event.querySelector('.mote-work-event__summary')?.textContent).not.toContain('2 位执行者')
  await click(event.querySelector<HTMLElement>('.mote-work-event__summary')!)
  expect(event.querySelectorAll('.mote-work-event__actions button')).toHaveLength(2)
  expect(event.textContent).toContain('repeat-source')
})

it('active search reads this loaded page only in the foreground and resumes that page when the document returns', async () => {
  const read = vi.fn(async (source: Work) => dispatch(source))
  const render = (value: MoteDialoguePage) => <MoteWorkThreads page={value} issue={null} loading={false} visible readWork={read} memberName={() => '研究员'} onRefresh={() => {}} onOpenWork={() => {}} />
  await act(async () => root.render(render(page())))
  await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(3))
  await search(container, '方案')
  const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden')
  await act(async () => { document.dispatchEvent(new Event('visibilitychange')); root.render(render({ ...page(), throughSequence: 4 })) })
  expect(read).toHaveBeenCalledTimes(3)
  await act(async () => { visibility.mockReturnValue('visible'); document.dispatchEvent(new Event('visibilitychange')) })
  await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(6))
  expect(shown(container)).toEqual(['login'])
})
