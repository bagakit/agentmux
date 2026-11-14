import { semanticIconComponent } from '@agentmux/client-ui/icons'
import type { AppConfig, HostConfig, WorkspaceRecord } from '../../../../../shared/contracts'
import { MeshSettingsPane } from '../MeshSettingsPane'
import type { SettingsModule } from '../settings-catalog'
import { saveConfigSlice } from '../save-config-slice'

const ThemeObjectHostIcon = semanticIconComponent('object.hosts')


async function saveHosts(hosts: HostConfig[], workspaces: WorkspaceRecord[], expected: Pick<AppConfig, 'hosts' | 'workspaces'>): Promise<void> {
  await saveConfigSlice((current, value: Pick<AppConfig, 'hosts' | 'workspaces'>) => ({ ...current, ...value }), { hosts, workspaces }, expected)
}

export const hostsSettingsModule = {
  id: 'hosts', archetype: 'console',
  group: 'cluster',
  title: 'Mesh',
  description: 'Connect your devices through gateways and manage saved connections.',
  icon: ThemeObjectHostIcon,
  keywords: 'mesh gateway participant peer network route topology monitor runtime host hosts ssh tailcat tunnel listener remote hostname user port key test connection apps access trust permission environment project folder workspace worktree register open',
  searchTargets: [{ id: 'mesh-configuration', title: 'Mesh participation', description: 'Network role, peer trust and device access.', kind: 'field' }, { id: 'mesh-link', title: 'Original node access link', description: 'Reach an original endpoint through this Mesh gateway.', kind: 'action' }],
  savedSummary: (config) => `${config.hosts.length} saved ${config.hosts.length === 1 ? 'connection' : 'connections'}`,
  Pane({ config, active, onClose, onNavigate, navigationRequest }) {
    return <MeshSettingsPane config={config} onSave={saveHosts} active={active} onClose={onClose} navigationRequest={navigationRequest} onRemoteWork={() => onNavigate('remote-execution')} />
  }
} as const satisfies SettingsModule
