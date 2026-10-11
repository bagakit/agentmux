import { createContext } from 'react'
import type { SettingsPageId } from './SettingsPanel'

export type ConnectorSettingsOrigin = { sessionId: string; hostId: string; agentSessionId: string; connectionId?: string | undefined }
export type SettingsNavigationRequest = { section: SettingsPageId; executorId?: string | undefined; toolId?: string | undefined; hostId?: string | undefined; connectorOrigin?: ConnectorSettingsOrigin | undefined }

/** App owns the route; deep controls only request the existing settings surface. */
export const SettingsNavigation = createContext<{ open(section: SettingsPageId, executorId?: string): void; openToolkit(toolId: string): void; openHost(hostId: string): void; openConnector(origin: ConnectorSettingsOrigin): void; chooseAgent(): void } | null>(null)
