const { fixtureEpoch: _reshape_fixtureEpoch } = await vi.hoisted(async () => await import("../../../test/fixture-values.mjs"))
import { fixturePath } from '../../../test/fixture-values.mjs'
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MobileApp } from '../src/MobileApp'
import { createBrowserPlatform } from '../src/platform/browser'
import { emptyDeviceWorkface, getDeviceWorkface } from '../src/recovery/device-workface'
import { freezeMobileGoalUpdateRequest } from '../src/recovery/goal-drafts'
import { openTreeSession, button, click, deferred, editor, fixture, mount, mounted, paste } from './conversation-fixture'
const native = vi.hoisted(() => ({ back: null as (() => void) | null }))
vi.mock('../src/platform/native/device', async importOriginal => ({ ...await importOriginal<Record<string, unknown>>(),
  bindNativeDevice: vi.fn((options: { onBack(): void }) => { native.back = options.onBack; return { dispose: async () => { native.back = null } } }) }))

const connected = { state: 'connected' as const, message: 'Connected to the original Host' }
const order = ['Goals', 'Topics', 'Mote', 'Focus', 'Space']
function originalClient() {
  const f = fixture()
  const catalog = {
    spaces: [{ spaceId: 'original-mote', kind: 'mote', name: 'Original Mote', hostId: 'host-original', directoryPath: fixturePath("workspace"), projectId: null }],
    zones: [{ zoneId: 'original-zone', workspaceId: 'original-workspace', hostId: 'host-original', directoryPath: fixturePath("workspace"), kind: 'home', branch: null }],
    tabs: [{ tabId: 'original-tab', zoneId: 'original-zone', workspaceId: 'original-workspace', name: 'Original Agent', regionIds: ['original-region'] }],
    regions: [{ regionId: 'original-region', tabId: 'original-tab', kind: 'agent', agentSessionId: 'session-original', runId: 'run-original', execution: { hostId: 'host-original', cwd: fixturePath("workspace") } }],
    bindings: [{ spaceId: 'original-mote', zoneId: 'original-zone' }], locations: [{ spaceId: 'original-mote', zoneId: 'original-zone', workspaceId: 'original-workspace', displayWorkspaceId: 'original-workspace', groupId: 'original-zone', tabId: 'original-tab', regionId: 'original-region' }],
    agentPresentation: [{ agentSessionId: 'session-original', name: 'Original Agent', project: 'Original Project', group: 'working', state: 'working', detail: 'Working', providerId: 'codex', recap: null }],
    motePresentation: [{ spaceId: 'original-mote', content: { zoneId: 'original-zone', hostId: 'host-original', workspaceId: 'original-workspace', workspacePath: fixturePath("workspace") },
      quickMode: { status: 'saved', version: 'source-original', defaults: { conversation: { hostId: 'host-original', sessionId: 'session-original', displayWorkspaceId: 'original-workspace', groupId: 'original-zone', tabId: 'original-tab', regionId: 'original-region' } } },
      conversation: { hostId: 'host-original', sessionId: 'session-original', displayWorkspaceId: 'original-workspace', groupId: 'original-zone', tabId: 'original-tab', regionId: 'original-region' } }]
  }
  f.client.forwardRpc = vi.fn().mockImplementation(async (method: string, params: any) => {
    if (method === 'file.read') return { resource: { ...params.expectedResource, zoneId: params.zoneId, zonePath: params.expectedResource.workspacePath, path: params.path }, result: { status: 'read', document: { path: params.path, content: '# 原合作方式\n原依据保留。', revision: 'sha256:' + 'a'.repeat(64) } } }
    if (method === 'goal.ls') return { goals: [], unavailable: [] }
    if (method === 'topic.category.ls') return { categories: [], unavailable: [] }
    if (method === 'topic.ls') return { topics: [], unavailable: [] }
    if (method === 'app.snapshot') return { agents: [], workspaces: [], projects: [], executors: [], unavailable: [] }
    return { catalog }
  })
  return f
}
function nav(element: HTMLElement) { return element.querySelector<HTMLElement>('.mobile-navigation')! }
function current(element: HTMLElement) { return nav(element).querySelector('[aria-current="page"]')?.textContent }
beforeEach(async () => { localStorage.clear(); await getDeviceWorkface().replaceBackup(emptyDeviceWorkface()) })
afterEach(async () => {
  for (const item of mounted.splice(0)) { await act(async () => item.root.unmount()); item.element.remove() }
  document.body.replaceChildren(); vi.restoreAllMocks()
})

