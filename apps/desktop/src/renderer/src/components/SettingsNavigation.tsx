import { createContext } from 'react'
import type { MotePreferencesTarget } from '@agentmux/core/mote-preferences'
import type { ConnectionSetupEnrollmentSource } from '@agentmux/core/connections'
import type { SettingsPageId } from './SettingsPanel'

export type ConnectorSettingsOrigin = { sessionId: string; hostId: string; agentSessionId: string; connectionId?: string | undefined }
export type MoteConnectorSettingsOrigin = { target: MotePreferencesTarget | null; topicId: string; moteName: string; setup?: { connectionId: string; source: ConnectionSetupEnrollmentSource } | undefined }
export type SettingsNavigationRequest = { section: SettingsPageId; executorId?: string | undefined; toolId?: string | undefined; hostId?: string | undefined; connectorOrigin?: ConnectorSettingsOrigin | undefined; moteConnectorOrigin?: MoteConnectorSettingsOrigin | undefined }

/** App owns the route; deep controls only request the existing settings surface. */
export const SettingsNavigation = createContext<{ open(section: SettingsPageId, executorId?: string): void; openToolkit(toolId: string): void; openHost(hostId: string): void; openConnector(origin: ConnectorSettingsOrigin): void; openMoteConnector(origin: MoteConnectorSettingsOrigin): void; chooseAgent(): void } | null>(null)
