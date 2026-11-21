import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { MoteGroupConversation, type MoteGroupCall } from '../../../packages/client-ui/src/components/MoteGroupConversation'
import { MoteGroupDetails } from '../../../packages/client-ui/src/components/MoteGroupSettings'
import { MoteDirectThreads, type ReadMoteConversationWork } from '../../../packages/client-ui/src/components/MoteDirectThreads'
import type { MoteGroupMessage, MoteGroupSummary } from '@agentmux/core/mote/group'
import { ipcResult, unwrapIpcResult } from '../src/shared/ipc-result'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
const group: MoteGroupSummary = { id: 'room', name: 'Readable original group', lastMessage: null, revision: 1,
  avatarMoteIds: [], announcement: null, topic: null, members: [{ moteId: 'member', name: 'Original member', state: 'active', role: 'member', thread: null,
    target: { spaceId: 'member', zoneId: 'original-zone', expectedResource: { hostId: 'local', workspaceId: 'scratch', workspacePath: '/scratch' } } }] }

const disposals: Array<() => Promise<void>> = []
function mount() {
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  disposals.push(async () => { await act(async () => root.unmount()); container.remove() })
  return { root, container, button: (name: string) => [...container.querySelectorAll('button')].find(button => button.textContent === name) }
}
afterEach(async () => {
  for (const dispose of disposals.splice(0)) await dispose()
  vi.useRealTimers()
})

it('selects an exact active recipient from a typed group mention', async () => {
  const { root, container, button } = mount()
  const removed = { ...group.members[0]!, moteId: 'removed', name: 'Original departed', state: 'removed' as const }
  const room = { ...group, members: [...group.members, removed] }
  const rpc = vi.fn(async (method: string, params: { body?: string }) => method === 'space.mote.group.send'
    ? { message: { id: 'sent', groupId: room.id, sequence: 1, createdAt: 1, body: params.body,
      author: { kind: 'human', id: 'user' }, deliveries: [] } }
    : { group: room, viewerId: 'user', messages: [], nextBeforeSequence: null })
  await act(async () => root.render(<MoteGroupConversation call={rpc as MoteGroupCall} groupId={room.id}
    candidates={[]} onOpen={() => {}} onClose={() => {}} />))
  const textarea = container.querySelector<HTMLTextAreaElement>('textarea[aria-label="群消息"]')!
  await act(async () => {
    textarea.focus()
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(textarea, '请 @Original')
    textarea.setSelectionRange(textarea.value.length, textarea.value.length)
    textarea.dispatchEvent(new Event('input', { bubbles: true }))
  })
  const menu = container.querySelector('[aria-label="点名成员"]')!
  expect(menu.textContent).toBe('Original member')
  await act(async () => textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })))
  expect(document.activeElement).toBe(menu.querySelector('button'))
  await act(async () => menu.querySelector('button')!.click())
  expect(textarea.value).toBe('请 @Original member ')
  expect(container.querySelector('[aria-label="选择参与成员"] [aria-pressed="true"]')?.textContent).toBe('Original member')
  await act(async () => button('发送')!.click())
  expect(rpc).toHaveBeenCalledWith('space.mote.group.send', expect.objectContaining({ groupId: room.id,
    body: '请 @Original member ', recipientIds: ['member'] }))
})

