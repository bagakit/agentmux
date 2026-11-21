import { NodePublicationIcon } from '../NodePublicationObservation'
import { NetworkNodeSettingsPane } from '../NetworkNodeSettingsPane'
import type { SettingsModule } from '../settings-catalog'
export const networkNodeSettingsModule = {
  id: 'network-node', archetype: 'console', group: 'cluster', title: 'Node',
  description: 'Choose what a node publishes to other devices.',
  keywords: 'node network publish alias resources CPU RAM memory disk directory paths access permissions 组网 节点 发布',
  icon: NodePublicationIcon, savedSummary: () => 'Publish identity, folders and resources',
  searchTargets: [{ id: 'publishing', title: 'Node alias and shared folders', kind: 'field' }, { id: 'monitoring', title: 'Private service resources', kind: 'info' }],
  Pane: NetworkNodeSettingsPane
} as const satisfies SettingsModule
