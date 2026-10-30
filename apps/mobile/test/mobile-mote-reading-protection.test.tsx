import { appendFileSync } from 'node:fs'
import { act } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { AgentSessionHistoryPage } from '@agentmux/core'
import type { MoteDialoguePage } from '@agentmux/core/mote-dialogue'
import { MobileConversationSurface, type MobileConversationSurfaceProps } from '../src/conversation/MobileConversationSurface'
import type { MobileMoteDialogue } from '../src/conversation/MobileMoteConversation'
import { createBrowserPlatform } from '../src/platform/browser'
import { emptyDeviceWorkface, getDeviceWorkface } from '../src/recovery/device-workface'
import { button, click, editor, fixture, history, mount, mounted, paste } from './conversation-fixture'
import { fixturePath } from '../../../test/fixture-values.mjs'

const sid = 'session-original', member = 'other', hostId = 'host-original'
const target = { spaceId: 'mote-reading', zoneId: 'zone-reading', expectedResource: { hostId, workspaceId: 'workspace-reading', workspacePath: fixturePath('mote-reading') } }
const reference = { hostId, sessionId: sid, displayWorkspaceId: 'display-reading', groupId: 'group-reading', tabId: 'tab-reading', regionId: 'region-reading' }
function page(): MoteDialoguePage {
  return { main: { target, identity: { hostId, moteId: target.spaceId }, status: 'ready',
    resource: { ...target.expectedResource, zoneId: target.zoneId, zonePath: target.expectedResource.workspacePath, path: 'MOTE.md' },
    documentRevision: 'document-A', roleRevision: 'role-A', current: reference, issue: null },
    links: [], incarnation: 'journal-reading', throughSequence: 0, next: null, coverage: 'linked-sources-only', sourceStatus: 'read', sourceIssue: null }
}
function dialogue(value = page()): MobileMoteDialogue {
  return { key: 'reading', read: undefined, page: value, issue: null, unavailable: false, loading: false, refresh: () => {}, older: async () => {} }
}
function props(f: ReturnType<typeof fixture>): MobileConversationSurfaceProps {
  return { client: f.client, agentSessionId: sid, moteTarget: target, moteDialogue: dialogue(), moteName: '持续 Mote',
    platform: createBrowserPlatform(), connection: { state: 'connected', message: '原 Host 已连接' } }
}
async function wait(check: () => void) { await vi.waitFor(async () => { await act(async () => {}); check() }, { timeout: process.env.AGENTMUX_MOBILE_READING_MUTATION ? 2000 : 10000 }) }
beforeEach(async () => {
  const loaded = (globalThis as any).__mobileReadingProtectionEvaluated as Array<{ name: string; file: string; applied: boolean; originalSha256: string; loadedSha256: string }>
  expect(loaded.some(value => value.file.endsWith('/use-mobile-conversation-reading.tsx'))).toBe(true)
  expect(loaded.some(value => value.file.endsWith('/mote-main-input.ts'))).toBe(true)
  const variant = process.env.AGENTMUX_MOBILE_READING_MUTATION
  if (variant) expect(loaded.some(value => value.name === variant && value.applied && value.originalSha256 !== value.loadedSha256)).toBe(true)
  if (process.env.AGENTMUX_MOBILE_READING_TRACE) for (const value of loaded) appendFileSync(process.env.AGENTMUX_MOBILE_READING_TRACE, JSON.stringify({ phase: 'evaluated', ...value }) + '\n')
  localStorage.clear(); await getDeviceWorkface().replaceBackup(emptyDeviceWorkface())
})
afterEach(async () => {
  for (const item of mounted.splice(0)) { await act(async () => item.root.unmount()); item.element.remove() }
  vi.restoreAllMocks(); vi.unstubAllGlobals()
})

