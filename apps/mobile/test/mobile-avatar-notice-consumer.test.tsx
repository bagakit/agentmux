import { fixturePath } from '../../../test/fixture-values.mjs'
import { act } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { MobileApp } from '../src/MobileApp'
import { createBrowserPlatform } from '../src/platform/browser'
import { emptyDeviceWorkface, getDeviceWorkface } from '../src/recovery/device-workface'
import { button, click, deferred, editor, fixture, mount, mounted, paste } from './conversation-fixture'

const sid = 'session-original', spaceId = 'original-space'
const context = { spaceId, zoneId: 'original-zone', workspaceId: 'original-workspace', displayWorkspaceId: 'original-workspace', groupId: 'original-group', tabId: 'original-tab', regionId: 'original-region' }
const connected = { state: 'connected' as const, message: '原 Host' }
const emptyCatalog = { spaces: [], zones: [], tabs: [], regions: [], bindings: [], locations: [], agentPresentation: [] }
const presentation = (kind: 'mote' | 'space') => ({ primary: 'focus' as const, showSession: true, showGoalWork: false,
  identity: { name: '同名会话', project: '同名项目', context, ...(kind === 'mote' ? { mote: { spaceId, name: '同名 Mote' } } : {}) }, profile: null })
const appearance = { spaceId, preset: 'project' }

beforeEach(async () => {
  localStorage.clear()
  await getDeviceWorkface().replaceBackup(emptyDeviceWorkface())
  vi.spyOn(HTMLElement.prototype, 'getClientRects').mockReturnValue([{ width: 28, height: 28 }] as unknown as DOMRectList)
  vi.stubGlobal('IntersectionObserver', class {
    constructor(private callback: IntersectionObserverCallback) {}
    observe(target: Element) { queueMicrotask(() => this.callback([{ target, isIntersecting: true } as IntersectionObserverEntry], this as unknown as IntersectionObserver)) }
    disconnect() {} unobserve() {}
  })
})
afterEach(async () => {
  for (const view of mounted.splice(0)) { await act(async () => view.root.unmount()); view.element.remove() }
  document.body.replaceChildren(); vi.restoreAllMocks(); vi.unstubAllGlobals()
})
function originalClient(kind: 'mote' | 'space', read: () => Promise<unknown>) {
  const f = fixture(), method = kind === 'mote' ? 'space.ls' : 'space.inspect'
  f.client.forwardRpc = vi.fn(async (name: string, params: any) => {
    if (name === method && params?.target?.spaceId === spaceId && params.presentation === true) return read()
    if (name === 'goal.ls') return { goals: [], unavailable: [] }
    if (name === 'topic.category.ls') return { categories: [], unavailable: [] }
    if (name === 'topic.ls') return { topics: [], unavailable: [] }
    if (name === 'app.snapshot') return { agents: [], workspaces: [], projects: [], executors: [], unavailable: [] }
    return { catalog: emptyCatalog }
  }) as any
  return { ...f, method }
}
function notice(): HTMLElement {
  const summary = [...document.querySelectorAll<HTMLElement>('summary')].find(node => node.textContent?.includes('头像外观未确认'))
  expect(summary, 'Original appearance must be discoverable from a visible disclosure').toBeDefined()
  expect(summary!.closest('[hidden]')).toBeNull()
  const node = summary!.closest<HTMLElement>('.mobile-notice')
  expect(node).not.toBeNull()
  return node!
}
async function reveal() {
  const node = notice()
  const summary = node.querySelector('summary')!
  expect(summary.textContent).toContain('头像外观未确认')
  await click(summary)
  expect(summary.closest('details')?.open).toBe(true)
  return node
}
async function open(kind: 'mote' | 'space', f: ReturnType<typeof originalClient>) {
  await getDeviceWorkface().updatePresentation({ selectedSessionId: sid, hostUrl: '', panel: 'conversation' }, presentation(kind))
  const platform = createBrowserPlatform()
  const render = (client = f.client) => <MobileApp client={client} connection={connected} platform={platform} native />
  const view = await mount(render())
  return { ...view, surface: render }
}

