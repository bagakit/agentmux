import { createContext } from 'react'
import type { SettingsSectionId } from './SettingsPanel'

/** App owns the route; deep controls only request the existing settings surface. */
export const SettingsNavigation = createContext<{ open(section: SettingsSectionId): void } | null>(null)
