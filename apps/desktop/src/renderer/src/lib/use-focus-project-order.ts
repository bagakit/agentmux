import { useEffect, useRef, type RefObject } from 'react'
import { focusScanOrderKey, type FocusScanLane } from './focus-collection-lanes'
import { EMPTY_FOCUS_PROJECTS, type FocusProjectPreference } from '../../../shared/focus-project-preferences'
import { compareFocusLaneActivity } from './focus-project-lanes'

export type FocusProjectOrder = 'priority' | 'activity' | 'name'

function compareFocusProjects(order: FocusProjectOrder, a: FocusScanLane, b: FocusScanLane): number {
  if (order === 'name') {
    const name = (lane: FocusScanLane) => lane.collection || lane.topicId ? lane.name : lane.labels[0] ?? lane.name
    return name(a).localeCompare(name(b), undefined, { numeric: true, sensitivity: 'base' }) || compareFocusLaneActivity(a, b)
  }
  if (order === 'activity') return (b.lastActivityAt ?? 0) - (a.lastActivityAt ?? 0) || compareFocusLaneActivity(a, b)
  return compareFocusLaneActivity(a, b)
}

/** Establish one route at actual entry or explicit arrangement; activity stays live within it. */
export function useFocusProjectOrder<T extends FocusScanLane>(lanes: readonly T[], visible: boolean, rows: RefObject<HTMLElement | null>, interaction?: RefObject<boolean>,
  preferences: readonly FocusProjectPreference[] = EMPTY_FOCUS_PROJECTS, order: FocusProjectOrder = 'priority', revision = 0): T[] {
  const route = useRef({ visible: false, order, revision, projects: [] as string[], lanes: [] as string[] })
  const entering = visible && !route.current.visible
  const arrange = visible && (entering || route.current.order !== order || route.current.revision !== revision || (route.current.projects.length === 0 && lanes.length > 0))
  if (arrange) route.current = { visible, order, revision, projects: [], lanes: [] }
  route.current.visible = visible
  const projectRanks = new Map(route.current.projects.map((id, index) => [id, index]))
  const laneRanks = new Map(route.current.lanes.map((id, index) => [id, index]))
  for (const lane of arrange ? [...lanes].sort((a, b) => compareFocusProjects(order, a, b)) : lanes) {
    const project = focusScanOrderKey(lane)
    if (!projectRanks.has(project)) { projectRanks.set(project, projectRanks.size); if (visible) route.current.projects.push(project) }
    if (!laneRanks.has(lane.id)) { laneRanks.set(lane.id, laneRanks.size); if (visible) route.current.lanes.push(lane.id) }
  }
  useEffect(() => {
    if (!visible || !interaction) return
    const document = rows.current?.ownerDocument ?? window.document
    const down = (event: PointerEvent) => { interaction.current = Boolean(event.target instanceof Node && rows.current?.contains(event.target)) }
    const up = () => { interaction.current = false }
    document.addEventListener('pointerdown', down, true)
    document.addEventListener('pointerup', up, true)
    document.addEventListener('pointercancel', up, true)
    document.defaultView?.addEventListener('blur', up)
    return () => {
      up(); document.removeEventListener('pointerdown', down, true); document.removeEventListener('pointerup', up, true)
      document.removeEventListener('pointercancel', up, true); document.defaultView?.removeEventListener('blur', up)
    }
  }, [visible, rows, interaction])
  const pins = new Map(preferences.filter(item => item.pinned).map((item, index) => [item.key, index]))
  return [...lanes].sort((a, b) => (pins.get(focusScanOrderKey(a)) ?? pins.size) - (pins.get(focusScanOrderKey(b)) ?? pins.size)
    || projectRanks.get(focusScanOrderKey(a))! - projectRanks.get(focusScanOrderKey(b))!
    || laneRanks.get(a.id)! - laneRanks.get(b.id)!)
}
