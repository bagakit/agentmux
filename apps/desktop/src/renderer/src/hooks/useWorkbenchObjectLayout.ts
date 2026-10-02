import { useMemo, useRef } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useAppStore } from '../store'
import { workbenchObjectLayout } from '../lib/desktop-focus-navigation'
import type { WorkspaceLayout } from '@agentmux/layout'

/** Retain only the last confirmed presentation of this same object during discovery gaps. */
export function useWorkbenchObjectLayout(workspaceId: string, residentLayout?: WorkspaceLayout, enabled = true) {
  const facts = useAppStore(useShallow(state => ({ config: state.config, tabs: state.tabs, layouts: state.layouts,
    spaceZoneBindings: state.spaceZoneBindings, spatialRequests: state.spatialRequests, topicCategories: state.topicCategories,
    scratchTopicSnapshots: state.scratchTopicSnapshots, workbenchSpaceSelection: state.workbenchSpaceSelection,
    activeWorkspaceId: state.activeWorkspaceId, mainSurface: state.mainSurface, selectedDemandId: state.selectedDemandId })))
  const current = useMemo(() => enabled ? workbenchObjectLayout({ ...facts, sessions: [] }, workspaceId, residentLayout)
    : { layout: null, choice: null, confirmed: false, issues: [] }, [facts, workspaceId, residentLayout, enabled])
  const identity = JSON.stringify([workspaceId, current.choice?.spaceId, current.choice?.zoneId])
  const retained = useRef<{ identity: string; layout: WorkspaceLayout } | null>(null)
  if (retained.current?.identity !== identity) retained.current = null
  if (current.confirmed && current.layout) retained.current = { identity, layout: current.layout }
  return { ...current, layout: current.layout ?? retained.current?.layout ?? null }
}