it.each(['mote', 'space'] as const)('%s original failure is readable, dismissible, restorable and retried at its own owner without altering a draft or Run', async kind => {
  let failed = true
  const f = originalClient(kind, async () => {
    if (failed) throw Error('原头像读取失败：连接被拒绝；完整原因必须可阅读。')
    return { catalog: { ...emptyCatalog, appearance: [appearance] } }
  })
  const view = await open(kind, f)
  await paste(view.element, '原草稿完整保留')
  const originalEditor = editor(view.element), run = f.client.agentSession(sid).run.runId
  await vi.waitFor(() => expect(notice()).toBeDefined())
  const trigger = notice().querySelector<HTMLElement>('summary')!
  trigger.focus()
  expect(document.activeElement).toBe(trigger)
  await act(async () => {
    trigger.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }))
    trigger.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true }))
    trigger.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Enter' }))
    trigger.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, key: 'Enter' }))
  })
  expect(document.querySelector('[role=dialog]')).toBeNull()
  let item = await reveal()
  expect(document.querySelector('[role=dialog]')).toBeNull()
  expect(item.textContent).toContain('原头像读取失败：连接被拒绝；完整原因必须可阅读。')
  expect(document.querySelector('button button')).toBeNull()
  await click(button(item, '收起提醒'))
  expect([...document.querySelectorAll('summary')].some(node => node.textContent?.includes('头像外观未确认'))).toBe(false)
  await click(button(view.element, '手机设置与连接'))
  await click(button(document.body, '提醒与诊断'))
  expect(document.body.textContent).toContain('有已收起的提醒')
  await click(button(document.body, '恢复已收起提醒'))
  item = await reveal()
  expect(item.textContent).toContain('原头像读取失败：连接被拒绝；完整原因必须可阅读。')
  failed = false
  await click(button(item, '重新读取头像'))
  await vi.waitFor(() => expect([...document.querySelectorAll('summary')].some(node => node.textContent?.includes('头像外观未确认'))).toBe(false))
  expect(f.client.forwardRpc).toHaveBeenCalledWith(f.method, { target: { spaceId }, presentation: true })
  expect(editor(view.element)).toBe(originalEditor)
  expect(originalEditor.textContent).toBe('原草稿完整保留')
  expect(f.client.agentSession(sid).run.runId).toBe(run)
  expect(f.submit).not.toHaveBeenCalled(); expect(f.respond).not.toHaveBeenCalled()
})

it.each(['mote', 'space'] as const)('%s missing original appearance stays unknown and an unsuccessful explicit retry keeps its notice', async kind => {
  const f = originalClient(kind, async () => ({ catalog: { ...emptyCatalog, appearance: [{ spaceId: 'other-space', preset: 'project' }] } }))
  await open(kind, f)
  await vi.waitFor(() => expect(notice()).toBeDefined())
  const item = await reveal()
  expect(item.textContent).toContain('尚未确认')
  const before = (f.client.forwardRpc as any).mock.calls.filter(([name, params]: any[]) => name === f.method && params?.target?.spaceId === spaceId).length
  await click(button(item, '重新读取头像'))
  await vi.waitFor(() => expect((f.client.forwardRpc as any).mock.calls.filter(([name, params]: any[]) => name === f.method && params?.target?.spaceId === spaceId).length).toBeGreaterThan(before))
  expect(notice().textContent).toContain('尚未确认')
  expect(f.submit).not.toHaveBeenCalled()
})

it.each(['mote', 'space'] as const)('%s ignores a late old Host observation after switching to a same-name, same-space ID on another Host', async kind => {
  const pending = deferred<unknown>(), old = originalClient(kind, () => pending.promise)
  const next = originalClient(kind, async () => { throw Error('新 Host 的原对象读取失败') })
  next.sessions.set(sid, { ...next.sessions.get(sid)!, hostId: 'host-other', run: { runId: 'run-other' } })
  const view = await open(kind, old)
  await vi.waitFor(() => expect(old.client.forwardRpc).toHaveBeenCalledWith(old.method, { target: { spaceId }, presentation: true }))
  await view.render(view.surface(next.client))
  await vi.waitFor(() => expect(notice()).toBeDefined())
  const item = await reveal()
  expect(item.textContent).toContain('新 Host 的原对象读取失败')
  await act(async () => pending.resolve({ catalog: { ...emptyCatalog, appearance: [appearance] } }))
  expect(notice().textContent).toContain('新 Host 的原对象读取失败')
  const oldReads = (old.client.forwardRpc as any).mock.calls.length
  await click(button(item, '重新读取头像'))
  expect((old.client.forwardRpc as any).mock.calls).toHaveLength(oldReads)
  expect(next.client.forwardRpc).toHaveBeenCalledWith(next.method, { target: { spaceId }, presentation: true })
  expect(next.client.agentSession(sid).run.runId).toBe('run-other')
  expect(next.submit).not.toHaveBeenCalled(); expect(old.submit).not.toHaveBeenCalled()
})

