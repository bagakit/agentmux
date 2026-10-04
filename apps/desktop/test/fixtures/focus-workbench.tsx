import { fixturePath as _hygiene_fixturePath } from "../../scripts/lib/fixture-values.mjs"
import { useCallback, useMemo, useState } from 'react'
import type { AppConfig, SessionSnapshot } from '../../src/shared/contracts'
import { GlobalFocusSurface } from '../../src/renderer/src/components/GlobalFocusSurface'
import { WorkspaceWorkbench } from '../../src/renderer/src/components/WorkspaceWorkbench'
import { mainFocusPresentation } from '../../src/renderer/src/lib/focus-tab-projection'
import { spatialCatalog } from '../../src/renderer/src/lib/space-agent-control'
import { scratchTopicsForWorkspace } from '../../src/renderer/src/lib/scratch-topic-snapshots'
import { workbenchProjectionSlotId, workbenchRegionProjectionSlotId, type WorkbenchProjection } from '../../src/renderer/src/lib/workbench-projection'
import type { WorkbenchViewTargets } from '../../src/renderer/src/lib/workbench-presentation'
import { useAppStore } from '../../src/renderer/src/store'

/** Explicit private fixture resources for the real public spatial catalog. */
export function absoluteFocusFixtureInputs<T extends SessionSnapshot>(config: AppConfig, sessions: readonly T[]) {
  const workspaces = config.workspaces.map(workspace => ({ ...workspace,
    path: workspace.path.startsWith('/') ? workspace.path : (_hygiene_fixturePath("private/focus-fixture/") + (workspace.id) + "") }))
  const replacements = new Map(config.workspaces.map((workspace, index) => [workspace.path, workspaces[index]!.path]))
  return { config: { ...config, workspaces }, sessions: sessions.map(session => ({ ...session,
    workspacePath: replacements.get(session.workspacePath) ?? session.workspacePath })) }
}

/** Load the actual public projection and original View owner, without replacing either. */
export function FocusWorkbenchFixture({ workspaceId, showGlobal = true, level = 'tab' }: { workspaceId: string; showGlobal?: boolean; level?: 'tab' | 'region' }) {
  const state = useAppStore()
  const [workspaceOpen, setWorkspaceOpen] = useState(true)
  const onSelect = useCallback<WorkbenchProjection['onSelect']>(reference => {
    const current = useAppStore.getState()
    if (current.mainSurface === 'agents') current.selectMainRegion(reference, current.workbenchSpaceSelection)
  }, [])
  const catalog = useMemo(() => spatialCatalog(state, scratchTopicsForWorkspace(state.scratchTopicSnapshots,
    state.config?.workspaces.find(workspace => workspace.id === '__scratch__')) ?? []),
  [state.config, state.tabs, state.layouts, state.sessions, state.spaceZoneBindings, state.scratchTopicSnapshots])
  const presentation = useMemo(() => mainFocusPresentation(state.workbenchSpaceSelection, state.tabs, catalog, onSelect, level),
    [state.workbenchSpaceSelection, state.tabs, catalog, onSelect, level])
  const projection = state.mainSurface === 'agents' ? presentation.projection : null
  const reference = projection?.selection[0]
  const viewTargets: WorkbenchViewTargets = reference && projection ? {
    [reference.tabId]: [{ hostId: (projection.entity.kind === 'region' ? workbenchRegionProjectionSlotId : workbenchProjectionSlotId)(`${projection.presentationId}-slot`, reference),
      active: true, visible: true, surface: 'focus', retainedRegionId: reference.regionId,
      projection, reference,
      onSelectRegion: regionId => onSelect({ ...reference, regionId }) }]
  } : {}
  return <>{state.mainSurface === 'agents' && showGlobal ? <GlobalFocusSurface presentation={presentation} viewTargets={viewTargets} workspaceOpen={workspaceOpen} onCloseWorkspace={() => setWorkspaceOpen(false)} /> : null}
    <div className="workspace-workbench-registry"><div className={`workspace-workbench-slot${state.mainSurface === 'agents' ? ' workspace-workbench-slot--focus-source' : ''}`}><WorkspaceWorkbench workspaceId={workspaceId} visible={state.mainSurface === 'workbench'} viewTargets={viewTargets} /></div></div></>
}
