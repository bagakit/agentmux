import { fixturePath } from '../../../test/fixture-values.mjs'
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MobileApp } from '../src/MobileApp'
import { createBrowserPlatform } from '../src/platform/browser'
import { emptyDeviceWorkface, getDeviceWorkface } from '../src/recovery/device-workface'
import { button, click, editor, fixture, mount, mounted } from './conversation-fixture'
const connection = { state: 'connected' as const, message: '已连接 Mac' }
const catalog = { spaces: [{ spaceId: 'space', kind: 'folder', name: 'Actual Space', hostId: 'host-original', directoryPath: fixturePath("unrelated"), projectId: null }],
  zones: [], tabs: [{ tabId: 'tab', zoneId: 'zone', workspaceId: 'workspace', name: 'Original Agent', regionIds: ['region'] }],
  regions: [{ regionId: 'region', tabId: 'tab', kind: 'agent', agentSessionId: 'session-original', runId: 'run-original', execution: { hostId: 'host-original', cwd: fixturePath("workspace") } }],
  bindings: [{ spaceId: 'space', zoneId: 'zone' }], locations: [{ spaceId: 'space', zoneId: 'zone', workspaceId: 'workspace', displayWorkspaceId: 'workspace', groupId: 'group', tabId: 'tab', regionId: 'region' }] }
