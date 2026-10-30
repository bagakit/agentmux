// @vitest-environment happy-dom
import { act } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createClientUiRoot } from './helpers/client-ui-render'
import { MoteConversationThreads, MoteWorkThreads } from '@agentmux/client-ui/components/MoteConversationThreads'
import type { MoteDialoguePage, MoteDialogueLink } from '@agentmux/core/mote-dialogue'
const target = { spaceId: 'original-mote', zoneId: 'original-zone', expectedResource: { hostId: 'resource-host', workspaceId: 'original-workspace', workspacePath: '/original-mote' } }
const current = { hostId: 'execution-host', sessionId: 'main-agent', displayWorkspaceId: 'display', groupId: 'group', tabId: 'tab', regionId: 'region' }
const identity = { hostId: 'resource-host', moteId: 'original-mote' }
const work = (hostId: string, recipient: string, sequence: number): Extract<MoteDialogueLink, {kind: 'work'}> => ({ kind: 'work', sequence, identity, operationId: 'link-' + sequence, associatedAt: 9,
  eventId: 'original-event', mainRoleRevision: 'original-role', main: { hostId, agentSessionId: current.sessionId },
  origin: { hostId, messageId: 'same-wire-id', threadId: 'thread-' + sequence, senderSessionId: current.sessionId, recipientSessionId: recipient, createdAt: 2 } })
const first = work('host-one', 'worker-one', 1), second = work('host-two', 'worker-two', 2)
const page: MoteDialoguePage = { main: { target, identity, status: 'ready', resource: null, documentRevision: 'original-document', roleRevision: 'original-role', current, issue: null },
  links: [first, second], incarnation: 'original-links', throughSequence: 2, next: null, coverage: 'linked-sources-only', sourceStatus: 'read', sourceIssue: null }
let container: HTMLDivElement, root: ReturnType<typeof createClientUiRoot>
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 300, 50))
  vi.stubGlobal('IntersectionObserver', class { constructor(readonly cb: IntersectionObserverCallback) {} observe(target: Element) { this.cb([{ target, isIntersecting: true } as IntersectionObserverEntry], this as unknown as IntersectionObserver) } disconnect() {} unobserve() {} })
  container = document.createElement('div'); document.body.append(container); root = createClientUiRoot(container)
})
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals() })
const dispatch = async (source: typeof first) => ({ hostId: source.origin.hostId,
  source: { envelope: { ...source.origin, body: '原任务 ' + source.origin.recipientSessionId } },
  dispatch: { sourceMessageId: source.origin.messageId, ownerAgentSessionId: current.sessionId, workerAgentSessionId: source.origin.recipientSessionId, threadId: source.origin.threadId, openedAt: 2, originAwaits: true, events: [] },
  replies: [{ envelope: { messageId: source.origin.hostId + '-reply', threadId: source.origin.threadId, senderSessionId: source.origin.recipientSessionId, recipientSessionId: current.sessionId, body: source.origin.hostId + ' 的原回复', createdAt: 3 } }], identityDiagnostics: [] }) as any
it('Discussion renders the original Main body without worker events or a second view switch', async () => {
  const read = vi.fn(dispatch), render = vi.fn(() => <div data-original-main>主对话原正文</div>)
  await act(async () => root.render(<MoteConversationThreads page={page} issue={null} actor={{ hostId: current.hostId, agentSessionId: current.sessionId }} name="Mote" visible conversationClient={null} renderCurrent={render} />))
  expect(container.querySelector('[data-original-main]')?.textContent).toBe('主对话原正文')
  expect(container.querySelector('[data-mote-work-event]')).toBeNull()
  expect(container.querySelector('nav')).toBeNull(); expect(render.mock.lastCall).toEqual([[]]); expect(read).not.toHaveBeenCalled()
})
it('Threads preserves source pairs with equal wire IDs on different Hosts and one event identity in history', async () => {
  const read = vi.fn(dispatch), open = vi.fn(), memberName = (source: typeof first) => source.origin.recipientSessionId === 'worker-one' ? '成员甲' : '成员乙'
  await act(async () => root.render(<MoteWorkThreads page={page} issue={null} loading={false} visible readWork={read} memberName={memberName} onRefresh={() => {}} onOpenWork={open} />))
  await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(2))
  await act(async () => container.querySelector<HTMLButtonElement>('.mote-work-event__summary')!.click())
  await vi.waitFor(() => expect(container.querySelectorAll('.mote-work-event__reply')).toHaveLength(2))
  const replies = [...container.querySelectorAll('.mote-work-event__reply')].map(node => node.textContent)
  expect(replies[0]).toContain('成员甲'); expect(replies[0]).toContain('host-one 的原回复')
  expect(replies[1]).toContain('成员乙'); expect(replies[1]).toContain('host-two 的原回复')
  const actions = container.querySelectorAll<HTMLButtonElement>('.mote-work-event__actions button')
  await act(async () => actions[1]!.click()); expect(open).toHaveBeenCalledExactlyOnceWith(second)
  await act(async () => [...container.querySelectorAll<HTMLButtonElement>('nav button')].find(button => button.textContent === '事件历史')!.click())
  expect(container.querySelectorAll('[data-mote-work-event]')).toHaveLength(1)
  expect(container.querySelector('[data-mote-work-event]')?.getAttribute('data-mote-work-event')).toBe(first.eventId)
})

it('Discussion keeps its own original source pagination discoverable without visiting Threads', async () => {
 const older = vi.fn()
 await act(async () => root.render(<MoteConversationThreads page={{ ...page, next: 'original-opaque-cursor' as any }} issue={null} actor={{ hostId: current.hostId, agentSessionId: current.sessionId }} name="Mote" visible conversationClient={null} onOlder={older} renderCurrent={() => <p>当前主对话</p>} />))
 const next = [...container.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === '更早的主对话来源')!
 expect(next).toBeDefined(); await act(async () => next.click()); expect(older).toHaveBeenCalledTimes(1)
})