it('keeps an observed Discussion role after its current Main becomes unknown, freezing the original public input instead of generic input', async () => {
  const f = fixture(), options = props(f), owner = getDeviceWorkface()
  const rpc = vi.fn(async (method: string, input: any) => {
    if (method === 'message.delivery.report') return
    expect(method).toBe('space.mote.dialogue.input.submit')
    const retained = owner.snapshot().record.conversation.attempts.find(([, attempt]) => attempt.operationId === input.input.operationId)?.[1]
    expect(retained?.moteMain).toEqual({ target, identity: page().main.identity, expectedRoleRevision: 'role-A', reference })
    throw Object.assign(new Error('原主角色暂不可确认；原操作保留。'), { code: 'MOTE_MAIN_INPUT_UNCONFIRMED' })
  })
  f.client.forwardRpc = rpc
  const view = await mount(<MobileConversationSurface {...options} />)
  await wait(() => expect(view.element.textContent).toContain('原生回答'))
  await paste(view.element, '留在原 Discussion 的草稿')
  const unknown = page(); unknown.main = { ...unknown.main, status: 'unconfirmed', current: null, roleRevision: null, issue: '角色来源未知' }
  await view.render(<MobileConversationSurface {...options} moteDialogue={dialogue(unknown)} />)
  await click(button(view.element, 'Send'))
  await wait(() => expect(rpc.mock.calls.filter(([method]) => method === 'space.mote.dialogue.input.submit')).toHaveLength(1))
  expect(rpc.mock.calls.find(([method]) => method === 'space.mote.dialogue.input.submit')![1]).toMatchObject({ target, expectedRoleRevision: 'role-A', input: { agentSessionId: sid, prompt: '留在原 Discussion 的草稿' } })
  expect(f.submit).not.toHaveBeenCalled()
  expect(editor(view.element).textContent).toBe('留在原 Discussion 的草稿')
  expect(button(view.element, 'Send').disabled).toBe(false)
})

it('shows the known Main handoff without turning old Discussion input into direct input, while an explicit original Thread remains usable', async () => {
  const f = fixture(), options = props(f), back = vi.fn(), rpc = vi.fn()
  f.client.forwardRpc = rpc
  const view = await mount(<MobileConversationSurface {...options} onReturnMoteMain={back} />)
  await paste(view.element, '留给 Mote 的原正文')
  const replacement = page(); replacement.main = { ...replacement.main, roleRevision: 'role-B', current: { ...reference, sessionId: member } }
  await view.render(<MobileConversationSurface {...options} moteDialogue={dialogue(replacement)} onReturnMoteMain={back} />)
  await click(button(view.element, 'Send'))
  expect(f.submit).not.toHaveBeenCalled(); expect(rpc).not.toHaveBeenCalled()
  expect(editor(view.element).textContent).toBe('留给 Mote 的原正文')
  await click(button(view.element, '返回当前主对话')); expect(back).toHaveBeenCalledWith()
  await view.render(<MobileConversationSurface {...options} moteDialogue={dialogue(replacement)} moteDirectAgent />)
  await click(button(view.element, 'Send'))
  await wait(() => expect(f.submit).toHaveBeenCalledOnce())
  expect(f.submit.mock.calls[0]![0]).toMatchObject({ agentSessionId: sid, prompt: '留给 Mote 的原正文' })
  expect(rpc).not.toHaveBeenCalled()
})