it.each(['mote', 'space'] as const)('%s healthy original appearance does not create a warning or require an extra retry', async kind => {
  const f = originalClient(kind, async () => ({ catalog: { ...emptyCatalog, appearance: [appearance] } }))
  await open(kind, f)
  await vi.waitFor(() => expect(f.client.forwardRpc).toHaveBeenCalledWith(f.method, { target: { spaceId }, presentation: true }))
  expect([...document.querySelectorAll('summary')].some(node => node.textContent?.includes('头像外观未确认'))).toBe(false)
  expect(document.querySelector('button button')).toBeNull()
})

it('keeps same-name Space failures from different Hosts separate and retries only the selected original object', async () => {
  const f = fixture()
  const spaces = [
    { spaceId: 'space-A', name: '同名项目', kind: 'folder', hostId: 'host-A', directoryPath: fixturePath('a'), projectId: null },
    { spaceId: 'space-B', name: '同名项目', kind: 'folder', hostId: 'host-B', directoryPath: fixturePath('b'), projectId: null }
  ]
  const catalog = { ...emptyCatalog, spaces }
  const failures = new Set(['space-A', 'space-B'])
  f.client.forwardRpc = vi.fn(async (name: string, params: any) => {
    if (name === 'space.inspect') {
      const id = params?.target?.spaceId
      if (failures.has(id)) throw Error(`原对象 ${id} 的完整读取失败`)
      return { catalog: { ...catalog, appearance: [{ spaceId: id, preset: 'project' }] } }
    }
    if (name === 'goal.ls') return { goals: [], unavailable: [] }
    if (name === 'topic.category.ls') return { categories: [], unavailable: [] }
    if (name === 'topic.ls') return { topics: [], unavailable: [] }
    if (name === 'app.snapshot') return { agents: [], workspaces: [], projects: [], executors: [], unavailable: [] }
    return { catalog }
  }) as any
  await getDeviceWorkface().updatePresentation({ selectedSessionId: sid, hostUrl: '', panel: 'conversation' },
    { primary: 'space', showSession: false, showGoalWork: false, identity: null, profile: null })
  const view = await mount(<MobileApp client={f.client} connection={connected} platform={createBrowserPlatform()} native />)
  await click(button(view.element.querySelector<HTMLElement>('.mobile-navigation')!, 'Space'))
  const summaries = () => [...document.querySelectorAll<HTMLElement>('summary')].filter(node => node.textContent?.includes('头像外观未确认'))
  await vi.waitFor(() => expect(summaries()).toHaveLength(2))
  for (const summary of summaries()) {
    await act(async () => {
      summary.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }))
      summary.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true }))
      summary.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Enter' }))
      summary.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, key: 'Enter' }))
    })
    await click(summary)
  }
  const item = (id: string) => [...document.querySelectorAll<HTMLElement>('.mobile-notice')].find(node => node.textContent?.includes(`原对象 ${id} 的完整读取失败`))!
  expect(item('space-A')).toBeDefined(); expect(item('space-B')).toBeDefined()
  expect(document.querySelector('button button')).toBeNull()
  expect(view.element.querySelectorAll('.mobile-space-children')).toHaveLength(0)
  await click(button(item('space-A'), '收起提醒'))
  expect(item('space-A')).toBeUndefined(); expect(item('space-B')).toBeDefined()
  failures.delete('space-B')
  const before = (f.client.forwardRpc as any).mock.calls.length
  await click(button(item('space-B'), '重新读取头像'))
  await vi.waitFor(() => expect(item('space-B')).toBeUndefined())
  const reads = (f.client.forwardRpc as any).mock.calls.slice(before).filter(([name]: any[]) => name === 'space.inspect')
  expect(reads).toEqual([['space.inspect', { target: { spaceId: 'space-B' }, presentation: true }]])
  await click(button(view.element, '手机设置与连接'))
  await click(button(document.body, '提醒与诊断'))
  await click(button(document.body, '恢复已收起提醒'))
  await vi.waitFor(() => expect(summaries()).toHaveLength(1))
  await click(summaries()[0]!)
  expect(item('space-A')).toBeDefined(); expect(item('space-B')).toBeUndefined()
  expect(f.submit).not.toHaveBeenCalled()
  expect(view.element.querySelectorAll('.mobile-space-children')).toHaveLength(0)
})

