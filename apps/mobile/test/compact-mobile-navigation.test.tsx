import './mobile-lan-crypto.setup'
import { act } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { MobileApp } from '../src/MobileApp'
import { createBrowserPlatform } from '../src/platform/browser'
import { emptyDeviceWorkface, getDeviceWorkface } from '../src/recovery/device-workface'
import { button, click, editor, fixture, mount, mounted, paste } from './conversation-fixture'
import { openPrimary } from './mobile-root-navigation'
const viewport = { matches: true, addEventListener() {}, removeEventListener() {} }
const connected = { state: 'connected' as const, message: '原 Host' }
const place = { spaceId: 'space-original', zoneId: 'zone-original', workspaceId: 'workspace-original', displayWorkspaceId: 'display-original', groupId: 'group-original', tabId: 'tab-original', regionId: 'region-original' }
const title = 'Sample Project 业务协作与代码审查'
function setup() {
  const f = fixture(), catalog = { spaces: [{ spaceId: place.spaceId, kind: 'folder', name: 'Original Project', hostId: 'host-original', directoryPath: f.sessions.get('session-original')!.workspacePath, projectId: null }],
    zones: [{ zoneId: place.zoneId, workspaceId: place.workspaceId, kind: 'directory', hostId: 'host-original', directoryPath: f.sessions.get('session-original')!.workspacePath, branch: null }],
    bindings: [{ spaceId: place.spaceId, zoneId: place.zoneId }], tabs: [{ tabId: place.tabId, zoneId: place.zoneId, workspaceId: place.workspaceId, name: 'Original workface', regionIds: [place.regionId] }],
    regions: [{ tabId: place.tabId, regionId: place.regionId, kind: 'agent', agentSessionId: 'session-original', runId: 'run-original', execution: { hostId: 'host-original', cwd: f.sessions.get('session-original')!.workspacePath } }],
    locations: [place], agentPresentation: [{ agentSessionId: 'session-original', providerId: 'codex', name: title, project: 'Original Project', projectGroup: { key: 'project-original', hostId: 'host-original', name: 'Original Project' }, state: 'working', stateMark: 'working', group: 'working', lastActivityAt: 1000, recap: { text: '保留原上下文与未确认输入', source: 'native-hook' } }] }
  f.client.forwardRpc = vi.fn().mockImplementation(async method => {
    if (method === 'space.ls' || method === 'space.inspect') return { catalog: structuredClone(catalog) }
    if (method === 'goal.ls') return { goals: [] }
    if (method === 'topic.category.ls') return { categories: [], unavailable: [] }
    if (method === 'app.snapshot') return { agents: [] }
    throw Error('Unconfigured read: ' + method)
  })
  return { ...f, catalog }
}
async function wait(check: () => void) { await vi.waitFor(async () => { await act(async () => {}); check() }, { timeout: 4000, interval: 10 }) }
async function open(configure?: (value: ReturnType<typeof setup>) => void) {
  const f = setup(); configure?.(f)
  const owner = getDeviceWorkface()
  await owner.updatePresentation({ selectedSessionId: 'session-original', hostUrl: '', panel: 'conversation' }, { primary: 'focus', showSession: true, showGoalWork: false, identity: { name: title, project: 'Original Project' }, profile: null })
  const view = await mount(<MobileApp client={f.client} connection={connected} platform={createBrowserPlatform()} restoreWorkface />)
  await wait(() => expect(view.element.querySelector('.mobile-focus-facet .mobile-agent-row')).not.toBeNull())
  return { ...f, ...view }
}
beforeEach(async () => { vi.stubGlobal('matchMedia', () => viewport); window.history.replaceState(null, ''); localStorage.clear(); await getDeviceWorkface().replaceBackup(emptyDeviceWorkface()) })
afterEach(async () => { for (const view of mounted.splice(0)) { await act(async () => view.root.unmount()); view.element.remove() }; vi.restoreAllMocks(); vi.unstubAllGlobals() })

it('compact row keeps title alone above time and shows its typed semantic avatar mark', async () => {
  const f = await open(), row = f.element.querySelector<HTMLElement>('.mobile-focus-facet .mobile-agent-row')!
  expect(row.querySelector('.mobile-row-title')?.textContent).toBe(title)
  expect(row.querySelector('.mobile-row-title time')).toBeNull(); expect(row.querySelector('.mobile-row-detail time')).not.toBeNull()
  expect(row.querySelector('.mobile-row-dot'), 'avatar state must use the original semantic icon instead of a color dot').toBeNull()
  expect(row.querySelector('.mobile-row-avatar [data-focus-state-icon]')?.getAttribute('data-focus-state-icon')).toBe('working')
  expect(row.querySelector('.mobile-agent-locations-entry')).toBeNull()
  expect(f.submit).not.toHaveBeenCalled()
})

it('compact More keeps the original location chooser and exact tuple without remounting the draft', async () => {
  const f = await open(), original = editor(f.element)
  await paste(f.element, '原菜单前的草稿')
  await click(button(f.element, title + ' · 更多操作'))
  const entry = document.querySelector<HTMLButtonElement>('[role=dialog] .mobile-agent-locations-entry')
  expect(entry, 'original positions stay reachable through More').not.toBeNull()
  expect(entry!.textContent).toContain('查看展示位置'); await click(entry!)
  expect(document.querySelector('.mobile-sheet--underlay')).not.toBeNull()
  await click(button(document.body, '关闭位置选择'))
  expect(document.querySelector('.mobile-sheet--underlay')).toBeNull(); expect(entry!.isConnected).toBe(true)
  await click(entry!)
  const sheet = document.querySelector<HTMLElement>('.mobile-agent-locations-sheet')!
  await click(sheet.querySelector<HTMLButtonElement>('.mobile-agent-location > button')!)
  await wait(() => expect(getDeviceWorkface().snapshot().record.presentation?.identity?.context).toEqual(place))
  expect(f.client.forwardRpc).toHaveBeenCalledWith('space.inspect', { target: { spaceId: place.spaceId, zoneId: place.zoneId, displayWorkspaceId: place.displayWorkspaceId, groupId: place.groupId, tabId: place.tabId, regionId: place.regionId }, presentation: true })
  expect(editor(f.element)).toBe(original); expect(original.textContent).toBe('原菜单前的草稿')
  expect(f.submit).not.toHaveBeenCalled(); expect(f.signalAgent).not.toHaveBeenCalled()
})

