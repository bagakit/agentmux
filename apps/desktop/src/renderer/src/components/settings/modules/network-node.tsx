import { NodePublicationIcon } from '../NodePublicationObservation'
import { NetworkNodeSettingsPane } from '../NetworkNodeSettingsPane'
import type { SettingsModule } from '../settings-catalog'
export const networkNodeSettingsModule = {
  id: 'network-node', archetype: 'console', group: 'cluster', title: 'Node',
  description: 'Manage a node’s identity, shared resources and folders.',
  keywords: 'node network publish alias resources CPU RAM memory disk directory paths access permissions incoming tailcat listener key allowlist 组网 节点 发布',
  icon: NodePublicationIcon, savedSummary: () => 'Identity, resources and sharing',
  searchTargets: [{ id: 'publishing', title: 'Node alias and shared folders', kind: 'field' }, { id: 'incoming', title: 'Incoming connections and client keys', kind: 'field' }, { id: 'monitoring', title: 'Private service resources', kind: 'info' }],
  Pane: NetworkNodeSettingsPane
} as const satisfies SettingsModule