it('does not show the old Mote Host and Run failure while the new original observation is pending on the same client', async () => {
  const kind = 'mote' as const
  const pending = deferred<unknown>()
  let calls = 0
  const f = originalClient(kind, async () => {
    if (++calls === 1) throw Error('旧 Host 头像原失败')
    return pending.promise
  })
  await open(kind, f)
  await vi.waitFor(() => expect(notice()).toBeDefined())
  expect((await reveal()).textContent).toContain('旧 Host 头像原失败')
  await act(async () => f.emit({ type: 'agent-session', session: { ...f.sessions.get(sid)!, hostId: 'host-other', run: { runId: 'run-other' } } } as any))
  await vi.waitFor(() => expect(calls).toBeGreaterThan(1))
  expect([...document.querySelectorAll('summary')].some(node => node.textContent?.includes('头像外观未确认'))).toBe(false)
  await act(async () => pending.reject(Error('新 Host 头像原失败')))
  await vi.waitFor(() => expect(notice()).toBeDefined())
  expect((await reveal()).textContent).toContain('新 Host 头像原失败')
  expect(document.body.textContent).not.toContain('旧 Host 头像原失败')
  expect(f.client.agentSession(sid).run.runId).toBe('run-other')
  expect(f.submit).not.toHaveBeenCalled()
})

it('does not carry an old Mote observation failure into a different selected Session on the same client', async () => {
  const f = fixture(), pending = deferred<unknown>()
  let first = true
  const catalog = { ...emptyCatalog,
    spaces: [{ spaceId, name: '同名项目', kind: 'mote', hostId: 'host-original', directoryPath: fixturePath('project'), projectId: null }],
    zones: [{ zoneId: context.zoneId, workspaceId: context.workspaceId, kind: 'home', hostId: 'host-original', directoryPath: fixturePath('project'), branch: null }],
    tabs: [{ tabId: context.tabId, zoneId: context.zoneId, workspaceId: context.workspaceId, name: '另一个会话', regionIds: [context.regionId] }],
    regions: [{ tabId: context.tabId, regionId: context.regionId, kind: 'agent', agentSessionId: 'peer', runId: 'run-peer', execution: { hostId: 'host-original', cwd: fixturePath('project') } }],
    bindings: [{ spaceId, zoneId: context.zoneId }], locations: [context],
    agentPresentation: [{ agentSessionId: 'peer', name: '另一个会话', project: '同名项目', detail: '', group: 'working', state: 'working', providerId: 'codex', recap: null }]
  }
  f.client.forwardRpc = vi.fn(async (name: string, params: any) => {
    if (name === 'space.ls' && params?.target?.spaceId === spaceId) {
      if (first) throw Error('旧会话头像失败')
      return pending.promise
    }
    if (name === 'goal.ls') return { goals: [], unavailable: [] }
    if (name === 'topic.category.ls') return { categories: [], unavailable: [] }
    if (name === 'topic.ls') return { topics: [], unavailable: [] }
    if (name === 'app.snapshot') return { agents: [], workspaces: [], projects: [], executors: [], unavailable: [] }
    return { catalog }
  }) as any
  await getDeviceWorkface().updatePresentation({ selectedSessionId: sid, hostUrl: '', panel: 'conversation' }, presentation('mote'))
  const view = await mount(<MobileApp client={f.client} connection={connected} platform={createBrowserPlatform()} native />)
  await vi.waitFor(() => expect(notice()).toBeDefined())
  expect((await reveal()).textContent).toContain('旧会话头像失败')
  first = false
  await click(button(view.element.querySelector<HTMLElement>('.mobile-navigation')!, 'Focus'))
  await vi.waitFor(() => expect(view.element.textContent).toContain('另一个会话'))
  const row = [...view.element.querySelectorAll<HTMLButtonElement>('.mobile-agent-row__open')].find(value => value.textContent?.includes('另一个会话'))!
  expect(row).toBeDefined()
  await click(row)
  expect(getDeviceWorkface().snapshot().record.selectedSessionId).toBe('peer')
  expect(document.body.textContent).not.toContain('旧会话头像失败')
  expect([...document.querySelectorAll('summary')].filter(node => !node.closest('[hidden]') && node.textContent?.includes('头像外观未确认'))).toHaveLength(0)
  await act(async () => pending.reject(Error('新会话头像失败')))
  await vi.waitFor(() => expect(notice()).toBeDefined())
  expect((await reveal()).textContent).toContain('新会话头像失败')
  expect(f.submit).not.toHaveBeenCalled()
})

