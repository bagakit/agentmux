import { semanticIconComponent } from '@agentmux/client-ui/icons'
import type { AppConfig, HostConfig, WorkspaceRecord } from '../../../../../shared/contracts'
import { MeshSettingsPane } from '../MeshSettingsPaneEntry'
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
  description: '',
  subpages: [{ field: 'mesh-configuration', title: 'Gateways' }, { field: 'mesh-machines', title: 'Machines' }, { field: 'mesh-devices', title: 'Device connections' }],
  icon: ThemeObjectHostIcon,
  keywords: 'machines CPU memory storage volume resources cluster paths mesh gateway participant peer network route topology monitor runtime host hosts ssh tailcat tunnel listener remote hostname user port key test connection apps access trust permission environment project folder workspace worktree register open',
  searchTargets: [{ id: 'mesh-paths', title: 'Mesh network overview', description: 'Network topology, paths and saved devices.', kind: 'info' }, { id: 'mesh-machines', title: 'Cluster machine resources', description: 'CPU, memory, storage volume and sample coverage.', kind: 'info' }, { id: 'mesh-configuration', title: 'Mesh participation', description: 'Network role, peer trust and device access.', kind: 'field' }, { id: 'mesh-link', title: 'Original node access link', description: 'Reach an original endpoint through this Mesh gateway.', kind: 'action' }, { id: 'mesh-access-work', title: 'Use another device', description: 'Open its gateway access link.', kind: 'action' }, { id: 'incoming', title: 'Incoming connections and client keys', kind: 'field' }],
  savedSummary: (config) => `${config.hosts.length} saved ${config.hosts.length === 1 ? 'connection' : 'connections'}`,
  Pane({ config, active, onClose, onNavigate, navigationRequest, onSubpageChange }) {
    return <MeshSettingsPane config={config} onSave={saveHosts} active={active} onClose={onClose} navigationRequest={navigationRequest} onSubpageChange={onSubpageChange} onRemoteWork={() => onNavigate('remote-execution')} onBack={() => onNavigate('overview')} />
  }
} as const satisfies SettingsModule