it('compact wide shell remains wide after Back and original primary navigation without a second Focus owner', async () => {
  const f = await open(), original = editor(f.element)
  await paste(f.element, '返回仍保留的草稿')
  await click(button(f.element, '返回 Focus'))
  expect(f.element.querySelector('.mobile-app')?.hasAttribute('data-wide-shell'), 'Back must retain the wide shell independently of the selected work panel').toBe(true)
  expect(f.element.querySelectorAll('.mobile-focus-facet')).toHaveLength(1)
  expect(f.element.querySelector('.mobile-focus-pane')?.getAttribute('role')).toBe('main')
  await openPrimary(f.element, 'Space')
  expect(f.element.querySelector('.mobile-app')?.hasAttribute('data-wide-shell')).toBe(true)
  await openPrimary(f.element, 'Focus')
  await click(f.element.querySelector<HTMLButtonElement>('.mobile-focus-facet .mobile-agent-row__open')!)
  expect(editor(f.element)).toBe(original); expect(original.textContent).toBe('返回仍保留的草稿')
  expect(f.submit).not.toHaveBeenCalled(); expect(f.signalAgent).not.toHaveBeenCalled()
})


it('compact ordinary unknown leaves its original cause in More while keeping a semantic unknown badge', async () => {
  const f = await open(f => Object.assign(f.catalog.agentPresentation[0]!, { state: 'running', stateMark: 'unknown', group: 'idle', presenceUnknown: true, detail: 'original-observation-unavailable', recap: null, projectGroup: undefined }))
  const row = f.element.querySelector('.mobile-focus-facet .mobile-agent-row')!
  expect(row.textContent).not.toContain('original-observation-unavailable')
  expect(row.querySelector('[data-focus-state-icon]')?.getAttribute('data-focus-state-icon')).toBe('unknown')
  expect(row.querySelector('[data-semantic-icon="status.presence-unknown"]')).not.toBeNull()
  await click(button(f.element, title + ' · 更多操作'))
  expect(document.querySelector('[role=dialog]')?.textContent).toContain('Original Project')
  expect(document.querySelector('.mobile-agent-status-details')?.textContent).toContain('original-observation-unavailable')
  expect(f.submit).not.toHaveBeenCalled()
})

it.each(['close','target'] as const)('compact location late reply after %s cannot change the original workface', async change => {
  const f = await open(f => { f.catalog.agentPresentation.push({ ...f.catalog.agentPresentation[0]!, agentSessionId: 'other', name: 'Other Agent' }) })
  await click(button(f.element, title + ' · 更多操作')); await click(document.querySelector('.mobile-agent-locations-entry')!)
  let resolve!: (value: unknown) => void
  const original = f.client.forwardRpc!
  f.client.forwardRpc = vi.fn().mockImplementation((method,input) => method === 'space.inspect' ? new Promise(accept=>{resolve=accept}) : original(method,input))
  await click(document.querySelector('.mobile-agent-location > button')!)
  await click(button(document.body, '关闭位置选择')); await click(button(document.body, '关闭面板'))
  if(change==='target') await click(button(f.element,'Other Agent · 更多操作'))
  await act(async()=>resolve({catalog:f.catalog}))
  expect(getDeviceWorkface().snapshot().record.presentation?.identity?.context).toBeUndefined()
  expect(getDeviceWorkface().snapshot().record.selectedSessionId).toBe('session-original')
  expect(f.submit).not.toHaveBeenCalled(); expect(f.signalAgent).not.toHaveBeenCalled()
})


it('compact browser Back leaves the position layer first and retains More until the second Back', async () => {
  const f = await open(), original = editor(f.element)
  await paste(f.element,'浏览器返回仍保原草稿')
  await click(button(f.element,title+' · 更多操作'))
  const entry=document.querySelector<HTMLButtonElement>('.mobile-agent-locations-entry')!
  await click(entry)
  const boundary=window.history.state.agentmuxMobileBack
  await act(async()=>window.history.back())
  await wait(()=>expect(document.querySelector('.mobile-agent-locations-sheet')).toBeNull())
  expect(document.querySelector('.mobile-sheet--agent')).not.toBeNull(); expect(entry.isConnected).toBe(true)
  expect(document.querySelector('.mobile-sheet--underlay')).toBeNull()
  await wait(()=>expect(window.history.state.agentmuxMobileBack).toBe(boundary))
  await act(async()=>window.history.back())
  await wait(()=>expect(document.querySelector('.mobile-sheet--agent')).toBeNull())
  expect(editor(f.element)).toBe(original); expect(original.textContent).toBe('浏览器返回仍保原草稿')
  expect(getDeviceWorkface().snapshot().record.selectedSessionId).toBe('session-original')
  expect(f.submit).not.toHaveBeenCalled(); expect(f.signalAgent).not.toHaveBeenCalled()
})
