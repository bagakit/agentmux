import { createContext } from 'react'
import type { SettingsPageId } from './SettingsPanel'

/** App owns the route; deep controls only request the existing settings surface. */
export const SettingsNavigation = createContext<{ open(section: SettingsPageId, executorId?: string): void } | null>(null)