describe('actual phone primary workfaces', () => {
  it('cold restores original Goal edit refs/body/unknown without reseeding and keeps the same editor through all five workfaces', async () => {
    const f = originalClient()
    const owner = getDeviceWorkface()
    const scope = { origin: location.origin, runtimeId: 'original-goal-runtime', deviceHostId: null }
    const request = freezeMobileGoalUpdateRequest({ goalId: 'original-goal', operationId: 'original-unknown-save', expectedUpdatedAt: _reshape_fixtureEpoch(0, 0, 7), patch: { description: '原未知保存正文' } })
    await owner.updatePresentation({ selectedSessionId: null, hostUrl: '', panel: 'conversation' }, { primary: 'goals', showSession: false, showGoalWork: false, identity: null, profile: null,
      goals: { goalId: 'original-goal', mode: 'edit', discussion: null } })
    await owner.editGoalDraft(null, { goalId: 'original-goal', scope, title: '原目标', description: '离线仍可编辑的完整草稿', baseline: { title: '原目标', description: '原意', updatedAt: _reshape_fixtureEpoch(0, 0, 7) },
      operations: [{ request, ownerInstanceId: 'original-process', phase: 'sending', issue: null }] }, owner.recordIdentity())
    const originalRecordId = owner.recordIdentity()
    const view = await mount(<MobileApp client={null} connection={{ state: 'disconnected', message: '原Host离线' }} platform={createBrowserPlatform()} />)
    const input = view.element.querySelector<HTMLTextAreaElement>('[aria-label="目标正文草稿"]')!
    expect(input.value).toBe('离线仍可编辑的完整草稿')
    expect(view.element.textContent).toContain('原保存回执未确认')
    await view.render(<MobileApp client={f.client} connection={connected} platform={createBrowserPlatform()} />)
    for (const label of order) { await click(button(nav(view.element), label)); expect(view.element.querySelector('[aria-label="目标正文草稿"]')).toBe(input) }
    await click(button(nav(view.element), 'Goals'))
    expect(input.closest('[hidden]')).toBeNull()
    expect(owner.recordIdentity()).toBe(originalRecordId)
    expect(owner.snapshot().record.goalDrafts![0]!.operations[0]!.request).toEqual(request)
    expect(f.client.forwardRpc!.mock.calls.some(([method]: [string]) => ['goal.update', 'goal.start'].includes(method))).toBe(false)
    await act(async () => mounted.find(value => value.element === view.element)!.root.unmount())
    mounted.splice(mounted.findIndex(value => value.element === view.element), 1); view.element.remove()
    // No replaceBackup or new draft writes between real React process mounts.
    const restored = await mount(<MobileApp client={null} connection={{ state: 'disconnected', message: '原Host离线' }} platform={createBrowserPlatform()} />)
    expect(restored.element.querySelector<HTMLTextAreaElement>('[aria-label="目标正文草稿"]')?.value).toBe(input.value)
    expect(owner.recordIdentity()).toBe(originalRecordId)
    expect(owner.snapshot().record.presentation!.goals).toEqual({ goalId: 'original-goal', mode: 'edit', discussion: null })
  })

  it('toolbar return from the original Goal Agent discussion restores its exact Goal and body rather than a residual Tab zone', async () => {
    const f = originalClient(), original = f.client.forwardRpc!
    const goal = { id: 'original-goal', title: '原Goal', description: '原目标正文', status: 'backlog', priority: 'normal', sessionIds: ['session-original'], assigneeSessionIds: ['session-original'], supervisorSessionId: 'session-original', participations: [], activityLog: [], source: 'session', createdAt: _reshape_fixtureEpoch(0, 0, 1), updatedAt: _reshape_fixtureEpoch(0, 0, 7) }
    f.client.runtimeOwnerIdentity = () => ({ runtimeId: 'original-runtime', ownerInstanceId: 'original-process', availability: 'connected' })
    f.client.forwardRpc = vi.fn(async (method, params) => {
      if (method === 'goal.ls') return { goals: [goal] }
      if (method === 'goal.inspect') return { goal, goalContinuations: [] }
      if (method === 'goal.decisions') return { goalId: goal.id, decisions: [] }
      if (method === 'goal.discuss') return { goal, receipt: { goalId: goal.id, tabId: 'original-tab', agentSessionId: 'session-original', mode: params.mode, operationId: params.operationId } }
      return original(method, params)
    }) as any
    const view = await mount(<MobileApp client={f.client} connection={connected} platform={createBrowserPlatform()} />)
    await click(button(nav(view.element), 'Goals')); await click(view.element.querySelector('.mobile-goals-list button')!)
    await click(button(view.element, '打开目标原讨论'))
    expect(view.element.querySelector('.mobile-session-toolbar')).not.toBeNull()
    expect(getDeviceWorkface().snapshot().record.presentation!.goals!.discussion).toEqual({ goalId: goal.id, tabId: 'original-tab', agentSessionId: 'session-original' })
    await click(view.element.querySelector('.mobile-session-toolbar button')!)
    expect(view.element.querySelector('.mobile-session-toolbar')).toBeNull()
    const article = view.element.querySelector('[aria-label="目标详情"]')!
    expect(article.closest('[hidden]')).toBeNull(); expect(article.textContent).toContain('原目标正文')
    expect(getDeviceWorkface().snapshot().record.presentation!.goals).toEqual({ goalId: goal.id, mode: 'detail', discussion: null })
    expect(f.submit).not.toHaveBeenCalled()
  })
  it('directly opens all five original surfaces in order and keeps auxiliary work in the actual menu', async () => {
    const f = originalClient(), overlay = document.createElement('div'); document.body.append(overlay)
    const view = await mount(<MobileApp client={f.client} connection={connected} platform={createBrowserPlatform({ overlayContainer: () => overlay })} />)
    expect([...nav(view.element).querySelectorAll('button')].map(value => value.textContent)).toEqual(order)
    for (const label of order) {
      await click(button(nav(view.element), label)); expect(current(view.element)).toBe(label)
      const surface = label === 'Goals' ? '.mobile-goals' : label === 'Topics' ? '.mobile-topics' : '.mobile-spatial-panel'
      const body = view.element.querySelector<HTMLElement>(surface)!
      expect(body.closest('[hidden]')).toBeNull(); expect(body.querySelector('h1')?.textContent).toBe(label)
    }
    expect(f.client.forwardRpc).toHaveBeenCalledWith('goal.ls', { limit: 1000 })
    expect(f.client.forwardRpc).toHaveBeenCalledWith('topic.category.ls', {})
    expect(f.client.forwardRpc).toHaveBeenCalledWith('space.ls', { target: {}, presentation: true })
    await click(button(view.element, '手机设置与连接'))
    const menu = overlay.querySelector<HTMLElement>('.mobile-drawer-workfaces')!
    expect([...menu.querySelectorAll('button')].map(value => value.textContent)).toEqual(['Survey研究与笔记'])
    expect([...overlay.querySelectorAll('select option')].map(value => value.textContent)).toEqual(order)
    await click(button(menu, 'Survey研究与笔记'))
    expect(view.element.querySelector('.mobile-survey')?.closest('[hidden]')).toBeNull()
    expect(current(view.element)).toBeUndefined()
    expect(f.submit).not.toHaveBeenCalled()
  })

  it('retains the exact composer, draft and Session while switching every primary workface and returning to the original Mote', async () => {
    const f = originalClient(), platform = createBrowserPlatform()
    const view = await mount(<MobileApp client={f.client} connection={connected} platform={platform} />)
    await click(button(nav(view.element), 'Mote'))
    await openTreeSession(view.element)
    const originalEditor = editor(view.element)
    await paste(view.element, '原 Mote 的未保存草稿')
    expect(current(view.element)).toBe('Mote')
    for (const label of order) {
      await click(button(nav(view.element), label))
      expect(editor(view.element)).toBe(originalEditor)
      expect(originalEditor.textContent).toBe('原 Mote 的未保存草稿')
      expect(getDeviceWorkface().snapshot().record.selectedSessionId).toBe('session-original')
    }
    await click(button(nav(view.element), 'Mote'))
    await openTreeSession(view.element)
    expect(editor(view.element)).toBe(originalEditor)
    expect(view.element.querySelector('.mobile-mote-heading')).not.toBeNull()
    expect(view.element.querySelector('.mobile-conversation-panel')?.hasAttribute('hidden')).toBe(false)
    await view.render(<MobileApp client={null} connection={{ state: 'disconnected', message: 'Original Host connection interrupted' }} platform={platform} />)
    expect(editor(view.element)).toBe(originalEditor)
    expect(nav(view.element).querySelectorAll('button')).toHaveLength(5)
    expect(originalEditor.textContent).toBe('原 Mote 的未保存草稿')
    expect(f.submit).not.toHaveBeenCalled()
  })

  it('releases original conversation reading behind a sheet and resumes that owner only after closing it', async () => {
    const f = originalClient(), overlay = document.createElement('div'); document.body.append(overlay)
    const view = await mount(<MobileApp client={f.client} connection={connected} platform={createBrowserPlatform({ overlayContainer: () => overlay })} />)
    await click(button(nav(view.element), 'Mote'))
    await openTreeSession(view.element)
    const original = editor(view.element)
    await paste(view.element, '被面板遮住的原草稿')
    const releases = f.disposeHistory.mock.calls.length
    await click(view.element.querySelector('.mobile-mote-heading')!)
    expect(f.disposeHistory.mock.calls.length).toBe(releases + 1)
    const reads = f.readHistory.mock.calls.length
    await act(async () => f.emit({ type: 'agent-timeline', agentSessionId: 'session-original', revision: 9 } as any))
    expect(f.readHistory.mock.calls).toHaveLength(reads)
    expect(editor(view.element)).toBe(original)
    expect(original.textContent).toBe('被面板遮住的原草稿')
    await click(button(overlay, '关闭面板'))
    expect(f.readHistory.mock.calls.length).toBeGreaterThan(reads)
    expect(f.submit).not.toHaveBeenCalled(); expect(f.respond).not.toHaveBeenCalled()
  })

  it.each(['goals', 'topics', 'mote', 'focus', 'space'])('opens the saved %s home without changing its original record', async home => {
    localStorage.setItem('agentmux-mobile-home', home)
    const view = await mount(<MobileApp client={originalClient().client} connection={connected} platform={createBrowserPlatform()} />)
    expect(current(view.element)?.toLowerCase()).toBe(home)
    expect(localStorage.getItem('agentmux-mobile-home')).toBe(home)
  })

  it('keeps the Focus return context for a Mote member instead of applying the Mote-only conversation heading', async () => {
    const f = originalClient()
    const view = await mount(<MobileApp client={f.client} connection={connected} platform={createBrowserPlatform()} />)
    await click(button(nav(view.element), 'Focus'))
    await click(view.element.querySelector('.mobile-session-list button')!)
    expect(view.element.querySelector('.mobile-app')?.getAttribute('data-mobile-workface')).toBe('workspace')
    const toolbar = view.element.querySelector<HTMLElement>('.mobile-session-toolbar')!
    expect(toolbar.textContent).toContain('Focus')
    expect(toolbar.textContent).toContain('Original Agent')
    expect(view.element.querySelector('.mobile-mote-heading')).not.toBeNull()
    expect(f.submit).not.toHaveBeenCalled()
  })

  it('keeps the exact unknown input across the five workfaces without generating another dispatch', async () => {
    const f = originalClient()
    f.submit.mockRejectedValueOnce(new Error('Acknowledgement is unknown after dispatch'))
    const view = await mount(<MobileApp client={f.client} connection={connected} platform={createBrowserPlatform()} />)
    await click(button(nav(view.element), 'Mote'))
    await openTreeSession(view.element)
    await paste(view.element, '不能因为切换而重发的原输入')
    await click(button(view.element, 'Send'))
    const original = f.submit.mock.calls[0]![0]
    for (const label of order) await click(button(nav(view.element), label))
    await click(button(nav(view.element), 'Mote'))
    await openTreeSession(view.element)
    // The original-request retry remains reachable; navigation never authorizes it.
    expect(button(view.element, 'Send').disabled).toBe(false)
    expect(editor(view.element).textContent).toBe('不能因为切换而重发的原输入')
    expect(f.submit).toHaveBeenCalledTimes(1)
    const durable = getDeviceWorkface().snapshot().record.conversation!.attempts[0]![1]
    expect(durable.operationId).toBe(original.operationId)
    expect(durable.runId).toBe('run-original'); expect(durable.phase).toBe('unknown')
  })

  it('keeps an unreadable preference while all five healthy workfaces remain usable', async () => {
    localStorage.setItem('agentmux-mobile-home', 'unknown-original')
    const view = await mount(<MobileApp client={originalClient().client} connection={connected} platform={createBrowserPlatform()} />)
    await click(button(nav(view.element), 'Goals'))
    expect(current(view.element)).toBe('Goals')
    expect(localStorage.getItem('agentmux-mobile-home')).toBe('unknown-original')
  })

  it('does not let a late Survey Topic inspection replace the later chosen primary workface', async () => {
    const f = originalClient(), overlay = document.createElement('div'); document.body.append(overlay)
    const catalog = { spaces: [{ spaceId: 'topic-space', kind: 'topic', topicId: 'original-topic', name: 'Original Topic', hostId: 'host-original', directoryPath: fixturePath("workspace"), projectId: null }],
      zones: [{ zoneId: 'research-zone' }], tabs: [], regions: [], locations: [], bindings: [{ zoneId: 'research-zone', spaceId: 'topic-space' }],
      survey: { items: [{ zoneId: 'research-zone', name: 'Original Research' }], selection: { zoneId: 'research-zone', selection: [], active: null } } }
    const read = deferred<{ catalog: typeof catalog }>()
    const ordinary = f.client.forwardRpc!
    f.client.forwardRpc = vi.fn().mockImplementation((method, params) => method === 'space.inspect' ? read.promise
      : method === 'space.ls' ? Promise.resolve({ catalog }) : ordinary(method, params))
    const view = await mount(<MobileApp client={f.client} connection={connected} platform={createBrowserPlatform({ overlayContainer: () => overlay })} />)
    await click(button(view.element, '手机设置与连接')); await click(button(overlay, 'Survey研究与笔记'))
    await click(button(view.element.querySelector('.mobile-survey') as HTMLElement, 'Original Research原研究选择'))
    await click(button(view.element.querySelector('.mobile-survey') as HTMLElement, 'Original Topic'))
    expect(f.client.forwardRpc).toHaveBeenCalledWith('space.inspect', { target: { spaceId: 'topic-space' } })
    await click(button(nav(view.element), 'Goals'))
    await act(async () => read.resolve({ catalog }))
    expect(current(view.element)).toBe('Goals')
    expect(view.element.querySelector('.mobile-goals')?.closest('[hidden]')).toBeNull()
    expect(f.client.forwardRpc).not.toHaveBeenCalledWith('topic.inspect', { topicId: 'original-topic' })
    expect(f.submit).not.toHaveBeenCalled()
  })

  it.each(['browser', 'native'])('%s Back exits the original source, Profile, result and chat one layer at a time while keeping the same editor and input guard', async mode => {
    const f = originalClient(), overlay = document.createElement('div'); document.body.append(overlay)
    const view = await mount(<MobileApp client={f.client} connection={connected} native={mode === 'native'} platform={createBrowserPlatform({ overlayContainer: () => overlay })} />)
    await click(button(nav(view.element), 'Mote')); await openTreeSession(view.element)
    const originalEditor = editor(view.element)
    await paste(view.element, '逐层返回保留的原草稿')
    f.submit.mockRejectedValueOnce(new Error('original acknowledgement unknown'))
    await click(button(view.element, 'Send'))
    const original = f.submit.mock.calls[0]![0]
    await click(button(view.element, '当前对话操作')); await click(button(overlay, '目标与结果'))
    await click(view.element.querySelector('.mobile-mote-heading')!)
    await click(button(overlay, '合作方式 · BEHAVIOR.md'))
    expect(overlay.textContent).toContain('原依据保留')
    const back = async () => { await act(async () => {
      if (mode === 'native') native.back!(); else window.history.back()
      await new Promise(resolve => setTimeout(resolve, 20))
    }) }
    await back()
    expect(overlay.querySelector('.mobile-mote-source')).toBeNull()
    expect(overlay.querySelector('.mobile-mote-profile')).not.toBeNull()
    expect(view.element.querySelector('.mobile-goal-panel')?.hasAttribute('hidden')).toBe(false)
    await back()
    expect(overlay.querySelector('[role="dialog"]')).toBeNull()
    expect(view.element.querySelector('.mobile-goal-panel')?.hasAttribute('hidden')).toBe(false)
    await back()
    expect(view.element.querySelector('.mobile-conversation-panel')?.hasAttribute('hidden')).toBe(false)
    expect(editor(view.element)).toBe(originalEditor)
    expect(originalEditor.textContent).toBe('逐层返回保留的原草稿')
    await back()
    expect(view.element.querySelector('.mobile-conversation-panel')?.hasAttribute('hidden')).toBe(true)
    expect(current(view.element)).toBe('Mote')
    expect(editor(view.element)).toBe(originalEditor)
    expect(getDeviceWorkface().snapshot().record.conversation.attempts[0]![1]).toMatchObject({ operationId: original.operationId, runId: 'run-original', phase: 'unknown' })
    expect(f.submit).toHaveBeenCalledTimes(1); expect(f.respond).not.toHaveBeenCalled()
  })

  it('restores the original Profile source and exact occurrence while offline, then reconnects its pinned original file owner without automatic input', async () => {
    const f = originalClient(), overlay = document.createElement('div'); document.body.append(overlay)
    const platform = createBrowserPlatform({ overlayContainer: () => overlay })
    const view = await mount(<MobileApp client={f.client} connection={connected} platform={platform} />)
    await click(button(nav(view.element), 'Mote')); await openTreeSession(view.element)
    await paste(view.element, '刷新之前的原草稿')
    await click(view.element.querySelector('.mobile-mote-heading')!); await click(button(overlay, '合作方式 · BEHAVIOR.md'))
    const original = getDeviceWorkface().snapshot().record
    expect(original.presentation).toMatchObject({ primary: 'mote', showSession: true, profile: { sourcePath: 'BEHAVIOR.md' },
      identity: { context: { displayWorkspaceId: 'original-workspace', groupId: 'original-zone', tabId: 'original-tab', regionId: 'original-region' } } })
    expect(JSON.stringify(original.presentation)).not.toContain('quickMode')
    expect(JSON.stringify(original.presentation)).not.toContain('原依据保留')
    const prior = mounted.findIndex(item => item.element === view.element)
    await act(async () => mounted.splice(prior, 1)[0]!.root.unmount()); view.element.remove()
    // A new app instance reads the same device record, not a reseeded route.
    const restored = await mount(<MobileApp client={null} connection={{ state: 'disconnected', message: '原 Host 未连接' }} platform={platform} />)
    expect(current(restored.element)).toBe('Mote')
    expect(overlay.querySelector('.mobile-mote-source h3')?.textContent).toBe('BEHAVIOR.md')
    expect(editor(restored.element).textContent).toBe('刷新之前的原草稿')
    const rpc = f.client.forwardRpc as ReturnType<typeof vi.fn>; rpc.mockClear()
    await restored.render(<MobileApp client={f.client} connection={connected} platform={platform} />)
    expect(rpc).toHaveBeenCalledWith('file.read', { spaceId: 'original-mote', zoneId: 'original-zone', path: 'BEHAVIOR.md',
      expectedResource: { hostId: 'host-original', workspaceId: 'original-workspace', workspacePath: fixturePath("workspace") } })
    expect(overlay.textContent).toContain('原依据保留')
    expect(f.submit).not.toHaveBeenCalled(); expect(f.respond).not.toHaveBeenCalled()
  })
})
