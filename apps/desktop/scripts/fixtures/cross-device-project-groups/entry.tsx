import { fixturePath as _hygiene_fixturePath } from "../../lib/fixture-values.mjs"
import { createRoot } from 'react-dom/client'
import { createWorkspaceLayout } from '@agentmux/layout'
import type { AgentMuxSpatialState } from '@agentmux/core/spatial-graph'
import type { AppConfig, AgentMuxDesktopApi } from '../../../src/shared/contracts'
import { App } from '../../../src/renderer/src/App'
import { DesktopClientUiProvider } from '../../../src/renderer/src/components/DesktopClientUiProvider'
import { api } from '../../../src/renderer/src/lib/api'
import { useAppStore, prepareRendererUpdate } from '../../../src/renderer/src/store'
import { desktopSpatialGraph } from '../../../src/renderer/src/lib/desktop-spatial-state'
import { createWorkbenchTab, addWorkbenchRegion } from '../../../src/renderer/src/lib/workbench-tabs'
import { projectPersistedWorkbench } from '../../../src/renderer/src/lib/workbench-persistence'
import { workspaceProjectId } from '../../../src/renderer/src/lib/workspace-projects'
import '../../../src/renderer/src/styles/index.css'

type Boundary = {
  request(operation: string, ...args: unknown[]): Promise<any>
  onSpatialChange(listener: (state: AgentMuxSpatialState) => void): () => void
}
declare global {
  interface Window {
    projectGroupsBoundary: Boundary
    projectGroupsReady: boolean
    projectGroupsState(): unknown
    projectGroupsFlush(): Promise<AgentMuxSpatialState>
  }
}
const request = window.projectGroupsBoundary.request
const setup: { phase: 'seed' | 'restore'; config: AppConfig; unknownProjectId: string; retainedGroupId: string } = await request('setup')
api.config.get = async () => structuredClone(setup.config)
api.spatial = {
  read: () => request('spatial-read'),
  commit: input => request('spatial-commit', input),
  onChange: listener => window.projectGroupsBoundary.onSpatialChange(listener)
}
api.ui.requestStorageFlush = () => request('flush')
api.providers.list = async () => []
api.demands.list = async () => []
api.scratch.listTopics = async () => []
api.sessions.snapshot = async () => ({ sessions: [], recoveryCandidates: [], timelines: {}, localHome: _hygiene_fixturePath("Users/private-proof") })
api.sessions.onEvent = () => () => {}
api.git.projectIdentity = workspaceId => request('git-project-identity', workspaceId)
api.files.read = (workspaceId, file) => request('file-read', workspaceId, file)
api.files.readDirectory = (workspaceId, directory) => request('file-directory', workspaceId, directory)
api.files.observe = async () => {}
api.files.unobserve = async () => {}
// No live Session belongs to this proof. An unexpected lifecycle call is recorded and rejected;
// neither the preview's fake Runs nor the user's Runtime can enter the spatial organization proof.
for (const method of ['launchAgent', 'launchTerminal', 'write', 'paste', 'stop', 'submitPrompt', 'submitMessage'] as const) {
  (api.sessions as unknown as Record<string, unknown>)[method] = (...args: unknown[]) => request(`forbidden-runtime-${method}`, ...args)
}
api.files.write = (...args: Parameters<AgentMuxDesktopApi['files']['write']>) => request('forbidden-file-write', ...args)

