import { mintObjectId } from '@agentmux/core/object-id'
import { activateTab as activateLayoutTab, addTabPlacement, createWorkspaceLayout, type WorkspaceLayout } from '@agentmux/layout'
import type { AppConfig } from '../../../shared/contracts'
import type { GitCommitSnapshot, GitDiffDescriptor } from '../../../shared/git-contracts'
import { createWorkbenchTab, findWorkbenchRegion, focusWorkbenchTabRegion, gitDiffIdentity,
  tabGroupForTab, workbenchSurfaces, type WorkbenchTab } from '../lib/workbench-tabs'

export interface GitReadingActions {
  openBranchDiff(workspaceId: string, comparison: GitDiffDescriptor): void
  openGitWorkbench(workspaceId: string, snapshot: GitCommitSnapshot): { tabId: string; regionId: string }
  openGitHistory(workspaceId: string, scope: Pick<GitCommitSnapshot, 'hostId' | 'repoPath'>, reference?: string | null, locate?: GitCommitSnapshot): { tabId: string; regionId: string }
  selectGitHistoryReference(regionId: string, reference: string | null): void
  selectGitFile(regionId: string, file: { path: string; origPath: string | null } | null): void
  selectGitCommit(regionId: string, snapshot: GitCommitSnapshot): void
}

type GitReadingState = {
  config: Pick<AppConfig, 'workspaces'> | null
  tabs: Record<string, WorkbenchTab>
  layouts: Record<string, WorkspaceLayout>
}
type GitReadingPatch = Partial<Pick<GitReadingState, 'tabs' | 'layouts'>> & {
  activeWorkspaceId?: string
  mainSurface?: 'workbench'
  workspaceTool?: 'git'
  workspaceGitView?: 'history'
  toolsOpen?: true
}

/** The existing Store owns state, persistence, focus publication and shared diff resources. */
type GitReadingPorts = {
  get(): GitReadingState
  set(update: GitReadingPatch | ((state: GitReadingState) => GitReadingPatch)): void
  focusRegion(workspaceId: string, tabId: string, regionId: string, groupId: string): void
  releaseBranchDiff(regionId: string): void
  reportUnavailableGroup(workspaceId: string, groupId: string): void
}

