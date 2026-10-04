import type { AgentMuxSpaceCatalog } from '@agentmux/core'
import type { ScratchTopicSnapshot } from '../../../shared/scratch-topics'
import { spatialCatalog, type SpatialWorkbench } from './space-agent-control'
import type { WorkbenchTab } from './workbench-tabs'

type Tabs = Readonly<Record<string, WorkbenchTab>>
const projections = new WeakMap<Tabs, Tabs>()
let previous: Tabs = {}

function sameNavigationTab(left: WorkbenchTab, right: WorkbenchTab): boolean {
  // Conservatively preserve every Tab-level fact, including future fields.
  const keys = Object.keys(left) as (keyof WorkbenchTab)[]
  if (keys.length !== Object.keys(right).length || keys.some(key => key !== 'regions' && left[key] !== right[key])) return false
  const ids = Object.keys(left.regions)
  const rightIds = Object.keys(right.regions)
  if (ids.length !== rightIds.length) return false
  return ids.every((id, index) => {
    if (rightIds[index] !== id) return false
    const a = left.regions[id]!, b = right.regions[id]
    if (a === b) return true
    // Browser page state has no effect on spatial membership or resource identity.
    // Other surfaces retain their full facts, including phase, file path and executor.
    return a.kind === 'browser' && b?.kind === 'browser' && a.regionId === b.regionId &&
      a.workspaceId === b.workspaceId && a.browserId === b.browserId
  })
}

/** Navigation only. UI, persistence and public Browser facts must keep reading the original Tabs. */
export function workbenchNavigationTabs(tabs: Tabs): Tabs {
  const known = projections.get(tabs)
  if (known) return known
  const ids = Object.keys(tabs), oldIds = Object.keys(previous)
  let changed = ids.length !== oldIds.length || ids.some((id, index) => id !== oldIds[index])
  const next: Record<string, WorkbenchTab> = {}
  for (const [id, tab] of Object.entries(tabs)) {
    const old = previous[id]
    next[id] = old && (old === tab || sameNavigationTab(old, tab)) ? old : tab
    if (next[id] !== old) changed = true
  }
  const value = changed ? next : previous
  projections.set(tabs, value)
  previous = value
  return value
}

type Facts = Omit<SpatialWorkbench, 'sessions' | 'tabs'> & { tabs: Tabs }
const NO_TOPICS: readonly ScratchTopicSnapshot[] = []
const catalogs = new WeakMap<readonly ScratchTopicSnapshot[], { inputs: readonly unknown[]; value: AgentMuxSpaceCatalog }>()

/** One shared structural graph per immutable input set, independent of mounted Pane count. */
export function workbenchNavigationCatalog(state: Facts, topics?: readonly ScratchTopicSnapshot[] | null): AgentMuxSpaceCatalog {
  const topicFacts = topics ?? NO_TOPICS
  const tabs = workbenchNavigationTabs(state.tabs)
  const inputs = [state.config, tabs, state.layouts, state.spaceZoneBindings, state.topicCategories, state.projectGroups]
  const known = catalogs.get(topicFacts)
  if (known && inputs.every((input, index) => input === known.inputs[index])) return known.value
  const value = spatialCatalog({ ...state, tabs, sessions: [] }, topicFacts)
  catalogs.set(topicFacts, { inputs, value })
  return value
}
