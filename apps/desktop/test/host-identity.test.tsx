import { fixturePath as _hygiene_fixturePath } from "../scripts/lib/fixture-values.mjs"
// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { HostBadge } from '../src/renderer/src/components/HostBadge'
import { FocusProjectLanes } from '../src/renderer/src/components/FocusProjectLanes'
import { WorkspaceSidebar } from '../src/renderer/src/components/WorkspaceSidebar'
import { WorkspaceBoard } from '../src/renderer/src/components/WorkspaceBoard'
import { BoardRowsProvider } from '../src/renderer/src/hooks/useBoardRows'
import { ProjectGroupsTree } from '../src/renderer/src/components/ProjectGroupsTree'
import { projectWorkspaces } from '../src/renderer/src/lib/workspace-projects'
import { directoryIdentity } from '../src/shared/space-addresses'
import { api } from '../src/renderer/src/lib/api'
import { TopBreadcrumb } from '../src/renderer/src/components/TopRowChrome'
import { hostIdentityProjection, executionHostProjection, regionExecutionHost } from '../src/renderer/src/lib/region-execution-host'
import { useAppStore } from '../src/renderer/src/store'
import type { HostConfig } from '../src/shared/contracts'
import type { FocusProjectLane } from '../src/renderer/src/lib/focus-project-lanes'

const initial = useAppStore.getState()
const hosts: HostConfig[] = [{ id: 'local', kind: 'local' as const, label: 'This Mac' }, { id: 'farm', kind: 'ssh' as const, label: 'Build machine', hostname: 'private-farm' }]
let root: Root, container: HTMLDivElement
beforeEach(async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  useAppStore.setState({ ...initial, config: { ...await api.config.get(), hosts, workspaces: [{ id: 'project', hostId: 'farm', name: 'Same project', path: _hygiene_fixturePath("same/path"), kind: 'folder', branch: 'main' }] }, mainSurface: 'workbench', activeWorkspaceId: 'project' })
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
})
afterEach(async () => { await act(async () => root.unmount()); container.remove(); useAppStore.setState(initial, true); vi.unstubAllGlobals() })
async function mount(content: React.ReactNode) { await act(async () => root.render(content)) }
const badges = () => [...container.querySelectorAll<HTMLElement>('.host-identity')]

it('retains exact machine identity, explicitly unknown configuration and no connection claims', async () => {
  await mount(<><HostBadge context="Host" host={hostIdentityProjection('farm', hosts[1])} /><HostBadge context="Host" host={hostIdentityProjection('removed', hosts[1])} /><HostBadge context="Host" host={hostIdentityProjection(null)} /></>)
  expect(badges().map(b => b.dataset.hostId)).toEqual(['farm', 'removed', ''])
  expect(badges()[0]!.textContent).toBe('Build machine')
  expect(badges()[0]!.title).toBe('Build machine · farm')
  expect(badges()[1]!.dataset.hostKind).toBe('unknown')
  expect(badges()[1]!.getAttribute('aria-label')).toContain('Not configured')
  expect(badges()[2]!.getAttribute('aria-label')).toBe('Host: Host unknown')
  expect(container.textContent).not.toMatch(/connected|healthy|offline/i)
})
it('suppresses only confirmed local context while compact and execution identities remain accessible', async () => {
  await mount(<><HostBadge context="Host" showLocal={false} host={hostIdentityProjection('local', hosts[0])} /><HostBadge context="Host" compact host={hostIdentityProjection('farm', hosts[1])} /><HostBadge host={executionHostProjection('local', _hygiene_fixturePath("cwd"), hosts[0])} /><HostBadge context="Host" showLocal={false} host={hostIdentityProjection('orphan')} /></>)
  expect(badges().map(b => b.dataset.hostId)).toEqual(['farm', 'local', 'orphan'])
  expect(badges()[0]!.textContent).toBe('')
  expect(badges()[0]!.getAttribute('aria-label')).toContain('Build machine · farm')
  expect(badges()[1]!.dataset.executionHostId).toBe('local')
})
it('Focus distinguishes same named original project lanes by their own machine without changing selection', async () => {
  const lane = (hostId: string): FocusProjectLane => ({ id: hostId, hostId, workspaceId: hostId, projectId: hostId, name: 'Same project', path: _hygiene_fixturePath("same/path"), labels: ['Same project'], topicId: null, recovery: null, projectWorkspaceId: null, summary: null, activeAgentIds: [], contextIds: [] })
  const onSelect = vi.fn()
  await mount(<FocusProjectLanes lanes={['local', 'farm', 'removed'].map(lane)} selectedWorkspaceId="farm" onSelect={onSelect} renderLane={(_, heading) => heading} />)
  expect(badges().map(b => b.dataset.hostId)).toEqual(['local', 'farm', 'removed'])
  expect(container.querySelectorAll('.focus-project-lanes__label strong')).toHaveLength(3)
  expect(container.querySelector('[data-project-id="farm"]')?.classList.contains('is-selected')).toBe(true)
  await act(async () => (container.querySelector('[data-project-id="removed"] button') as HTMLButtonElement).click())
  expect(onSelect).toHaveBeenCalledExactlyOnceWith('removed')
})
it('breadcrumb consumes readable configured machine name and preserves branch identity', async () => {
  await mount(<TopBreadcrumb />)
  expect(badges()[0]!.textContent).toBe('Build machine')
  expect(badges()[0]!.getAttribute('aria-label')).toContain('farm')
  expect(container.querySelector('.breadcrumbs > strong')?.textContent).toBe('main')
  await act(async () => useAppStore.setState({ config: { ...useAppStore.getState().config!, workspaces: [{ id: 'project', hostId: 'local', name: 'Same project', path: _hygiene_fixturePath("same/path"), kind: 'folder', branch: 'main' }] } }))
  expect(badges()).toHaveLength(0)
  expect(container.textContent).toBe('main')
})

