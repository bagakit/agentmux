import { act } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { MobileApp } from '../src/MobileApp'
import { createBrowserPlatform } from '../src/platform/browser'
import { emptyDeviceWorkface, getDeviceWorkface } from '../src/recovery/device-workface'
import { fixture, mount, mounted } from './conversation-fixture'

const sid = 'session-original', spaceId = 'original-space', runId = 'run-original'
const context = { spaceId, zoneId: 'original-zone', workspaceId: 'original-workspace', displayWorkspaceId: 'original-workspace', groupId: 'original-group', tabId: 'original-tab', regionId: 'original-region' }
const connected = { state: 'connected' as const, message: '原 Host' }
const catalog = { spaces: [], zones: [], tabs: [], regions: [], bindings: [], locations: [], agentPresentation: [], appearance: [{ spaceId, preset: 'project' }] }
beforeEach(async () => { localStorage.clear(); await getDeviceWorkface().replaceBackup(emptyDeviceWorkface()); vi.spyOn(HTMLElement.prototype, 'getClientRects').mockReturnValue([{ width: 28, height: 28 }] as unknown as DOMRectList); vi.stubGlobal('IntersectionObserver', class {
  constructor(private callback: IntersectionObserverCallback) {}
  observe(target: Element) { queueMicrotask(() => this.callback([{ target, isIntersecting: true } as IntersectionObserverEntry], this as unknown as IntersectionObserver)) }
  disconnect() {} unobserve() {}
}) })
afterEach(async () => { for (const view of mounted.splice(0)) { await act(async () => view.root.unmount()); view.element.remove() }; document.body.replaceChildren(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

it.each(['mote', 'space'] as const)('original %s header reports and recovers its own appearance observation', async kind => {
  const f = fixture(), owner = getDeviceWorkface()
  const identity = { name: '原会话', project: '原项目', context, ...(kind === 'mote' ? { mote: { spaceId, name: '原 Mote' } } : {}) }
  await owner.updatePresentation({ selectedSessionId: sid, hostUrl: '', panel: 'conversation' }, { primary: 'focus', showSession: true, showGoalWork: false, identity, profile: null })
  let fail = true
  f.client.forwardRpc = vi.fn(async (method: string, params: any) => {
    if (method === (kind === 'mote' ? 'space.ls' : 'space.inspect') && params?.target?.spaceId === spaceId && params.presentation === true && fail) throw Error('原头像观察失败')
    if (method === 'goal.ls') return { goals: [], unavailable: [] }
    if (method === 'topic.category.ls') return { categories: [], unavailable: [] }
    if (method === 'topic.ls') return { topics: [], unavailable: [] }
    if (method === 'app.snapshot') return { agents: [], workspaces: [], projects: [], executors: [], unavailable: [] }
    return { catalog }
  }) as any
  const platform = createBrowserPlatform(), surface = (state = connected) => <MobileApp client={f.client} connection={state} platform={platform} native />
  const view = await mount(surface())
  const header = () => view.element.querySelector('.mobile-session-toolbar')!
  await vi.waitFor(() => expect(header()?.querySelector('.mobile-avatar-issue')?.getAttribute('aria-label')).toContain('原头像观察失败'))
  expect(header().querySelector('[aria-label="当前对话操作"]')).not.toBeNull()
  expect(header().querySelector('[aria-label="撰写消息"]')).toBeNull()
  expect(f.client.forwardRpc).toHaveBeenCalledWith(kind === 'mote' ? 'space.ls' : 'space.inspect', { target: { spaceId }, presentation: true })
  const before = (f.client.forwardRpc as any).mock.calls.length
  fail = false
  if (kind === 'mote') await act(async () => f.emit({ type: 'agent-timeline', agentSessionId: sid, revision: 2 } as any))
  else { await view.render(surface({ state: 'disconnected', message: '原 Host 暂时离线' } as any)); await view.render(surface()) }
  await vi.waitFor(() => expect(header().querySelector('.mobile-avatar-issue')).toBeNull())
  expect((f.client.forwardRpc as any).mock.calls.slice(before)).toContainEqual([kind === 'mote' ? 'space.ls' : 'space.inspect', { target: { spaceId }, presentation: true }])
  expect(header().querySelector('.mobile-object-avatar')).not.toBeNull()
  expect(f.client.agentSession(sid).run.runId).toBe(runId); expect(f.submit).not.toHaveBeenCalled()
})