it('shows the exact group assignment and its reported recipient after unrelated messages', async () => {
  const { root, container } = mount()
  const member = group.members[0]!
  const coordinator = { ...member, moteId: 'coordinator', name: 'Coordinator', target: { ...member.target, spaceId: 'coordinator' } }
  const other = { ...member, moteId: 'other', name: 'Another member', target: { ...member.target, spaceId: 'other' } }
  const assignment: MoteGroupMessage = { id: 'frozen-assignment', groupId: group.id, sequence: 1, createdAt: 1,
    body: 'Review the launch checklist', author: { kind: 'mote', moteId: coordinator.moteId, name: coordinator.name },
    deliveries: [{ moteId: member.moteId, operationId: 'admitted', status: 'accepted' }, { moteId: other.moteId, operationId: 'failed', status: 'failed' }] }
  const report: MoteGroupMessage = { ...assignment, id: 'report', sequence: 2, createdAt: 2, body: 'Ready for launch',
    author: { kind: 'mote', moteId: member.moteId, name: member.name }, deliveries: [], replyToMessageId: assignment.id }
  const differentReport: MoteGroupMessage = { ...report, id: 'other-report', replyToMessageId: 'another-assignment',
    author: { kind: 'mote', moteId: other.moteId, name: other.name } }
  const room = { ...group, members: [coordinator, member, other],
    lastMessage: { ...report, id: 'ordinary', author: { kind: 'human', id: 'user' }, body: 'Unrelated discussion' },
    lastAssignment: { messageId: assignment.id, createdAt: assignment.createdAt } }
  const rpc = vi.fn(async (method: string, params: { messageId?: string; replyToMessageId?: string }) => {
    if (method === 'space.mote.direct.list') return { threads: [], nextBeforeSequence: null }
    if (method === 'space.mote.group.list') return { groups: [room], nextBeforeSequence: null }
    return { group: room, messages: params.messageId === assignment.id ? [assignment] : [report, differentReport], nextBeforeSequence: null }
  })
  const read = rpc as ReadMoteConversationWork
  await act(async () => root.render(<MoteDirectThreads mote={coordinator.target} active read={read} readGroup={read} />))
  const progress = container.querySelector('[aria-label="作业进展"]')!
  expect(progress.textContent).toContain(assignment.body)
  expect([...progress.querySelectorAll('li')].map(item => item.textContent)).toEqual(['Original member已回报', 'Another member交付失败'])
  expect(rpc).toHaveBeenCalledWith('space.mote.group.inspect', { groupId: room.id, messageId: assignment.id })
  expect(rpc).toHaveBeenCalledWith('space.mote.group.inspect', { groupId: room.id, replyToMessageId: assignment.id, limit: 12 })
})

it('shows valid slow observations without overlapping background polls', async () => {
  vi.useFakeTimers()
  const { root, container } = mount()
  let inFlight = 0, peak = 0, resolved = 0
  const request = vi.fn(() => new Promise(resolve => {
    peak = Math.max(peak, ++inFlight)
    setTimeout(() => {
      --inFlight
      ++resolved
      resolve({ group, viewerId: 'user', messages: [], nextBeforeSequence: null })
    }, 3500)
  }))
  await act(async () => root.render(<MoteGroupConversation call={request as MoteGroupCall} groupId={group.id} candidates={[]} onOpen={() => {}} onClose={() => {}} />))
  await act(async () => { await vi.advanceTimersByTimeAsync(10500) })
  expect(resolved).toBeGreaterThanOrEqual(2)
  expect(container.textContent).toContain(group.name)
  expect(peak).toBe(1)
})

it('releases a definitively refused revision through the desktop error envelope and uses a fresh request only after confirmation', async () => {
  const { root, container, button } = mount()
  const reload = vi.fn()
  const requests: Array<{ operationId: string; expectedRevision: number }> = []
  const call = (async (_method: string, input: { operationId: string; expectedRevision: number }) => {
    requests.push(input)
    // One plain envelope crosses Main->preload->Renderer in Desktop.
    const result = await ipcResult(async () => {
      if (input.expectedRevision === 1)
        throw Object.assign(new Error('Read the current settings before confirming a new operation.'), { code: 'MOTE_GROUP_REVISION_CONFLICT' })
      return { group: { ...group, revision: 3 } }
    })
    return unwrapIpcResult(structuredClone(result))
  }) as MoteGroupCall
  const render = (revision: number) => root.render(<MoteGroupDetails group={{ ...group, revision }} candidates={[]} topicCandidates={[]}
    call={call} onReload={reload} onUpdated={() => {}} onPerspective={() => {}} />)
  await act(async () => render(1))
  await act(async () => { button('移出')!.click() })
  expect(reload).toHaveBeenCalledOnce()
  expect(button('核对原操作')).toBeUndefined()
  expect(button('移出')!.disabled).toBe(true)
  await act(async () => render(2))
  expect(container.textContent).toContain('已读取新版本')
  expect(requests.map(request => request.expectedRevision)).toEqual([1])
  expect(button('移出')!.disabled).toBe(false)
  await act(async () => { button('移出')!.click() })
  expect(requests.map(request => request.expectedRevision)).toEqual([1, 2])
  expect(requests[1]?.operationId).not.toBe(requests[0]?.operationId)
})