it.each(['mote', 'space'] as const)('%s does not transfer a batched old-owner retry to the new Host observation', async kind => {
  const old = originalClient(kind, async () => { throw Error('旧 Host 读取失败') })
  const next = originalClient(kind, async () => ({ catalog: { ...emptyCatalog, appearance: [appearance] } }))
  next.sessions.set(sid, { ...next.sessions.get(sid)!, hostId: 'host-other', run: { runId: 'run-other' } })
  const view = await open(kind, old)
  await vi.waitFor(() => expect(notice()).toBeDefined())
  const item = await reveal(), retry = button(item, '重新读取头像')
  const oldReads = (old.client.forwardRpc as any).mock.calls.filter(([name, params]: any[]) => name === old.method && params?.target?.spaceId === spaceId).length
  const root = mounted.find(value => value.element === view.element)!.root
  await act(async () => {
    retry.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    root.render(view.surface(next.client))
  })
  await vi.waitFor(() => expect((next.client.forwardRpc as any).mock.calls.filter(([name, params]: any[]) => name === next.method && params?.target?.spaceId === spaceId)).toHaveLength(1))
  expect((old.client.forwardRpc as any).mock.calls.filter(([name, params]: any[]) => name === old.method && params?.target?.spaceId === spaceId)).toHaveLength(oldReads)
  expect([...document.querySelectorAll('summary')].some(node => node.textContent?.includes('头像外观未确认'))).toBe(false)
  expect(old.submit).not.toHaveBeenCalled(); expect(next.submit).not.toHaveBeenCalled()
})

it('retains the confirmed original Mote image when its Run changes and the new observation is unknown', async () => {
  const f = fixture(), imageUrl = 'data:image/png;base64,aGVsbG8=', imageFact = { spaceId, image: { revision: 'image-original', dataUrl: imageUrl } }
  let fail = false
  f.client.forwardRpc = vi.fn(async (name: string, params: any) => {
    if (name === 'space.ls' && params?.target?.spaceId === spaceId) {
      if (fail) throw Error('新 Run 头像观察未知')
      return { catalog: { ...emptyCatalog, appearance: [{ spaceId, image: { revision: 'image-original' } }] } }
    }
    if (name === 'space.inspect' && params?.target?.spaceId === spaceId) return { catalog: { ...emptyCatalog, appearance: [imageFact] } }
    if (name === 'goal.ls') return { goals: [], unavailable: [] }
    if (name === 'topic.category.ls') return { categories: [], unavailable: [] }
    if (name === 'topic.ls') return { topics: [], unavailable: [] }
    if (name === 'app.snapshot') return { agents: [], workspaces: [], projects: [], executors: [], unavailable: [] }
    return { catalog: emptyCatalog }
  }) as any
  const view = await open('mote', { ...f, method: 'space.ls' })
  const image = () => view.element.querySelector<HTMLImageElement>('.mobile-session-toolbar .space-object-icon__avatar')
  await vi.waitFor(() => expect(image()?.getAttribute('src')).toBe(imageUrl))
  fail = true
  await act(async () => f.emit({ type: 'agent-session', session: { ...f.sessions.get(sid)!, run: { runId: 'run-next' } } } as any))
  await vi.waitFor(() => expect(notice()).toBeDefined())
  expect(image()?.getAttribute('src')).toBe(imageUrl)
  expect((await reveal()).textContent).toContain('新 Run 头像观察未知')
  expect(f.client.agentSession(sid).run.runId).toBe('run-next')
  expect(f.submit).not.toHaveBeenCalled()
})

