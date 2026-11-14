import type { ConnectionHostingTarget, HostConfig } from '../../../shared/contracts'
import { createContext } from 'react'
import type { MotePreferencesTarget } from '@agentmux/core/mote-preferences'
import type { ConnectionApplication, ConnectionConfig, ConnectionSetupEnrollmentSource } from '@agentmux/core/connections'
import type { ChannelEntry, ChannelPresentation } from './settings/settings-catalog'
import type { SettingsPageId } from './SettingsPanel'

export type ChannelSettingsOrigin = { hostingTarget?: ConnectionHostingTarget | null; sessionId: string; hostId: string; agentSessionId: string; connection: Pick<ConnectionConfig, 'connectionId' | 'adapterId' | 'application'> }
export type MoteConnectionSettingsOrigin = { hostingTarget?: ConnectionHostingTarget | null; target: MotePreferencesTarget | null; topicId: string; moteName: string; setup?: { connectionId: string; source: ConnectionSetupEnrollmentSource } | undefined }
export type SettingsNavigationRequest = { section: SettingsPageId; field?: string | undefined; executorId?: string | undefined; toolId?: string | undefined; hostId?: string | undefined; channelOrigin?: ChannelSettingsOrigin | undefined; moteConnectionOrigin?: MoteConnectionSettingsOrigin | undefined }

/** Canonical incoming navigation names the configured local Host, never array order or a remote substitute. */
export function normalizeSettingsNavigationRequest(request: SettingsNavigationRequest, hosts: readonly Pick<HostConfig, 'id' | 'kind'>[]): SettingsNavigationRequest {
  if (request.field !== 'incoming' || request.section !== 'hosts' && request.section !== 'network-node') return request
  const requested = request.hostId === undefined ? undefined : hosts.find(host => host.id === request.hostId)
  if (request.hostId !== undefined && requested?.kind !== 'local') return request
  const locals = hosts.filter(host => host.kind === 'local')
  const local = requested ?? (locals.length === 1 ? locals[0] : undefined)
  if (!local) return request
  return request.section === 'hosts' && request.hostId === local.id ? request : { ...request, section: 'hosts', hostId: local.id }
}

/** App owns the route; deep controls only request the existing settings surface. */
export const SettingsNavigation = createContext<{ open(section: SettingsPageId, executorId?: string, field?: string, hostId?: string): void; openToolkit(toolId: string): void; openHost(hostId: string): void; openHostExecutors?(hostId: string): void; openChannel(origin: ChannelSettingsOrigin): void; channelEntries: readonly ChannelEntry[]; channelPresentation(application: ConnectionApplication, adapterId?: string): ChannelPresentation | null; openMoteConnection(origin: MoteConnectionSettingsOrigin): void; chooseAgent(): void } | null>(null)
