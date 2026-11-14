import { useEffect, useRef, type RefObject } from 'react'
import { focusLaneProjectKey, type FocusProjectLane } from './focus-project-lanes'
import { EMPTY_FOCUS_PROJECTS, type FocusProjectPreference } from '../../../shared/focus-project-preferences'

/** Identity is the route. Activity stays live; only an explicit arrangement replaces that route. */
export function useFocusProjectOrder(lanes: readonly FocusProjectLane[], visible: boolean, rows: RefObject<HTMLElement | null>, interaction?: RefObject<boolean>,
  preferences: readonly FocusProjectPreference[] = EMPTY_FOCUS_PROJECTS, arrangeRevision = 0): FocusProjectLane[] {
  const route = useRef({ revision: arrangeRevision, projects: [] as string[], lanes: [] as string[] })
  if (route.current.revision !== arrangeRevision) route.current = { revision: arrangeRevision, projects: [], lanes: [] }
  const projectRanks = new Map(route.current.projects.map((id, index) => [id, index]))
  const laneRanks = new Map(route.current.lanes.map((id, index) => [id, index]))
  for (const lane of lanes) {
    const project = focusLaneProjectKey(lane)
    if (!projectRanks.has(project)) { projectRanks.set(project, projectRanks.size); route.current.projects.push(project) }
    if (!laneRanks.has(lane.id)) { laneRanks.set(lane.id, laneRanks.size); route.current.lanes.push(lane.id) }
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
  return [...lanes].sort((a, b) => (pins.get(focusLaneProjectKey(a)) ?? pins.size) - (pins.get(focusLaneProjectKey(b)) ?? pins.size)
    || projectRanks.get(focusLaneProjectKey(a))! - projectRanks.get(focusLaneProjectKey(b))!
    || laneRanks.get(a.id)! - laneRanks.get(b.id)!)
}