it('parks original Main and member Readers through round trips, retaining each window, scroll, follow state and draft without hidden reads', async () => {
  const f = fixture(), options = props(f)
  f.readHistory.mockImplementation(async (id, input) => {
    const original = history(id)
    const label = id === sid ? 'Main' : 'Thread'
    const older = Boolean(input?.cursor)
    const result: AgentSessionHistoryPage = { ...original, items: [...(older ? [{ id: label + '-older', kind: 'assistant-message' as const,
      startedAt: 1, contentParts: [{ kind: 'text' as const, text: label + ' 原历史窗口' }] }] : []),
      ...original.items.map(item => ({ ...item, contentParts: [{ kind: 'text' as const, text: label + ' 原最新窗口' }] }))] }
    if (older) delete result.nextCursor
    return result
  })
  const read = vi.fn(f.client.readAgentConversation), release = vi.fn(f.client.releaseConversationView)
  f.client.readAgentConversation = read; f.client.releaseConversationView = release
  const view = await mount(<MobileConversationSurface {...options} />)
  await wait(() => expect(view.element.textContent).toContain('Main 原最新窗口'))
  const feed = view.element.querySelector<HTMLElement>('.mobile-conversation__reading')!
  Object.defineProperties(feed, { scrollHeight: { configurable: true, value: 1600 }, clientHeight: { configurable: true, value: 400 } })
  const scroll = async (top: number) => { await act(async () => { feed.scrollTop = top; feed.dispatchEvent(new Event('scroll', { bubbles: true })) }) }
  await scroll(1200); await scroll(350)
  await paste(view.element, 'Main 原草稿')
  await click(button(view.element, '更早消息'))
  await wait(() => expect(view.element.textContent).toContain('Main 原历史窗口'))
  await scroll(350)
  const mainRequests = read.mock.calls.filter(([input]) => input.agentSessionId === sid).length
  await view.render(<MobileConversationSurface {...options} agentSessionId={member} moteDirectAgent />)
  await wait(() => expect(view.element.textContent).toContain('Thread 原最新窗口'))
  await scroll(1200); await scroll(780); await paste(view.element, 'Thread 原草稿')
  expect(read.mock.calls.filter(([input]) => input.agentSessionId === sid)).toHaveLength(mainRequests)
  await act(async () => { f.emit({ type: 'agent-timeline', agentSessionId: sid, revision: 9 }) })
  expect(read.mock.calls.filter(([input]) => input.agentSessionId === sid)).toHaveLength(mainRequests)
  expect(release).not.toHaveBeenCalled()
  const beforeMainReturn = read.mock.calls.length
  await view.render(<MobileConversationSurface {...options} />)
  await wait(() => expect(view.element.textContent).toContain('Main 原历史窗口'))
  await wait(() => expect(read.mock.calls.length).toBeGreaterThan(beforeMainReturn))
  expect(read.mock.calls.slice(beforeMainReturn).filter(([input]) => input.agentSessionId === sid).every(([input]) => Boolean(input.view))).toBe(true)
  expect(editor(view.element).textContent).toBe('Main 原草稿')
  expect(feed.scrollTop).toBe(350)
  expect(button(view.element, '回到最新')).toBeDefined()
  await view.render(<MobileConversationSurface {...options} agentSessionId={member} moteDirectAgent />)
  await wait(() => expect(view.element.textContent).toContain('Thread 原最新窗口'))
  expect(editor(view.element).textContent).toBe('Thread 原草稿')
  expect(feed.scrollTop).toBe(780)
  expect(button(view.element, '回到最新')).toBeDefined()
  expect(f.submit).not.toHaveBeenCalled(); expect(f.respond).not.toHaveBeenCalled()
  expect(release).not.toHaveBeenCalled()
  await view.render(<MobileConversationSurface {...options} moteTarget={{ ...target, spaceId: 'another-mote' }} />)
  await wait(() => expect(release).toHaveBeenCalledTimes(2))
})


it('retains a cold-remounted Discussion draft when no Main role is qualified, and permits the same healthy Agent only after explicit Thread selection', async () => {
  const f = fixture(), options = props(f), owner = getDeviceWorkface(), rpc = vi.fn()
  f.client.forwardRpc = rpc
  const unknown = page(); unknown.main = { ...unknown.main, status: 'unconfirmed', current: null, roleRevision: null, issue: '原主角色未确认' }
  const source = { ...dialogue(unknown), refresh: vi.fn() }
  const first = await mount(<MobileConversationSurface {...options} moteDialogue={source} />)
  await paste(first.element, '冷重挂仍属于 Discussion 的原稿')
  await wait(() => expect(owner.snapshot().record.conversation.drafts.some(([, draft]) => draft === '冷重挂仍属于 Discussion 的原稿')).toBe(true))
  const original = mounted.pop()!
  await act(async () => original.root.unmount()); original.element.remove()
  const view = await mount(<MobileConversationSurface {...options} moteDialogue={source} />)
  await wait(() => expect(editor(view.element).textContent).toBe('冷重挂仍属于 Discussion 的原稿'))
  await click(button(view.element, 'Send'))
  expect(f.submit).not.toHaveBeenCalled(); expect(rpc).not.toHaveBeenCalled()
  expect(editor(view.element).textContent).toBe('冷重挂仍属于 Discussion 的原稿')
  expect(button(view.element, 'Send').disabled).toBe(false)
  await click(button(view.element, '重新核对主对话')); expect(source.refresh).toHaveBeenCalledOnce()
  expect(f.submit).not.toHaveBeenCalled(); expect(rpc).not.toHaveBeenCalled()
  await view.render(<MobileConversationSurface {...options} moteDialogue={source} moteDirectAgent />)
  await click(button(view.element, 'Send'))
  await wait(() => expect(f.submit).toHaveBeenCalledOnce())
  expect(f.submit.mock.calls[0]![0]).toMatchObject({ agentSessionId: sid, prompt: '冷重挂仍属于 Discussion 的原稿' })
  expect(rpc).not.toHaveBeenCalled()
})