it('never shows one Host’s confirmed Mote image as the same-named original on another client', async () => {
  const imageUrl = 'data:image/png;base64,aGVsbG8=', old = fixture(), pending = deferred<unknown>()
  old.client.forwardRpc = vi.fn(async (name: string, params: any) => {
    if (name === 'space.ls' && params?.target?.spaceId === spaceId) return { catalog: { ...emptyCatalog, appearance: [{ spaceId, image: { revision: 'image-original' } }] } }
    if (name === 'space.inspect' && params?.target?.spaceId === spaceId) return { catalog: { ...emptyCatalog, appearance: [{ spaceId, image: { revision: 'image-original', dataUrl: imageUrl } }] } }
    if (name === 'goal.ls') return { goals: [], unavailable: [] }
    if (name === 'topic.category.ls') return { categories: [], unavailable: [] }
    if (name === 'topic.ls') return { topics: [], unavailable: [] }
    if (name === 'app.snapshot') return { agents: [], workspaces: [], projects: [], executors: [], unavailable: [] }
    return { catalog: emptyCatalog }
  }) as any
  const next = originalClient('mote', () => pending.promise)
  next.sessions.set(sid, { ...next.sessions.get(sid)!, hostId: 'host-other', run: { runId: 'run-other' } })
  const view = await open('mote', { ...old, method: 'space.ls' })
  const image = () => view.element.querySelector<HTMLImageElement>('.mobile-session-toolbar .space-object-icon__avatar')
  await vi.waitFor(() => expect(image()?.getAttribute('src')).toBe(imageUrl))
  await view.render(view.surface(next.client))
  await vi.waitFor(() => expect(next.client.forwardRpc).toHaveBeenCalledWith('space.ls', { target: { spaceId }, presentation: true }))
  expect(image()).toBeNull()
  await act(async () => pending.reject(Error('新 Host 头像观察未知')))
  await vi.waitFor(() => expect(notice()).toBeDefined())
  expect(image()).toBeNull()
  expect((await reveal()).textContent).toContain('新 Host 头像观察未知')
  expect(old.submit).not.toHaveBeenCalled(); expect(next.submit).not.toHaveBeenCalled()
})

it('explicitly retries a Space appearance issue even when the original appearance has a saved glyph', async () => {
  const f = fixture()
  const catalog = { ...emptyCatalog, spaces: [{ spaceId, name: '同名项目', kind: 'folder', hostId: 'host-original', directoryPath: fixturePath('project'), projectId: null }],
    appearance: [{ spaceId, glyph: 'folder', issue: '原保存图标外观读取失败' }] }
  f.client.forwardRpc = vi.fn(async (name: string, params: any) => {
    if (name === 'space.inspect' && params?.target?.spaceId === spaceId) return { catalog: { ...catalog, appearance: [{ spaceId, glyph: 'folder' }] } }
    if (name === 'goal.ls') return { goals: [], unavailable: [] }
    if (name === 'topic.category.ls') return { categories: [], unavailable: [] }
    if (name === 'topic.ls') return { topics: [], unavailable: [] }
    if (name === 'app.snapshot') return { agents: [], workspaces: [], projects: [], executors: [], unavailable: [] }
    return { catalog }
  }) as any
  await getDeviceWorkface().updatePresentation({ selectedSessionId: sid, hostUrl: '', panel: 'conversation' },
    { primary: 'space', showSession: false, showGoalWork: false, identity: null, profile: null })
  const view = await mount(<MobileApp client={f.client} connection={connected} platform={createBrowserPlatform()} native />)
  await click(button(view.element.querySelector<HTMLElement>('.mobile-navigation')!, 'Space'))
  await vi.waitFor(() => expect(notice()).toBeDefined())
  const item = await reveal()
  expect(item.textContent).toContain('原保存图标外观读取失败')
  expect((f.client.forwardRpc as any).mock.calls.filter(([name]: any[]) => name === 'space.inspect')).toHaveLength(0)
  await click(button(item, '重新读取头像'))
  await vi.waitFor(() => expect(f.client.forwardRpc).toHaveBeenCalledWith('space.inspect', { target: { spaceId }, presentation: true }))
  await vi.waitFor(() => expect([...document.querySelectorAll('summary')].some(node => node.textContent?.includes('头像外观未确认'))).toBe(false))
  expect(view.element.querySelector('[data-space-icon-source="manual"]')).not.toBeNull()
  expect(f.submit).not.toHaveBeenCalled()
})

