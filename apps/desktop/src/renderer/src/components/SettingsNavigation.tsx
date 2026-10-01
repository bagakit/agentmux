import { createContext } from 'react'
import type { SettingsPageId } from './SettingsPanel'

export type SettingsNavigationRequest = { section: SettingsPageId; executorId?: string | undefined; toolId?: string | undefined }

/** App owns the route; deep controls only request the existing settings surface. */
export const SettingsNavigation = createContext<{ open(section: SettingsPageId, executorId?: string): void; openToolkit(toolId: string): void } | null>(null)
