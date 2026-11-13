// @vitest-environment happy-dom
import { act } from 'react'
import { beforeEach, expect, it, vi } from 'vitest'
import { createWorkspaceLayout } from '@agentmux/layout'
import type { AppConfig, HostConfig, WorkspaceRecord } from '../src/shared/contracts'
import { WorkspaceSidebar } from '../src/renderer/src/components/WorkspaceSidebar'
import { createWorkbenchTab } from '../src/renderer/src/lib/workbench-tabs'
import { api } from '../src/renderer/src/lib/api'
import { fileNavigationSelection, useAppStore } from '../src/renderer/src/store'
import { composerConfig, composerDOM, composerSession } from './helpers/composer-dom-fixture'
import { installNoteCanvasGeometry } from './helpers/note-canvas-dom'

const dom = composerDOM(), R = 'studio-mac'
const remote: HostConfig = { id: R, kind: 'ssh', label: 'Studio Mac', hostname: 'studio.invalid', runtimeId: 'original-runtime' }
const directory = '/Users/studio-user'
const home: WorkspaceRecord = { id: 'original-home', name: 'studio-user', hostId: R, path: directory, kind: 'folder' }
let config: AppConfig
beforeEach(() => {
  installNoteCanvasGeometry()
  config = { ...structuredClone(composerConfig), hosts: [composerConfig.hosts[0]!, remote] }
  useAppStore.setState({ config, activeWorkspaceId: 'workspace', mainSurface: 'workbench', workbenchSpaceSelection: null,
    layouts: {}, tabs: {}, sessions: [composerSession('healthy-agent')], collapsedProjectGroups: {}, projectGroups: [],
    agentComposerDrafts: { 'healthy-agent': 'Retain original draft' } })
  vi.spyOn(api.git, 'projectIdentity').mockImplementation(async id => ({ kind: 'not-repository', hostId: useAppStore.getState().config!.workspaces.find(item => item.id === id)!.hostId, workspacePath: directory } as never))
})
const mount = () => dom.render(<WorkspaceSidebar />)
const title = (id: string) => {
  const node = dom.container.querySelector<HTMLButtonElement>(`[data-folder-host="${id}"] .space-section-label`)
  expect(node).not.toBeNull(); return node!
}
const click = (id: string) => act(async () => { title(id).click() })
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done }); return { promise, resolve } }

it('device-title opens an empty remote Host home on demand without Git, scanning or automatically creating an Agent', async () => {
  const read = vi.spyOn(api.hosts, 'home').mockResolvedValue({ routeHostId: R, homeDirectory: directory })
  const add = vi.spyOn(api.workspaces, 'add').mockResolvedValue(home)
  const scan = vi.spyOn(api.files, 'readDirectory'), create = vi.spyOn(api.sessions, 'launchAgent')
  await mount()
  expect(title(R).disabled).toBe(false); expect(title(R).getAttribute('aria-label')).toBe('Open Studio Mac home')
  expect(read).not.toHaveBeenCalled(); expect(add).not.toHaveBeenCalled()
  await click(R)
  expect(read).toHaveBeenCalledExactlyOnceWith(remote)
  expect(add).toHaveBeenCalledExactlyOnceWith({ hostId: R, path: directory })
  const state = useAppStore.getState()
  expect(state.activeWorkspaceId).toBe(home.id)
  expect(state.config!.workspaces).toEqual([...config.workspaces, home])
  expect(state.layouts[home.id]?.groups).toHaveLength(1)
  expect(state.sessions).toEqual([composerSession('healthy-agent')])
  expect(state.agentComposerDrafts['healthy-agent']).toBe('Retain original draft')
  expect(scan).not.toHaveBeenCalled(); expect(create).not.toHaveBeenCalled()
})

it('already-registered home reuses its original Tab, Region, layout and drafts on repeat opens', async () => {
  const tab = createWorkbenchTab('retained-tab', { kind: 'agent', phase: 'attached', regionId: 'retained-region', workspaceId: home.id, sessionId: 'healthy-agent' })
  const layout = createWorkspaceLayout('retained-group', [tab.id])
  config.workspaces.push(home)
  useAppStore.setState({ config, tabs: { [tab.id]: tab }, layouts: { [home.id]: layout } })
  const read = vi.spyOn(api.hosts, 'home').mockResolvedValue({ routeHostId: R, homeDirectory: directory })
  const add = vi.spyOn(api.workspaces, 'add')
  await mount(); await click(R)
  await act(async () => useAppStore.getState().selectWorkspace('workspace'))
  await click(R)
  const state = useAppStore.getState()
  expect(state.layouts[home.id]).toBe(layout); expect(state.tabs[tab.id]).toBe(tab)
  expect(state.tabs[tab.id]!.layout.activeRegionId).toBe('retained-region')
  expect(state.activeWorkspaceId).toBe(home.id); expect(state.agentComposerDrafts['healthy-agent']).toBe('Retain original draft')
  expect(read).toHaveBeenCalledTimes(2); expect(add).not.toHaveBeenCalled()
})