it('retains a Space icon failure across an Agent Run change without a second static observation', async () => {
  const f = originalClient('space', async () => { throw Error('原空间图标观察失败') })
  await open('space', f)
  await vi.waitFor(() => expect(notice()).toBeDefined())
  expect((await reveal()).textContent).toContain('原空间图标观察失败')
  const reads = (f.client.forwardRpc as any).mock.calls.filter(([name, params]: any[]) => name === 'space.inspect' && params?.target?.spaceId === spaceId).length
  await act(async () => f.emit({ type: 'agent-session', session: { ...f.sessions.get(sid)!, run: { runId: 'run-next' } } } as any))
  expect(notice().textContent).toContain('原空间图标观察失败')
  expect((f.client.forwardRpc as any).mock.calls.filter(([name, params]: any[]) => name === 'space.inspect' && params?.target?.spaceId === spaceId)).toHaveLength(reads)
  expect(f.submit).not.toHaveBeenCalled()
})

it('retains a confirmed Space image across an Agent Run change without a second static observation', async () => {
  const imageUrl = 'data:image/png;base64,c3BhY2U='
  const f = originalClient('space', async () => ({ catalog: { ...emptyCatalog, appearance: [{ spaceId, image: { revision: 'space-image', dataUrl: imageUrl } }] } }))
  const view = await open('space', f)
  const image = () => view.element.querySelector<HTMLImageElement>('.mobile-session-toolbar .mobile-space-icon img')
  await vi.waitFor(() => expect(image()?.getAttribute('src')).toBe(imageUrl))
  const reads = (f.client.forwardRpc as any).mock.calls.filter(([name, params]: any[]) => name === 'space.inspect' && params?.target?.spaceId === spaceId).length
  await act(async () => f.emit({ type: 'agent-session', session: { ...f.sessions.get(sid)!, run: { runId: 'run-next' } } } as any))
  expect(image()?.getAttribute('src')).toBe(imageUrl)
  expect((f.client.forwardRpc as any).mock.calls.filter(([name, params]: any[]) => name === 'space.inspect' && params?.target?.spaceId === spaceId)).toHaveLength(reads)
  expect(f.submit).not.toHaveBeenCalled()
})

it.each([
  { moteName: '原 Mote 名', expected: '原 Mote 名' },
  { moteName: undefined, expected: 'Mote 名称未确认' }
])('labels the Mote appearance failure as $expected without misidentifying the Agent conversation', async ({ moteName, expected }) => {
  const f = originalClient('mote', async () => { throw Error('原 Mote 头像观察失败') })
  const initial = presentation('mote')
  await getDeviceWorkface().updatePresentation({ selectedSessionId: sid, hostUrl: '', panel: 'conversation' },
    { ...initial, identity: { ...initial.identity, name: '不同的 Agent 会话名', mote: { spaceId, ...(moteName ? { name: moteName } : {}) } } })
  await mount(<MobileApp client={f.client} connection={connected} platform={createBrowserPlatform()} native />)
  await vi.waitFor(() => expect(notice()).toBeDefined())
  const item = notice(), summary = item.querySelector('summary')!
  expect(summary.textContent).toBe(`头像外观未确认 · ${expected}`)
  expect(summary.textContent).not.toContain('不同的 Agent 会话名')
  await click(summary)
  expect(item.textContent).toContain('原 Mote 头像观察失败')
  expect(button(item, '重新读取头像')).toBeDefined()
  expect(f.submit).not.toHaveBeenCalled()
})