it('Board presents its original machine name using the shared identity without claiming connectivity', async () => {
  vi.spyOn(api.workspaces, 'listBranches').mockResolvedValue({ kind: 'git-repository', hostId: 'farm', repoPath: _hygiene_fixturePath("same/path"), branches: [] })
  await mount(<BoardRowsProvider enabled><WorkspaceBoard /></BoardRowsProvider>)
  await act(async () => { await vi.waitFor(() => expect(container.querySelector('.board-host-scope')).not.toBeNull()) })
  const badge = container.querySelector<HTMLElement>('.board-host-scope')!
  expect(badge.dataset.hostId).toBe('farm')
  expect(badge.textContent).toBe('Build machine')
  expect(badge.title).toContain('farm')
  expect(badge.getAttribute('aria-label')).not.toMatch(/connected|healthy/i)
  vi.restoreAllMocks()
})
it('mixed Group members retain original project icons and exact host labels including unavailable members', async () => {
  const config = useAppStore.getState().config!
  const workspaces = [{ id: 'project', hostId: 'farm', name: 'Same project', path: _hygiene_fixturePath("same/path"), kind: 'folder' as const }, { id: 'local-project', hostId: 'local', name: 'Same project', path: _hygiene_fixturePath("same/path"), kind: 'folder' as const }]
  const projects = projectWorkspaces(workspaces)
  useAppStore.setState({ config: { ...config, workspaces }, projectGroups: [{ groupId: 'group', name: 'Purpose', projectIds: [directoryIdentity('farm', _hygiene_fixturePath("same/path")), directoryIdentity('local', _hygiene_fixturePath("same/path")), directoryIdentity('removed', _hygiene_fixturePath("same/path"))] }], spaceObjectIcons: {}, collapsedProjectGroups: {} })
  vi.spyOn(api.workspaces, 'appearance').mockResolvedValue({ kind: 'directory', icon: null })
  await mount(<ProjectGroupsTree projects={projects} query="" activeProjectId="project" onCreate={() => {}} onEdit={() => {}} onDissolve={() => {}} sessionsByProject={new Map()} lastActivityByProject={new Map()} visible />)
  expect(badges().map(b => b.dataset.hostId)).toEqual(['farm', 'local', 'removed'])
  expect(container.querySelectorAll('.project-group__member .project-rail-row__icon')).toHaveLength(3)
  expect([...container.querySelectorAll('.project-group__member')].map(member => member.getAttribute('aria-label'))).toEqual(['Same project · Build machine · farm', 'Same project · This Mac · local', 'path · removed · removed · Registration unavailable'])
  expect(container.querySelector('[data-host-id="removed"]')?.getAttribute('aria-label')).toContain('Not configured')
  expect(container.textContent).toContain('Unavailable')
  expect(useAppStore.getState().config?.workspaces).toEqual(workspaces)
  vi.restoreAllMocks()
})

it('shared identity preserves the original Agent control Host and cwd even when display snapshot belongs elsewhere', async () => {
  const original = (await api.sessions.snapshot()).sessions.find(session => session.kind === 'agent')!
  if (original.kind !== 'agent') throw new Error('The nonempty owning Agent fixture is required')
  const session = { ...original, hostId: 'local', workspacePath: _hygiene_fixturePath("original/execution"), control: { ...original.control, hostId: 'farm' } }
  const host = regionExecutionHost(session, hosts[1])
  expect(host.id).toBe('farm')
  expect(host.cwd).toBe(_hygiene_fixturePath("original/execution"))
  await mount(<HostBadge host={host} />)
  expect(badges()[0]!.dataset.executionHostId).toBe('farm')
  expect(badges()[0]!.textContent).toBe('Build machine')
  expect(session.hostId).toBe('local')
  expect(session.control.hostId).toBe('farm')
})

it('Folder sections identify machines once while original folder rows keep their own icons', async () => {
  useAppStore.setState({ projectGroups: [], collapsedProjectGroups: {} })
  await mount(<WorkspaceSidebar />)
  expect(badges().map(b => b.dataset.hostId)).toEqual(['local', 'farm'])
  expect(container.querySelector('[data-folder-host="farm"] .host-identity')?.getAttribute('aria-label')).toContain('Build machine · farm')
  expect(container.querySelectorAll('.project-rail-row .host-identity')).toHaveLength(0)
  expect(container.querySelector('[data-folder-host="farm"]')?.getAttribute('aria-label')).toBe('Build machine Folders · farm')
})
