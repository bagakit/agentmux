import type { ConnectionHostingTarget, HostConfig } from '../../../shared/contracts'
import { createContext } from 'react'
import type { MotePreferencesTarget } from '@agentmux/core/mote-preferences'
import type { ConnectionApplication, ConnectionConfig, ConnectionSetupEnrollmentSource } from '@agentmux/core/connections'
import type { ChannelEntry, ChannelPresentation } from './settings/settings-catalog'
import type { SettingsPageId } from './SettingsPanel'

export type ChannelSettingsOrigin = { hostingTarget?: ConnectionHostingTarget | null; sessionId: string; hostId: string; agentSessionId: string; connection: Pick<ConnectionConfig, 'connectionId' | 'adapterId' | 'application'> }
export type MoteConnectionSettingsOrigin = { hostingTarget?: ConnectionHostingTarget | null; target: MotePreferencesTarget | null; topicId: string; moteName: string; connection?: Pick<ConnectionConfig, 'connectionId' | 'adapterId' | 'application'> | undefined; section?: SettingsPageId | undefined; setup?: { connectionId: string; source: ConnectionSetupEnrollmentSource } | undefined }
export type SettingsNavigationRequest = { section: SettingsPageId; field?: string | undefined; executorId?: string | undefined; toolId?: string | undefined; hostId?: string | undefined; publicSectionId?: 'hosts' | undefined; channelOrigin?: ChannelSettingsOrigin | undefined; moteConnectionOrigin?: MoteConnectionSettingsOrigin | undefined }

/** Stable Cluster addresses follow the owner and preserve the exact requested Host. */
export function normalizeSettingsNavigationRequest(request: SettingsNavigationRequest, hosts: readonly Pick<HostConfig, 'id' | 'kind'>[]): SettingsNavigationRequest {
  const { section, field, hostId } = request
  if (section !== 'hosts' && section !== 'network-node') return request
  if (field === 'incoming') {
    const locals = hosts.filter(host => host.kind === 'local')
    const localId = hostId ?? (locals.length === 1 ? locals[0]?.id : undefined)
    return { ...request, section: 'network-node', hostId: localId }
  }
  if (section === 'network-node') return request
  if (field === 'mesh-join' || field === 'mesh-access-work') return { ...request, section: 'remote-execution' }
  if (field === 'mesh-configuration' || field === 'mesh-link' || field === 'mesh-device-approval') return { ...request, section: 'network-node' }
  if (field === 'mesh-paths' || field === 'mesh-machines' || (!field && hostId === undefined)) return request
  return { ...request, section: 'network-node', field: field ?? 'connection' }
}

/** App owns the route; deep controls only request the existing settings surface. */
export const SettingsNavigation = createContext<{ open(section: SettingsPageId, executorId?: string, field?: string, hostId?: string): void; openToolkit(toolId: string): void; openHost(hostId: string): void; openHostExecutors?(hostId: string): void; openChannel(origin: ChannelSettingsOrigin): void; channelEntries: readonly ChannelEntry[]; channelPresentation(application: ConnectionApplication, adapterId?: string): ChannelPresentation | null; openMoteConnection(origin: MoteConnectionSettingsOrigin): void; chooseAgent(): void } | null>(null)
