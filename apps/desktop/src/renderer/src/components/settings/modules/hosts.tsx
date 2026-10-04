import { Server } from 'lucide-react'
import type { AppConfig, HostConfig, WorkspaceRecord } from '../../../../../shared/contracts'
import { api } from '../../../lib/api'
import { useAppStore } from '../../../store'
import { HostSettingsPane } from '../HostSettingsPane'
import type { SettingsModule } from '../settings-catalog'

async function saveHosts(hosts: HostConfig[], workspaces: WorkspaceRecord[], expected: Pick<AppConfig, 'hosts' | 'workspaces'>): Promise<void> {
  const current = useAppStore.getState().config
  if (!current) return
  await api.config.save({ ...current, hosts, workspaces }, { ...current, ...expected })
}

export const hostsSettingsModule = {
  id: 'hosts',
  group: 'connections',
  title: 'Environments',
  description: 'Local and SSH connections for your workspace.',
  icon: Server,
  keywords: 'host hosts ssh remote hostname user port key test connection environment project',
  savedSummary: (config) => `${config.hosts.length} ${config.hosts.length === 1 ? 'environment' : 'environments'}`,
  Pane({ config, active }) {
    return <HostSettingsPane config={config} onSave={saveHosts} active={active} />
  }
} as const satisfies SettingsModule
