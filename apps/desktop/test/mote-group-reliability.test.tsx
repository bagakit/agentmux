import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { MoteGroupConversation, type MoteGroupCall } from '../../../packages/client-ui/src/components/MoteGroupConversation'
import { MoteGroupDetails } from '../../../packages/client-ui/src/components/MoteGroupSettings'
import type { MoteGroupSummary } from '@agentmux/core/mote/group'
import { ipcResult, unwrapIpcResult } from '../src/shared/ipc-result'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
const group: MoteGroupSummary = { id: 'room', name: 'Readable original group', lastMessage: null, revision: 1,
  avatarMoteIds: [], announcement: null, topic: null, members: [{ moteId: 'member', name: 'Original member', state: 'active', role: 'member', thread: null,
    target: { spaceId: 'member', zoneId: 'original-zone', expectedResource: { hostId: 'local', workspaceId: 'scratch', workspacePath: '/scratch' } } }] }

const disposals: Array<() => Promise<void>> = []
function mount() {
  const container = document.createElement('div')
  const root = createRoot(container)
  disposals.push(async () => act(async () => root.unmount()))
  return { root, container, button: (name: string) => [...container.querySelectorAll('button')].find(button => button.textContent === name) }
}
afterEach(async () => {
  for (const dispose of disposals.splice(0)) await dispose()
  vi.useRealTimers()
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