it('keeps the original management request on unknown outcomes', async () => {
  const { root, button } = mount()
  const reload = vi.fn()
  const rpc = vi.fn(async () => { throw new Error('connection lost') })
  await act(async () => root.render(<MoteGroupDetails group={group} candidates={[]} topicCandidates={[]} call={rpc as MoteGroupCall}
    onReload={reload} onUpdated={() => {}} onPerspective={() => {}} />))
  await act(async () => { button('移出')!.click() })
  expect(button('移出')!.disabled).toBe(true)
  await act(async () => { button('核对原操作')!.click() })
  expect(rpc.mock.calls.length).toBe(2)
  expect(rpc.mock.calls[1]).toEqual(rpc.mock.calls[0])
  expect(reload).not.toHaveBeenCalled()
})

it('invites only selected Motes still available in the current group', async () => {
  const { root, container, button } = mount()
  const original = group.members[0]!
  const newMember = { ...original, moteId: 'new-member', name: 'New member', target: { ...original.target, spaceId: 'new-member' } }
  const other = { ...newMember.target, spaceId: 'other-member' }
  const candidates = [{ name: newMember.name, target: newMember.target }, { name: 'Other member', target: other }]
  const rpc = vi.fn(async () => ({ group }))
  const render = (summary: MoteGroupSummary) => root.render(<MoteGroupDetails group={summary} candidates={candidates} topicCandidates={[]}
    call={rpc as MoteGroupCall} onReload={() => {}} onUpdated={() => {}} onPerspective={() => {}} />)
  await act(async () => render(group))
  await act(async () => { container.querySelector('input')!.click() })
  expect(button('邀请成员')!.disabled).toBe(false)
  await act(async () => render({ ...group, revision: 2, members: [...group.members, newMember] }))
  expect(button('邀请成员')!.disabled).toBe(true)
  await act(async () => { container.querySelector('input')!.click() })
  await act(async () => { button('邀请成员')!.click() })
  expect(rpc).toHaveBeenCalledExactlyOnceWith('space.mote.group.members.add', expect.objectContaining({ expectedRevision: 2, members: [other] }))
})

it('keeps the current avatar when a stale draft selects only an inactive Mote', async () => {
  const { root, container, button } = mount()
  const original = group.members[0]!
  const current = { ...original, moteId: 'current', name: 'Current member', target: { ...original.target, spaceId: 'current' } }
  const rpc = vi.fn(async () => ({ group }))
  const render = (summary: MoteGroupSummary) => root.render(<MoteGroupDetails group={summary} candidates={[]} topicCandidates={[]}
    call={rpc as MoteGroupCall} onReload={() => {}} onUpdated={() => {}} onPerspective={() => {}} />)
  await act(async () => render({ ...group, members: [original, current] }))
  await act(async () => { button('公告与设置')!.click() })
  await act(async () => { button(original.name)!.click() })
  expect(button(original.name)?.getAttribute('aria-pressed')).toBe('true')
  await act(async () => {
    const announcement = container.querySelector('textarea')!
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(announcement, 'Keep this announcement')
    announcement.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await act(async () => render({ ...group, revision: 2, avatarMoteIds: [current.moteId], members: [{ ...original, state: 'removed' }, current] }))
  await act(async () => { button('按新版本继续编辑')!.click() })
  expect(button(current.name)?.getAttribute('aria-pressed')).toBe('true')
  await act(async () => { button('保存群资料')!.click() })
  expect(rpc).toHaveBeenCalledExactlyOnceWith('space.mote.group.update', { groupId: group.id, expectedRevision: 2,
    operationId: expect.any(String), announcement: 'Keep this announcement' })
})
