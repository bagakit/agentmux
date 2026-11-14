import { semanticIconComponent } from '@agentmux/client-ui/icons'
import type { AppConfig, HostConfig, WorkspaceRecord } from '../../../../../shared/contracts'
import { HostSettingsPane } from '../HostSettingsPane'
import type { SettingsModule } from '../settings-catalog'
import { saveConfigSlice } from '../save-config-slice'

const ThemeObjectHostIcon = semanticIconComponent('object.hosts')


async function saveHosts(hosts: HostConfig[], workspaces: WorkspaceRecord[], expected: Pick<AppConfig, 'hosts' | 'workspaces'>): Promise<void> {
  await saveConfigSlice((current, value: Pick<AppConfig, 'hosts' | 'workspaces'>) => ({ ...current, ...value }), { hosts, workspaces }, expected)
}

export const hostsSettingsModule = {
  id: 'hosts', archetype: 'console',
  group: 'cluster',
  title: 'Hosts',
  description: 'Your environments and their saved connections.',
  icon: ThemeObjectHostIcon,
  keywords: 'topology monitor runtime host hosts ssh tailcat tunnel listener remote hostname user port key test connection apps access trust permission environment project folder workspace worktree register open',
  savedSummary: (config) => `${config.hosts.length} ${config.hosts.length === 1 ? 'host' : 'hosts'}`,
  Pane({ config, active, onClose, onNavigate, navigationRequest }) {
    return <HostSettingsPane config={config} onSave={saveHosts} active={active} onClose={onClose} navigationRequest={navigationRequest} onRemoteWork={() => onNavigate('remote-execution')} />
  }
} as const satisfies SettingsModule
