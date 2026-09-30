import { useCallback, useMemo } from 'react'
import type { AppConfig, SessionSnapshot } from '../../src/shared/contracts'
import { GlobalFocusSurface } from '../../src/renderer/src/components/GlobalFocusSurface'
import { WorkspaceWorkbench } from '../../src/renderer/src/components/WorkspaceWorkbench'
import { executionFocusPresentation } from '../../src/renderer/src/lib/focus-tab-projection'
import { spatialCatalog } from '../../src/renderer/src/lib/space-agent-control'
import { scratchTopicsForWorkspace } from '../../src/renderer/src/lib/scratch-topic-snapshots'
import { isSessionSurface } from '../../src/renderer/src/lib/workbench-surface-kinds'
import { workbenchProjectionSlotId, type WorkbenchProjection } from '../../src/renderer/src/lib/workbench-projection'
import type { WorkbenchViewTarget } from '../../src/renderer/src/lib/workbench-presentation'
import { useAppStore } from '../../src/renderer/src/store'

/** Explicit private fixture resources for the real public spatial catalog. */
export function absoluteFocusFixtureInputs<T extends SessionSnapshot>(config: AppConfig, sessions: readonly T[]) {
  const workspaces = config.workspaces.map(workspace => ({ ...workspace,
    path: workspace.path.startsWith('/') ? workspace.path : `/private/focus-fixture/${workspace.id}` }))
  const replacements = new Map(config.workspaces.map((workspace, index) => [workspace.path, workspaces[index]!.path]))
  return { config: { ...config, workspaces }, sessions: sessions.map(session => ({ ...session,
    workspacePath: replacements.get(session.workspacePath) ?? session.workspacePath })) }
}

/** Load the actual public projection and original View owner, without replacing either. */
export function FocusWorkbenchFixture({ workspaceId, showGlobal = true }: { workspaceId: string; showGlobal?: boolean }) {
  const state = useAppStore()
  const onSelect = useCallback<WorkbenchProjection['onSelect']>(reference => {
    const current = useAppStore.getState(), surface = current.tabs[reference.tabId]?.regions[reference.regionId]
    if (current.mainSurface === 'agents' && surface && isSessionSurface(surface)) current.focusExecutionSession(surface.sessionId, reference)
  }, [])
  const catalog = useMemo(() => spatialCatalog(state, scratchTopicsForWorkspace(state.scratchTopicSnapshots,
    state.config?.workspaces.find(workspace => workspace.id === '__scratch__')) ?? []),
  [state.config, state.tabs, state.layouts, state.sessions, state.spaceZoneBindings, state.scratchTopicSnapshots])
  const presentation = useMemo(() => executionFocusPresentation(state.agentFocus.execution, state.tabs, catalog, onSelect),
    [state.agentFocus.execution, state.tabs, catalog, onSelect])
  const projection = state.mainSurface === 'agents' ? presentation.projection : null
  const reference = projection?.selection[0]
  const viewTargets: Record<string, WorkbenchViewTarget> = reference && projection ? {
    [reference.tabId]: { hostId: workbenchProjectionSlotId(`${projection.presentationId}-slot`, reference),
      active: true, visible: true, surface: 'focus', retainedRegionId: reference.regionId,
      headerPortalTargetId: 'focus-workspace-slot-header', projection, reference,
      onSelectRegion: regionId => onSelect({ ...reference, regionId }) }
  } : {}
  return <>{state.mainSurface === 'agents' && showGlobal ? <GlobalFocusSurface presentation={presentation} viewTargets={viewTargets} /> : null}
    <WorkspaceWorkbench workspaceId={workspaceId} visible={state.mainSurface === 'workbench'} viewTargets={viewTargets} /></>
}