if (setup.phase === 'seed') {
  const [local, remote, archive] = setup.config.workspaces
  if (!local || !remote || !archive) throw new Error('Three registered, distinct-host Projects are required')
  let localTab = createWorkbenchTab('groups-original-local-tab', {
    regionId: 'groups-original-local-region', kind: 'file', workspaceId: local.id, path: `${local.path}/overview.txt`
  }, 'Local project · original split')
  localTab = addWorkbenchRegion(localTab, 'groups-original-local-region', 'right', {
    regionId: 'groups-original-remote-display-region', kind: 'file', workspaceId: remote.id, path: `${remote.path}/overview.txt`
  })
  const remoteTab = createWorkbenchTab('groups-original-remote-tab', {
    regionId: 'groups-original-remote-region', kind: 'file', workspaceId: remote.id, path: `${remote.path}/overview.txt`
  }, 'Remote project · original directory')
  const archiveTab = createWorkbenchTab('groups-original-archive-tab', {
    regionId: 'groups-original-archive-region', kind: 'file', workspaceId: archive.id, path: `${archive.path}/overview.txt`
  }, 'Archive project · original directory')
  const graph = desktopSpatialGraph({ config: setup.config, sessions: [],
    projectGroups: [{ groupId: setup.retainedGroupId, name: 'Retained release project · registration unavailable',
      projectIds: [workspaceProjectId(archive), setup.unknownProjectId] }],
    tabs: Object.fromEntries([localTab, remoteTab, archiveTab].map(tab => [tab.id, tab])),
    layouts: Object.fromEntries([local, remote, archive].map((workspace, index) => [workspace.id,
      createWorkspaceLayout(`groups-original-layout-${index}`, [[localTab, remoteTab, archiveTab][index]!.id])])),
    spaceZoneBindings: {}, spatialRequests: {}
  }, [])
  await request('seed-spatial', graph)
}

const visible = (element: Element) => {
  const rect = element.getBoundingClientRect()
  return rect.width > 0 && rect.height > 0 && element.checkVisibility({ checkVisibilityCSS: true, checkOpacity: true })
}
window.projectGroupsState = () => {
  const state = useAppStore.getState()
  const active = document.activeElement as HTMLElement | null
  const tree = document.querySelector('.space-tree')
  const box = (element: Element | null) => element?.getBoundingClientRect().toJSON() ?? null
  return JSON.parse(JSON.stringify({ loading: state.loading, error: state.error,
    activeWorkspaceId: state.activeWorkspaceId, mainSurface: state.mainSurface,
    projectRailOpen: state.projectRailOpen, projectGroups: state.projectGroups,
    workbench: projectPersistedWorkbench(state), spaceZoneBindings: state.spaceZoneBindings,
    execution: (state.config?.workspaces ?? []).map(workspace => ({ id: workspace.id, hostId: workspace.hostId, path: workspace.path,
      projectId: workspaceProjectId(workspace) })),
    focusedMember: active?.dataset.projectGroupMember ?? null, focusedNavigation: active?.dataset.spaceNav ?? null,
    selectedMembers: [...document.querySelectorAll('[data-project-group-member][aria-current="page"]')].map(element =>
      (element as HTMLElement).dataset.projectGroupMember),
    geometry: {
      spaceTree: tree ? { scrollLeft: tree.scrollLeft, clientWidth: tree.clientWidth, scrollWidth: tree.scrollWidth, box: box(tree) } : null,
      groups: [...document.querySelectorAll('[data-project-group]')].map(element => ({
        groupId: (element as HTMLElement).dataset.projectGroup, box: box(element),
        clientWidth: element.clientWidth, scrollWidth: element.scrollWidth,
        heading: box(element.querySelector('.project-group__heading')),
        members: [...element.querySelectorAll('[data-project-group-member]')].map(member => ({
          projectId: (member as HTMLElement).dataset.projectGroupMember, box: box(member),
          clientWidth: member.clientWidth, scrollWidth: member.scrollWidth, title: member.getAttribute('title')
        }))
      }))
    },
    visibleRegions: [...document.querySelectorAll('[data-workbench-region-id]')].filter(visible).map(element => ({
      id: (element as HTMLElement).dataset.workbenchRegionId, text: (element as HTMLElement).innerText,
      box: element.getBoundingClientRect().toJSON()
    }))
  }))
}
window.projectGroupsFlush = async () => {
  await prepareRendererUpdate()
  return request('observe-durable')
}
createRoot(document.getElementById('root')!).render(<DesktopClientUiProvider><App /></DesktopClientUiProvider>)
window.projectGroupsReady = true
