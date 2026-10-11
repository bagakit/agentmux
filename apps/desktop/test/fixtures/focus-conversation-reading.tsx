import { useMemo } from 'react'
import { GlobalFocusSurface } from '../../src/renderer/src/components/GlobalFocusSurface'
import { WorkspaceWorkbench } from '../../src/renderer/src/components/WorkspaceWorkbench'
import { useAppStore } from '../../src/renderer/src/store'
import { spatialCatalog } from '../../src/renderer/src/lib/space-agent-control'
import { executionFocusPresentation } from '../../src/renderer/src/lib/focus-tab-projection'
import { workbenchRegionProjectionSlotId } from '../../src/renderer/src/lib/workbench-projection'
import type { WorkbenchViewTargets } from '../../src/renderer/src/lib/workbench-presentation'

export const focusReadingLocation = { displayWorkspaceId: 'reading-workspace', groupId: 'reading-group', tabId: 'reading-tab', regionId: 'reading-region' }
export type FocusReadingRoute = 'projection' | 'observation'

/** Both production Focus routes, with the original workbench owner retained.
 * This fixture owns placement only; callers provide facts through public reads. */
export function FocusConversationReadingScene({ route }: { route: FocusReadingRoute }) {
  const state = useAppStore()
  const catalog = useMemo(() => spatialCatalog(state, []), [state.config, state.tabs, state.layouts, state.sessions, state.spaceZoneBindings])
  const presentation = useMemo(() => executionFocusPresentation(state.agentFocus.execution, state.tabs, catalog,
    reference => useAppStore.getState().focusExecutionSession(state.agentFocus.execution.sessionId, reference), 'region'), [state.agentFocus.execution, state.tabs, catalog])
  const projection = route === 'projection' ? presentation.projection : null
  const selected = projection?.selection[0]
  const visible = state.mainSurface === 'agents'
  const viewTargets: WorkbenchViewTargets = selected && projection ? { [selected.tabId]: [{
    hostId: workbenchRegionProjectionSlotId(`${projection.presentationId}-slot`, selected), active: visible, visible,
    surface: 'focus', retainedRegionId: selected.regionId, headerPortalTargetId: 'focus-workspace-slot-header',
    projection, reference: selected, onSelectRegion: regionId => projection.onSelect({ ...selected, regionId })
  }] } : {}
  return <section className="workspace-main-surface" data-focus-reading-route={route} style={{ width: '100%', height: '100%', position: 'relative' }}>
    <GlobalFocusSurface workspaceOpen {...(route === 'projection' ? { presentation, viewTargets } : {})} />
    {route === 'projection' ? <div className={`workspace-workbench-registry${visible ? '' : ' workspace-workbench-registry--parked'}`} aria-hidden={!visible} inert={!visible}>
      <div className={`workspace-workbench-slot${visible ? ' workspace-workbench-slot--focus-source' : ' workspace-workbench-slot--parked'}`} data-workspace-id={focusReadingLocation.displayWorkspaceId} data-visible={visible ? 'true' : 'false'} aria-hidden={!visible} inert={!visible}>
        <WorkspaceWorkbench workspaceId={focusReadingLocation.displayWorkspaceId} visible={false} viewTargets={viewTargets} />
      </div>
    </div> : null}
  </section>
}