export function createGitReadingActions(ports: GitReadingPorts): GitReadingActions {
  const { get, set } = ports
  /** Presentation belongs to Desktop. Fixed commits retain their own identity; repository browsing
   * has one reusable Region. Neither navigation changes the configured resource nor Agent cwd. */
  function openGitReading(workspaceId: string, target:
    | { kind: 'commit'; snapshot: GitCommitSnapshot }
    | { kind: 'history'; scope: Pick<GitCommitSnapshot, 'hostId' | 'repoPath'>; reference?: string | null; locate?: GitCommitSnapshot }
  ): { tabId: string; regionId: string } {
    const state = get()
    const scope = target.kind === 'commit' ? target.snapshot : target.scope
    const workspace = state.config?.workspaces.find(item => item.id === workspaceId)
    if (!workspace || workspace.hostId !== scope.hostId) throw new Error('The original Git workspace is unavailable.')
    const existing = Object.values(state.tabs).flatMap(tab => workbenchSurfaces(tab).flatMap(surface =>
      surface.kind === 'git' && surface.workspaceId === workspaceId && surface.scope.hostId === scope.hostId &&
      surface.scope.repoPath === scope.repoPath && surface.scope.workspacePath === workspace.path &&
      (target.kind === 'history' ? Boolean(surface.history) || !surface.selection
        : !surface.history && surface.selection?.commitOid === target.snapshot.commitOid && surface.selection.parentOid === target.snapshot.parentOid)
        ? [{ tab, surface }] : []))[0]
    const tabId = existing?.tab.id ?? mintObjectId(), regionId = existing?.surface.regionId ?? mintObjectId()
    const layout = state.layouts[workspaceId] ?? createWorkspaceLayout(mintObjectId())
    const groupId = tabGroupForTab(layout, tabId) ?? layout.activeGroupId
    const nextLayout = existing ? activateLayoutTab(layout, groupId, tabId) : addTabPlacement(layout, groupId, tabId)
    if (!nextLayout) throw new Error('The original Git Tab Group is unavailable.')
    const selected = target.kind === 'commit' ? target.snapshot : target.locate
    const selection = selected ? { commitOid: selected.commitOid, parentOid: selected.parentOid } : existing?.surface.selection ?? null
    const sameSelection = existing?.surface.selection?.commitOid === selection?.commitOid && existing?.surface.selection?.parentOid === selection?.parentOid
    if (existing && !sameSelection) ports.releaseBranchDiff(regionId)
    const surface = { kind: 'git' as const, regionId, workspaceId,
      scope: { hostId: scope.hostId, repoPath: scope.repoPath, workspacePath: workspace.path }, selection,
      ...(target.kind === 'history' ? { history: {
        reference: target.reference === undefined ? existing?.surface.history?.reference ?? null : target.reference,
        ...(target.locate ? { focusOid: target.locate.commitOid } : {})
      } } : {}),
      ...(sameSelection && existing?.surface.file ? { file: existing.surface.file } : {}) }
    const tab = existing ? focusWorkbenchTabRegion({ ...existing.tab, regions: { ...existing.tab.regions, [regionId]: surface } }, regionId)
      : createWorkbenchTab(tabId, surface)
    set(current => ({ activeWorkspaceId: workspaceId, mainSurface: 'workbench',
      tabs: { ...current.tabs, [tabId]: tab }, layouts: { ...current.layouts, [workspaceId]: nextLayout } }))
    ports.focusRegion(workspaceId, tabId, regionId, groupId)
    return { tabId, regionId }
  }

  return {
    openGitWorkbench(workspaceId, snapshot) {
      return openGitReading(workspaceId, { kind: 'commit', snapshot })
    },
    openGitHistory(workspaceId, scope, reference, locate) {
      const opened = openGitReading(workspaceId, { kind: 'history', scope, ...(reference !== undefined ? { reference } : {}), ...(locate ? { locate } : {}) })
      set({ workspaceTool: 'git', workspaceGitView: 'history', toolsOpen: true })
      return opened
    },
    selectGitHistoryReference(regionId, reference) {
      const found = findWorkbenchRegion(get().tabs, regionId)
      if (found?.surface.kind !== 'git' || !found.surface.history || found.surface.history.reference === reference) return
      const { tab, surface } = found
      set(current => ({ tabs: { ...current.tabs, [tab.id]: { ...tab, regions: { ...tab.regions,
        [regionId]: { ...surface, history: { ...surface.history!, reference } } } } } }))
    },
    selectGitFile(regionId, file) {
      const found = findWorkbenchRegion(get().tabs, regionId)
      if (found?.surface.kind !== 'git' || !found.surface.selection) return
      const { tab, surface } = found
      ports.releaseBranchDiff(regionId)
      const { file: _previousFile, ...fixed } = surface
      set(current => ({ tabs: { ...current.tabs, [tab.id]: { ...tab, regions: { ...tab.regions,
        [regionId]: { ...fixed, ...(file ? { file } : {}) } } } } }))
    },
    selectGitCommit(regionId, snapshot) {
      const found = findWorkbenchRegion(get().tabs, regionId)
      if (found?.surface.kind !== 'git' || found.surface.scope.hostId !== snapshot.hostId ||
          found.surface.scope.repoPath !== snapshot.repoPath) return
      const { tab, surface } = found
      ports.releaseBranchDiff(regionId)
      const { file: _previousFile, ...fixed } = surface
      set(current => ({ tabs: { ...current.tabs, [tab.id]: { ...tab, regions: { ...tab.regions,
        [regionId]: { ...fixed, selection: { commitOid: snapshot.commitOid, parentOid: snapshot.parentOid } } } } } }))
    },
    openBranchDiff(workspaceId, comparison) {
      const state = get()
      if (!state.config?.workspaces.some((workspace) => workspace.id === workspaceId)) return
      const id = gitDiffIdentity(workspaceId, comparison)
      const existing = Object.values(state.tabs).flatMap((tab) => workbenchSurfaces(tab).flatMap((surface) => (
        surface.kind === 'git-diff' && gitDiffIdentity(surface.workspaceId, surface.comparison) === id
          ? [{ tab, surface }] : []
      )))[0]
      const tabId = existing?.tab.id ?? mintObjectId()
      const layout = state.layouts[workspaceId] ?? createWorkspaceLayout(mintObjectId())
      const groupId = tabGroupForTab(layout, tabId) ?? layout.activeGroupId
      const nextLayout = existing ? activateLayoutTab(layout, groupId, tabId) : addTabPlacement(layout, groupId, tabId)
      if (!nextLayout) { ports.reportUnavailableGroup(workspaceId, groupId); return }
      const tab = existing
        ? focusWorkbenchTabRegion(existing.tab, existing.surface.regionId)
        : createWorkbenchTab(tabId, { kind: 'git-diff', regionId: mintObjectId(), workspaceId, comparison })
      set((current) => ({
        activeWorkspaceId: workspaceId, mainSurface: 'workbench',
        tabs: { ...current.tabs, [tabId]: tab }, layouts: { ...current.layouts, [workspaceId]: nextLayout }
      }))
      ports.focusRegion(workspaceId, tabId, tab.layout.activeRegionId, groupId)
    },
  }
}