beforeEach(async () => { localStorage.clear(); await getDeviceWorkface().replaceBackup(emptyDeviceWorkface()) })
afterEach(async () => { for (const item of mounted.splice(0)) { await act(async () => item.root.unmount()); item.element.remove() }; document.body.replaceChildren(); vi.restoreAllMocks() })
describe('mobile production workspace navigation', () => {
  it('opens the configured Space through actual bindings, keeps shared conversation mounted and removes history controls', async () => {
    localStorage.setItem('agentmux-mobile-home', 'space')
    const f = fixture(); f.client.forwardRpc = vi.fn().mockImplementation(async (method: string) => method === 'app.snapshot' ? { agents: [] } : method === 'agent.inspect' ? { session: f.client.agentSession('session-original'), displayName: { override: null, availability: 'observed' } } : { catalog })
    const view = await mount(<MobileApp client={f.client} connection={connection} platform={createBrowserPlatform()} />)
    expect(view.element.querySelector('h1')?.textContent).toBe('Space')
    expect(view.element.querySelector('.mobile-connect-page')).toBeNull()
    const space = [...view.element.querySelectorAll<HTMLButtonElement>('.mobile-session-list button')].find(item => item.textContent?.includes('Actual Space'))!
    await click(space)
    await click(view.element.querySelector<HTMLButtonElement>('.mobile-spatial-tab .mobile-session-list button')!)
    expect(view.element.querySelector('[data-agent-session-id]')?.getAttribute('data-agent-session-id')).toBe('session-original')
    expect(view.element.querySelector('.mobile-conversation__window')).toBeNull()
    expect(view.element.querySelector('.conversation-native-thread__source')).toBeNull()
    const input = editor(view.element)
    await view.render(<MobileApp client={null} connection={{ state: 'disconnected', message: 'Connection unavailable' }} platform={createBrowserPlatform()} />)
    expect(editor(view.element)).toBe(input)
    expect(view.element.querySelector('.mobile-conversation-panel')?.hasAttribute('hidden')).toBe(false)
    expect(view.element.querySelector('.mobile-connect-page')).toBeNull()
    await click(button(view.element.querySelector('.mobile-session-toolbar') as HTMLElement, 'Space'))
    expect(editor(view.element)).toBe(input)
    expect(f.disposeHistory).toHaveBeenCalled()
    expect(f.submit).not.toHaveBeenCalled()
  })
  it('shows authoritative project and Agent name separately from provider and opens the original Mote directly', async () => {
    localStorage.setItem('agentmux-mobile-home', 'focus')
    const f = fixture()
    Object.assign(f.client.agentSession('session-original'), { semanticStatus: { state: 'working' } })
    const originalCatalog = { ...catalog, spaces: [{ ...catalog.spaces[0], kind: 'mote', name: 'Original Mote' }],
      agentPresentation: [{ agentSessionId: 'session-original', name: 'Chosen Agent', project: 'Original Project', group: 'working', state: 'working', detail: '执行中', providerId: 'codex', recap: { text: '原回复摘要', source: 'native-hook' } }],
      appearance: [{ spaceId: 'space', parts: { kind: 'face', shape: 'soft', palette: 'mint', eyes: 'round', brows: 'soft', mouth: 'smile', accessory: 'tuft' } }],
      motePresentation: [{ spaceId: 'space', content: null,
        quickMode: { status: 'saved', version: 'original-preferences', defaults: { conversation: { hostId: 'host-original', sessionId: 'session-original', displayWorkspaceId: 'workspace', groupId: 'group', tabId: 'tab', regionId: 'region' } } },
        conversation: { hostId: 'host-original', sessionId: 'session-original', displayWorkspaceId: 'workspace', groupId: 'group', tabId: 'tab', regionId: 'region' } }] }
    f.client.forwardRpc = vi.fn().mockImplementation(async (method: string, params: any) => method === 'app.snapshot'
      ? { agents: [{ agentSessionId: 'session-original', projectName: 'Original Project' }] }
      : method === 'agent.inspect' ? { session: f.client.agentSession(params.target.agentSessionId), displayName: { override: 'Chosen Agent', availability: 'observed' } }
      : { catalog: originalCatalog })
    const overlay = document.createElement('div'); document.body.append(overlay)
    const view = await mount(<MobileApp client={f.client} connection={connection} platform={createBrowserPlatform({ overlayContainer: () => overlay })} />)
    const row = [...view.element.querySelectorAll<HTMLButtonElement>('.mobile-session-list button')].find(item => item.textContent?.includes('Original Project'))!
    expect(row.textContent).toContain('Chosen Agent')
    expect(row.textContent).toContain('执行中')
    expect(row.textContent).toContain('codex')
    expect(row.textContent).not.toContain(fixturePath("workspace"))
    await click(button(view.element.querySelector('.mobile-navigation') as HTMLElement, 'Mote'))
    await click(view.element.querySelector<HTMLButtonElement>('.mobile-spatial-panel > .mobile-session-list button')!)
    expect(view.element.querySelector('[data-agent-session-id]')?.getAttribute('data-agent-session-id')).toBe('session-original')
    expect(view.element.querySelector('.mobile-mote-heading strong')).toBeNull()
    expect(view.element.querySelector('.mobile-mote-heading')?.getAttribute('aria-label')).toContain('Original Mote')
    expect(view.element.querySelector('.mobile-mote-heading .mote-face')).not.toBeNull()
    const input = editor(view.element)
    await click(button(view.element, '手机设置与连接'))
    expect(overlay.querySelector('.mobile-drawer')).not.toBeNull()
    expect(editor(view.element)).toBe(input)
    await click(button(overlay, '关闭面板'))
    expect(editor(view.element)).toBe(input)
    expect(f.submit).not.toHaveBeenCalled()
  })
  it('does not claim or persist a new home when its preference write fails', async () => {
    localStorage.setItem('agentmux-mobile-home', 'space')
    const f = fixture(); f.client.forwardRpc = vi.fn().mockImplementation(async (method: string) => method === 'app.snapshot' ? { agents: [] } : method === 'agent.inspect' ? { session: f.client.agentSession('session-original'), displayName: { override: null, availability: 'observed' } } : { catalog })
    const overlay = document.createElement('div'); document.body.append(overlay)
    const view = await mount(<MobileApp client={f.client} connection={connection} platform={createBrowserPlatform({ overlayContainer: () => overlay })} />)
    await click(button(view.element, '手机设置与连接'))
    vi.spyOn(localStorage, 'setItem').mockImplementation(() => { throw new Error('storage unavailable') })
    await act(async () => { const select = overlay.querySelector<HTMLSelectElement>('select')!; select.value = 'mote'; select.dispatchEvent(new Event('change', { bubbles: true })) })
    expect(overlay.textContent).toContain('默认主页未保存')
    expect(localStorage.getItem('agentmux-mobile-home')).toBe('space')
    expect(overlay.querySelector<HTMLSelectElement>('select')?.value).toBe('space')
  })
})