it('equivalent existing home spellings consume the original registration owner receipt and retain that workface', async () => {
  const alias = { ...home, path: directory + '/' }
  const layout = createWorkspaceLayout('original-alias-group', ['retained-alias-tab'])
  config.workspaces.push(alias); useAppStore.setState({ config, layouts: { [home.id]: layout } })
  vi.spyOn(api.hosts, 'home').mockResolvedValue({ routeHostId: R, homeDirectory: directory })
  const add = vi.spyOn(api.workspaces, 'add').mockResolvedValue(alias)
  await mount(); await click(R)
  expect(add).toHaveBeenCalledExactlyOnceWith({ hostId: R, path: directory })
  expect(useAppStore.getState().activeWorkspaceId).toBe(home.id)
  expect(useAppStore.getState().layouts[home.id]).toBe(layout)
  expect(useAppStore.getState().config!.workspaces).toEqual(config.workspaces)
})

it('the local device name is usable with no projects and its home comes from the same original Host read', async () => {
  config = { ...config, hosts: [config.hosts[0]!], workspaces: [] }
  useAppStore.setState({ config, activeWorkspaceId: null, localHome: '/unrelated/display-only/home' })
  const local = { ...home, id: 'local-home', hostId: 'local', path: '/Users/original-local', name: 'original-local' }
  const read = vi.spyOn(api.hosts, 'home').mockResolvedValue({ routeHostId: 'local', homeDirectory: local.path })
  const add = vi.spyOn(api.workspaces, 'add').mockResolvedValue(local)
  await mount()
  expect(title('local').textContent).toContain('This Mac'); expect(title('local').disabled).toBe(false)
  await click('local')
  expect(read).toHaveBeenCalledExactlyOnceWith(config.hosts[0])
  expect(add).toHaveBeenCalledExactlyOnceWith({ hostId: 'local', path: local.path })
  expect(useAppStore.getState().activeWorkspaceId).toBe(local.id)
})

it('a failed home read stays beside its device, leaves original work available and allows an explicit retry', async () => {
  const read = vi.spyOn(api.hosts, 'home').mockRejectedValueOnce(new Error('Original Host is unavailable')).mockResolvedValue({ routeHostId: R, homeDirectory: directory })
  const add = vi.spyOn(api.workspaces, 'add').mockResolvedValue(home)
  await mount(); await click(R)
  const section = dom.container.querySelector(`[data-folder-host="${R}"]`)!
  expect(section.querySelector('[role="status"]')!.textContent).toContain('Reading device home: Original Host is unavailable')
  expect(useAppStore.getState().activeWorkspaceId).toBe('workspace')
  expect(useAppStore.getState().sessions).toHaveLength(1)
  expect(title('local').disabled).toBe(false); expect(add).not.toHaveBeenCalled()
  await act(async () => [...section.querySelectorAll<HTMLButtonElement>('button')].find(node => node.textContent === 'Retry')!.click())
  expect(read).toHaveBeenCalledTimes(2); expect(useAppStore.getState().activeWorkspaceId).toBe(home.id)
  expect(section.querySelector('[role="status"]')).toBeNull()
})

it('a late home reply cannot steal a later project or Tab selection, and busy state affects only its original device', async () => {
  const pending = deferred<{ routeHostId: string; homeDirectory: string }>()
  vi.spyOn(api.hosts, 'home').mockReturnValue(pending.promise)
  const add = vi.spyOn(api.workspaces, 'add')
  await mount(); await click(R)
  expect(title(R).disabled).toBe(true); expect(title('local').disabled).toBe(false)
  expect(dom.container.querySelector<HTMLButtonElement>(`[data-folder-host="${R}"] .space-section-add`)!.disabled).toBe(false)
  await act(async () => useAppStore.getState().selectWorkspace('later-workspace'))
  await act(async () => pending.resolve({ routeHostId: R, homeDirectory: directory }))
  expect(useAppStore.getState().activeWorkspaceId).toBe('later-workspace'); expect(add).not.toHaveBeenCalled()
  expect(title(R).disabled).toBe(false)
  const next = deferred<{ routeHostId: string; homeDirectory: string }>()
  vi.mocked(api.hosts.home).mockReturnValue(next.promise)
  await click(R)
  await act(async () => useAppStore.setState({ focusView: 'changed-reading-position' as never }))
  await act(async () => next.resolve({ routeHostId: R, homeDirectory: directory }))
  expect(useAppStore.getState().activeWorkspaceId).toBe('later-workspace'); expect(add).not.toHaveBeenCalled()
})

