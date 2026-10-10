import { fixturePath as _historyFixturePath } from "../../../../../test/fixture-values.mjs"
import { createRoot } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { createWorkspaceLayout } from '@agentmux/layout'
import { mountThemeRuntime, updateThemeSelection } from '@agentmux/client-ui/theme'
import { DesktopClientUiProvider } from '../../../src/renderer/src/components/DesktopClientUiProvider'
import { WindowOverlayHost } from '../../../src/renderer/src/components/WindowOverlayHost'
import { SurfaceToolDock } from '../../../src/renderer/src/components/SurfaceToolDock'
import { api } from '../../../src/renderer/src/lib/api'
import { createWorkbenchTab } from '../../../src/renderer/src/lib/workbench-tabs'
import { workspaceZoneContext } from '../../../src/renderer/src/lib/workspace-zone-context'
import { useAppStore } from '../../../src/renderer/src/store'
import { directoryIdentity, homeZoneId, workspaceZoneId } from '../../../src/shared/space-addresses'
import type { AppConfig, WorkspaceRecord } from '../../../src/shared/contracts'
import '../../../src/renderer/src/styles/index.css'
import './host.css'

const display: WorkspaceRecord = { id: 'project', hostId: 'local', path: _historyFixturePath("fixture/projects/navigation"), name: 'Navigation', kind: 'folder', branch: 'main' }
const worktree: WorkspaceRecord = { id: 'worktree', hostId: 'local', path: _historyFixturePath("fixture/worktrees/navigation/review-accessible-working-directory-relationships"),
  repoPath: display.path, name: 'Accessible working directory relationships', kind: 'worktree', branch: 'feature/explain-zone-worktree-relationships-with-long-reference' }
const plain: WorkspaceRecord = { id: 'plain', hostId: 'local', path: _historyFixturePath("fixture/independent/reference-materials"), name: 'Reference materials', kind: 'folder' }
const workspaces = [display, worktree, plain]
const spaceId = directoryIdentity(display.hostId, display.path)
const plainSpace = directoryIdentity(plain.hostId, plain.path)
const nestedPath = display.path + '/research/home-notes'
const nestedSpace = directoryIdentity(display.hostId, nestedPath)
const zones = { root: workspaceZoneId(spaceId, display.id), worktree: workspaceZoneId(spaceId, worktree.id),
  plain: workspaceZoneId(plainSpace, plain.id), home: homeZoneId(nestedSpace), unknown: 'retained-unavailable-zone' }
const bindings = {
  [zones.plain]: { spaceId: plainSpace, workspaceId: plain.id, relations: { [spaceId]: true } },
  [zones.home]: { spaceId: nestedSpace, workspaceId: display.id, directoryPath: nestedPath, relations: { [spaceId]: true } },
  [zones.unknown]: { spaceId, workspaceId: 'Unavailable workspace' }
}
const tabs = Object.fromEntries(Object.entries(zones).map(([key, zoneId]) => {
  const workspaceId = key === 'worktree' ? worktree.id : key === 'plain' ? plain.id : key === 'unknown' ? 'Unavailable workspace' : display.id
  const originalSpace = key === 'plain' ? plainSpace : key === 'home' ? nestedSpace : spaceId
  const tab = { ...createWorkbenchTab(key + '-tab', { kind: 'launcher', workspaceId, regionId: key + '-region' }), space: { spaceId: originalSpace, zoneId } }
  return [tab.id, tab]
}))
const config: AppConfig = { version: 9, hosts: [{ id: 'local', kind: 'local', label: 'Fixture Host' }], executors: {}, workspaces,
  appearance: { terminalTheme: 'graphite', appAppearance: 'dark' },
  browser: { toolbar: { selectElement: true, screenshot: true, devTools: true, viewport: true, saveBookmark: true, more: true } },
  notifications: { mode: 'off' } }
