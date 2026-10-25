import type { ConnectionHostingTarget } from '../../../shared/contracts'
import { createContext } from 'react'
import type { MotePreferencesTarget } from '@agentmux/core/mote-preferences'
import type { ConnectionApplication, ConnectionConfig, ConnectionSetupEnrollmentSource } from '@agentmux/core/connections'
import type { ChannelEntry, ChannelPresentation } from './settings/settings-catalog'
import type { SettingsPageId } from './SettingsPanel'

export type ChannelSettingsOrigin = { hostingTarget?: ConnectionHostingTarget | null; sessionId: string; hostId: string; agentSessionId: string; connection: Pick<ConnectionConfig, 'connectionId' | 'adapterId' | 'application'> }
export type MoteLarkSettingsOrigin = { hostingTarget?: ConnectionHostingTarget | null; target: MotePreferencesTarget | null; topicId: string; moteName: string; setup?: { connectionId: string; source: ConnectionSetupEnrollmentSource } | undefined }
export type SettingsNavigationRequest = { section: SettingsPageId; field?: string | undefined; executorId?: string | undefined; toolId?: string | undefined; hostId?: string | undefined; channelOrigin?: ChannelSettingsOrigin | undefined; moteLarkOrigin?: MoteLarkSettingsOrigin | undefined }

/** App owns the route; deep controls only request the existing settings surface. */
export const SettingsNavigation = createContext<{ open(section: SettingsPageId, executorId?: string, field?: string): void; openToolkit(toolId: string): void; openHost(hostId: string): void; openHostExecutors?(hostId: string): void; openChannel(origin: ChannelSettingsOrigin): void; channelEntries: readonly ChannelEntry[]; channelPresentation(application: ConnectionApplication, adapterId?: string): ChannelPresentation | null; openMoteLark(origin: MoteLarkSettingsOrigin): void; chooseAgent(): void } | null>(null)
