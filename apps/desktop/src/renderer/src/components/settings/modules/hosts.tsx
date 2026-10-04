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
  description: 'Connections, project folders, and remote access.',
  icon: Server,
  keywords: 'host hosts ssh remote hostname user port key test connection environment project folder workspace worktree register open',
  savedSummary: (config) => `${config.hosts.length} ${config.hosts.length === 1 ? 'environment' : 'environments'}`,
  Pane({ config, active, onClose, navigationRequest }) {
    return <HostSettingsPane config={config} onSave={saveHosts} active={active} onClose={onClose} navigationRequest={navigationRequest} />
  }
} as const satisfies SettingsModule