it('keeps the locally selected Topic across a Session round trip after an external Topic deep link', async () => {
  const f = fixture(), overlay = document.createElement('div'); document.body.append(overlay)
  const category = { categoryId: 'category', title: '分类', hostId: 'host-original', spaceId: 'category-space', directoryPath: fixturePath("category"), revision: 'revision' }
  const topicA = { topicId: 'topic-a', title: 'Topic A', summary: '', hostId: 'host-original', zoneId: 'zone-a', directoryPath: fixturePath("a"), categorySpaceIds: ['category-space'], chatIds: ['tab-a'], spatialRevision: 1 }
  const topicB = { ...topicA, topicId: 'topic-b', title: 'Topic B', zoneId: 'zone-b', directoryPath: fixturePath("b"), chatIds: ['tab-b'] }
  const original = { ...catalog, spaces: [{ ...catalog.spaces[0], kind: 'topic', topicId: topicA.topicId, name: '外部 Topic A' }],
    survey: { items: [{ zoneId: 'zone', name: '原研究' }], selection: { zoneId: 'zone', selection: [], active: null } },
    agentPresentation: [{ agentSessionId: 'session-original', name: '原讨论 Agent', project: '原项目', detail: '', group: 'working', state: 'working', providerId: 'codex', recap: null }] }
  f.client.forwardRpc = vi.fn().mockImplementation(async (method: string, params: any) => {
    if (method === 'topic.inspect') return { topic: params.topicId === topicB.topicId ? topicB : topicA, unavailable: [] }
    if (method === 'topic.category.ls') return { categories: [category], unavailable: [] }
    if (method === 'topic.ls') return { topics: [topicA, topicB], unavailable: [] }
    if (method === 'space.ls' && params.target.zoneId === 'zone-b') return { catalog: { ...original, tabs: [{ ...catalog.tabs[0], tabId: 'tab-b', zoneId: 'zone-b' }], regions: [{ ...catalog.regions[0], tabId: 'tab-b' }] } }
    return { catalog: original }
  })
  const view = await mount(<MobileApp client={f.client} connection={connection} platform={createBrowserPlatform({ overlayContainer: () => overlay })} />)
  await click(button(view.element, '手机设置与连接')); await click(button(overlay, 'Survey研究与笔记'))
  await click(button(view.element.querySelector('.mobile-survey') as HTMLElement, '外部 Topic A'))
  const topics = view.element.querySelector('.mobile-topics') as HTMLElement
  expect(topics.querySelector('h1')?.textContent).toBe('Topic A')
  await click(topics.querySelector<HTMLButtonElement>('[aria-label="返回分类目录"]')!)
  await click(button(topics, '分类')); await click(button(topics, 'Topic B'))
  expect(topics.querySelector('h1')?.textContent).toBe('Topic B')
  await click([...topics.querySelectorAll<HTMLButtonElement>('.mobile-topic-workface button')].find(value => value.textContent?.includes('原讨论 Agent'))!)
  expect(view.element.querySelector('.mobile-conversation-panel')?.hasAttribute('hidden')).toBe(false)
  await click(button(view.element.querySelector('.mobile-session-toolbar') as HTMLElement, 'Topics'))
  expect(topics.querySelector('h1')?.textContent).toBe('Topic B')
  expect(f.client.forwardRpc).toHaveBeenCalledWith('topic.inspect', { topicId: topicB.topicId })
  expect(f.client.forwardRpc).toHaveBeenCalledWith('space.ls', { target: { zoneId: 'zone-b' }, presentation: true })
  expect(f.submit).not.toHaveBeenCalled()
})

it('shows a presentation owner failure in a mounted directory without taking away its healthy Session', async () => {
  localStorage.setItem('agentmux-mobile-home', 'space')
  const f = fixture()
  const failed = { ...catalog, spaces: [{ ...catalog.spaces[0], issue: '原头像读取失败：appearance owner unavailable；可刷新重试' }] }
  f.client.forwardRpc = vi.fn().mockResolvedValue({ catalog: failed })
  const view = await mount(<MobileApp client={f.client} connection={connection} platform={createBrowserPlatform()} />)
  expect(view.element.textContent).toContain('appearance owner unavailable')
  expect(button(view.element, '刷新原呈现')).toBeDefined()
  await click([...view.element.querySelectorAll<HTMLButtonElement>('.mobile-session-list button')].find(value => value.textContent?.includes('Actual Space'))!)
  await click(view.element.querySelector<HTMLButtonElement>('.mobile-spatial-tab .mobile-session-list button')!)
  expect(view.element.querySelector('[data-agent-session-id]')?.getAttribute('data-agent-session-id')).toBe('session-original')
})
