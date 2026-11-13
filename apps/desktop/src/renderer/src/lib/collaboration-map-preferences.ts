import { createContext } from 'react'
import { DEFAULT_FOCUS_MAP_PREFERENCES } from '../../../shared/focus-map-preferences'

/** One presentation profile for bodies, routes, screen labels and input bounds. */
export const CollaborationMapPreferences = createContext(DEFAULT_FOCUS_MAP_PREFERENCES)
/** Region ids kept at full presence while an Agent is selected or previewed; null keeps all. */
export const CollaborationFocusRegions = createContext<ReadonlySet<string> | null>(null)
