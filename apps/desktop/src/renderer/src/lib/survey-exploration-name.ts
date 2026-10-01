import { regionSurfaceLabel } from './region-display-name'
import { titleWorkbenchSurface, type WorkbenchTab } from './workbench-tabs'

/** Names describe a Survey binding; they never participate in entity addressing. */
export function restoredSurveyExplorationNames(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  return Object.fromEntries(Object.entries(value).flatMap(([zoneId, name]) =>
    zoneId.length > 0 && typeof name === 'string' && name.trim() ? [[zoneId, name.trim()]] : []))
}

export function surveyExplorationName(name: string | undefined, tabs: readonly WorkbenchTab[]): string {
  if (name?.trim()) return name.trim()
  const labels = new Set(tabs.map(tab => {
    const surface = titleWorkbenchSurface(tab)
    return tab.name?.trim() || (surface.kind === 'agent' ? 'Agent' : regionSurfaceLabel(surface, []))
  }).filter(Boolean))
  // A shared confirmed description is usable; distinct members have no authoritative Zone title.
  return labels.size === 1 ? [...labels][0]! : 'Untitled exploration'
}
