import { useMemo, useRef } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useAppStore } from '../store'
import { workbenchObjectLayout, type WorkbenchObjectLayoutFacts } from '../lib/desktop-focus-navigation'
import type { WorkspaceLayout } from '@agentmux/layout'
import { workbenchNavigationTabs } from '../lib/workbench-navigation-catalog'

const EMPTY_OBJECT_LAYOUT: ReturnType<typeof workbenchObjectLayout> = { layout: null, choice: null, confirmed: false, issues: [] }

/** Retain only the last confirmed presentation of this same object during discovery gaps. */
export function useWorkbenchObjectLayout(workspaceId: string, residentLayout?: WorkspaceLayout, enabled = true) {
  const facts = useAppStore(useShallow((state): WorkbenchObjectLayoutFacts | null => {
    if (!enabled) return null
    const choice = state.workbenchSpaceSelection
    return {
      config: state.config, tabs: workbenchNavigationTabs(state.tabs), layouts: state.layouts,
      spaceZoneBindings: state.spaceZoneBindings, topicCategories: state.topicCategories, projectGroups: state.projectGroups,
      scratchTopicSnapshots: state.scratchTopicSnapshots,
      workbenchSpaceSelection: choice?.workspaceId === workspaceId ? choice : null
    }
  }))
  const current = useMemo(() => facts ? workbenchObjectLayout(facts, workspaceId, residentLayout)
    : EMPTY_OBJECT_LAYOUT, [facts, workspaceId, residentLayout])
  const choice = current.choice
  const identity = JSON.stringify([workspaceId, choice?.spaceId, choice?.zoneId,
    ...(choice?.spaceId === null && choice.zoneId === null
      ? [choice.groupId, choice.tabId, choice.regionId] : [])])
  const retained = useRef<{ identity: string; layout: WorkspaceLayout } | null>(null)
  if (retained.current?.identity !== identity) retained.current = null
  if (current.confirmed && current.layout) retained.current = { identity, layout: current.layout }
  return { ...current, layout: current.layout ?? retained.current?.layout ?? null }
}
