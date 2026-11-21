import { semanticIconComponent } from '@agentmux/client-ui/icons'
import { MeshSettingsPane } from '../MeshSettingsPaneEntry'
import type { SettingsModule } from '../settings-catalog'

export const hostsSettingsModule = {
  id: 'hosts', archetype: 'console', group: 'cluster', title: 'Mesh',
  description: 'See how this device participates in the network.',
  icon: semanticIconComponent('object.hosts'),
  keywords: 'mesh topology gateway paths routes peers device status machines CPU memory storage resources cluster network map 组网 拓扑',
  searchTargets: [
    { id: 'mesh-paths', title: 'Mesh network overview', description: 'Network topology, paths and saved devices.', kind: 'info' },
    { id: 'mesh-machines', title: 'Cluster machine resources', description: 'CPU, memory, storage volume and sample coverage.', kind: 'info' }
  ],
  savedSummary: config => `${config.hosts.length} saved ${config.hosts.length === 1 ? 'connection' : 'connections'}`,
  Pane: props => <MeshSettingsPane {...props} onBack={() => props.onNavigate('overview')} />
} as const satisfies SettingsModule