const calls: { method: string; args: unknown[] }[] = []
const read = (method: string, args: unknown[]) => calls.push({ method, args })
const rejectWrite = async (...args: unknown[]) => { read('forbidden-write', args); throw new Error('Capture fixture does not authorize filesystem, Git or Runtime writes') }
api.ui.requestStorageFlush = async () => undefined
api.files.readDirectory = async (workspaceId, path) => {
  read('files.readDirectory', [workspaceId, path])
  return path === '' ? [{ name: 'src', path: 'src', isDirectory: true, isSymlink: false },
    { name: 'README.md', path: 'README.md', isDirectory: false, isSymlink: false }] : []
}
api.files.observe = async (...args) => { read('files.observe', args) }
api.files.unobserve = async (...args) => { read('files.unobserve', args) }
api.workspaces.listBranches = async workspaceId => {
  read('workspaces.listBranches', [workspaceId])
  return { kind: 'git-repository', hostId: 'local', repoPath: display.path, branches: [
    { name: 'main', worktreePath: display.path, workspaceId: display.id, isCurrent: workspaceId === display.id },
    { name: worktree.branch!, worktreePath: worktree.path, workspaceId: worktree.id, isCurrent: workspaceId === worktree.id },
    { name: 'candidate/unbound-work', worktreePath: null, workspaceId: null, isCurrent: false }
  ] }
}
api.workspaces.createWorktreeForBranch = rejectWrite
api.workspaces.openBranch = rejectWrite
api.sessions.launchAgent = rejectWrite
Object.assign(window, { agentmux: { git: {
  status: async (workspaceId: string) => {
    read('git.status', [workspaceId])
    const resource = workspaces.find(value => value.id === workspaceId)
    if (!resource) throw new Error('Unknown fixture resource')
    if (workspaceId === plain.id) return { kind: 'not-a-git-repository', hostId: 'local', workspacePath: plain.path }
    return { kind: 'git-repository', hostId: 'local', repoPath: resource.path, repoRelativePrefix: '', branch: resource.branch,
      changes: [{ path: 'src/navigation.ts', origPath: null, index: 'M', worktree: ' ', staged: true, unstaged: false, untracked: false }] }
  },
  aheadBehind: async (...args: unknown[]) => { read('git.aheadBehind', args); return null },
  commit: rejectWrite, stage: rejectWrite, unstage: rejectWrite, discard: rejectWrite
} } })
useAppStore.setState({ config, localHome: _historyFixturePath("fixture"), activeWorkspaceId: display.id, mainSurface: 'workbench',
  workspaceTool: 'files-branches', workspaceGitView: 'changes', projectRailOpen: true,
  tabs, layouts: { [display.id]: createWorkspaceLayout('fixture-group', Object.keys(tabs)) },
  workbenchSpaceSelection: null, spaceZoneBindings: bindings, sessions: [], scratchTopicSnapshots: {},
  topicCategories: [], projectGroups: [], spatialRequests: {}, explorerCollapsed: {},
  gitCommitDrafts: {}, agentComposerDrafts: { retained: 'Unsent original draft' } })
mountThemeRuntime(window, config.appearance)
createRoot(document.getElementById('root')!).render(<DesktopClientUiProvider><SurfaceToolDock workspace={display} /><WindowOverlayHost /></DesktopClientUiProvider>)
Object.assign(window, { zoneNavigationFixture: {
  expectedHomePath: nestedPath,
  zones,
  theme(mode: 'dark' | 'light') {
    flushSync(() => useAppStore.setState(state => ({ config: { ...state.config!, appearance: { ...state.config!.appearance, appAppearance: mode } } })))
    updateThemeSelection({ appAppearance: mode })
  },
  facts() {
    const state = useAppStore.getState(), context = workspaceZoneContext(state, display)
    return { selectedZone: context.selectedZoneId, resource: context.resource, files: context.files, issue: context.issue,
      selection: state.workbenchSpaceSelection, tool: state.workspaceTool, view: state.workspaceGitView,
      tabs: state.tabs, layouts: state.layouts, sessions: state.sessions, drafts: state.agentComposerDrafts, caret: state.regionCaretFocus,
      calls: [...calls] }
  }
} })
