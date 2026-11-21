import { NodePublicationIcon } from '../NodePublicationObservation'
import { ClusterNodeSettingsPane } from '../ClusterNodeSettingsPane'
import type { SettingsModule } from '../settings-catalog'

export const networkNodeSettingsModule = {
  id: 'network-node', archetype: 'console', group: 'cluster', title: 'Node',
  description: 'Manage identity, access and connection settings.',
  keywords: 'node publish identity alias shared resources directories paths access permissions listener relay gateway tailcat ssh host hostname user port key projects trust 节点 发布 权限',
  icon: NodePublicationIcon,
  savedSummary: () => 'Identity, Gateway, Tailcat and SSH',
  searchTargets: [
    { id: 'publishing', title: 'Node identity and published folders', kind: 'field' },
    { id: 'monitoring', title: 'Private service resources', kind: 'info' },
    { id: 'mesh-configuration', title: 'Gateway settings', description: 'Network role, peer trust and Relay addresses.', kind: 'field' },
    { id: 'mesh-link', title: 'Original node access link', description: 'Create a link to an original endpoint.', kind: 'action' },
    { id: 'mesh-device-approval', title: 'Approve a device key', kind: 'field' },
    { id: 'incoming', title: 'Tailcat incoming connections and client keys', kind: 'field' },
    { id: 'mesh-devices', title: 'Manage saved SSH and Tailcat connections', kind: 'field' },
    { id: 'add-ssh', title: 'Add an SSH connection', kind: 'action' }
  ],
  Pane: ClusterNodeSettingsPane
} as const satisfies SettingsModule