it('a slow home reply cannot reveal after a real same-Workspace Tab away-and-back navigation', async () => {
  const first = createWorkbenchTab('first-tab', { kind: 'file', workspaceId: 'workspace', regionId: 'first-region', path: 'first.md' })
  const second = createWorkbenchTab('second-tab', { kind: 'file', workspaceId: 'workspace', regionId: 'second-region', path: 'second.md' })
  useAppStore.setState({ tabs: { [first.id]: first, [second.id]: second }, layouts: { workspace: createWorkspaceLayout('original-group', [first.id, second.id]) } })
  await act(async () => useAppStore.getState().activateTab('workspace', 'original-group', first.id))
  const openingSelection = fileNavigationSelection(useAppStore.getState())
  const pending = deferred<{ routeHostId: string; homeDirectory: string }>()
  vi.spyOn(api.hosts, 'home').mockReturnValue(pending.promise)
  const add = vi.spyOn(api.workspaces, 'add')
  await mount(); await click(R)
  await act(async () => useAppStore.getState().activateTab('workspace', 'original-group', second.id))
  await act(async () => useAppStore.getState().activateTab('workspace', 'original-group', first.id))
  expect(fileNavigationSelection(useAppStore.getState())).toBe(openingSelection)
  await act(async () => pending.resolve({ routeHostId: R, homeDirectory: directory }))
  expect(useAppStore.getState().activeWorkspaceId).toBe('workspace')
  expect(useAppStore.getState().layouts.workspace!.groups[0]!.activeTabId).toBe(first.id)
  expect(add).not.toHaveBeenCalled()
})

it('a changed Host or foreign home response is refused on that exact operation without changing the workface', async () => {
  const pending = deferred<{ routeHostId: string; homeDirectory: string }>()
  vi.spyOn(api.hosts, 'home').mockReturnValue(pending.promise)
  const add = vi.spyOn(api.workspaces, 'add')
  await mount(); await click(R)
  await act(async () => useAppStore.setState({ config: { ...config, hosts: config.hosts.map(host => host.id === R ? { ...remote, hostname: 'changed.invalid' } : host) } }))
  await act(async () => pending.resolve({ routeHostId: R, homeDirectory: directory }))
  expect(dom.container.querySelector(`[data-folder-host="${R}"] [role="status"]`)!.textContent).toContain('configuration changed')
  expect(add).not.toHaveBeenCalled(); expect(useAppStore.getState().activeWorkspaceId).toBe('workspace')
  vi.mocked(api.hosts.home).mockResolvedValue({ routeHostId: 'other-device', homeDirectory: '/home/foreign' })
  await click(R)
  expect(dom.container.querySelector(`[data-folder-host="${R}"] [role="status"]`)!.textContent).toContain('another device')
  expect(add).not.toHaveBeenCalled(); expect(useAppStore.getState().sessions).toHaveLength(1)
})

it('a Host change while folder registration is pending retains the registration receipt without revealing its old home', async () => {
  vi.spyOn(api.hosts, 'home').mockResolvedValue({ routeHostId: R, homeDirectory: directory })
  const pending = deferred<WorkspaceRecord>()
  const add = vi.spyOn(api.workspaces, 'add').mockReturnValue(pending.promise)
  await mount(); await click(R)
  expect(add).toHaveBeenCalledExactlyOnceWith({ hostId: R, path: directory })
  await act(async () => useAppStore.setState({ config: { ...config, hosts: config.hosts.map(host => host.id === R ? { ...remote, hostname: 'changed-after-read.invalid' } : host) } }))
  await act(async () => pending.resolve(home))
  expect(useAppStore.getState().activeWorkspaceId).toBe('workspace')
  expect(useAppStore.getState().config!.workspaces).toContainEqual(home)
  expect(dom.container.querySelector(`[data-folder-host="${R}"] [role="status"]`)!.textContent).toContain('configuration changed before opening')
  expect(add).toHaveBeenCalledTimes(1)
})

it('device disclosure and plus remain independent and home registration uses the existing factual directory tree', async () => {
  const project = { id: 'studio-project', hostId: R, path: directory + '/work/project', name: 'Project', kind: 'folder' as const }
  config.workspaces.push(project); useAppStore.setState({ config })
  const read = vi.spyOn(api.hosts, 'home').mockResolvedValue({ routeHostId: R, homeDirectory: directory })
  vi.spyOn(api.workspaces, 'add').mockResolvedValue(home)
  await mount()
  await dom.click(`[data-folder-host="${R}"] [data-space-disclosure]`)
  expect(useAppStore.getState().collapsedProjectGroups[`space:folders:${R}`]).toBe(true)
  expect(read).not.toHaveBeenCalled()
  await dom.click(`[data-folder-host="${R}"] .space-section-add`)
  expect(document.querySelector('.host-folder-dialog')).not.toBeNull(); expect(read).not.toHaveBeenCalled()
  await act(async () => document.querySelector<HTMLButtonElement>('[aria-label="Close folder editor"]')!.click())
  await dom.click(`[data-folder-host="${R}"] [data-space-disclosure]`)
  await click(R)
  expect(dom.container.querySelectorAll(`[data-folder-host="${R}"] [data-space-folder]`)).toHaveLength(2)
  const child = dom.container.querySelector(`[data-workspace-id="${project.id}"]`) ?? dom.container.querySelector(`[data-space-folder] .project-rail-row[title*="${project.path}"]`)
  expect(useAppStore.getState().config!.workspaces.find(item => item.id === project.id)).toEqual(project)
  expect(child).not.toBeNull()
})
