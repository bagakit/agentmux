import { semanticIconComponent } from '@agentmux/client-ui/icons'
import { NetworkNodeSettingsPane } from '../NetworkNodeSettingsPane'
import type { SettingsModule } from '../settings-catalog'
export const networkNodeSettingsModule = {
  id: 'network-node', archetype: 'console', group: 'environment', title: 'Network node',
  description: 'Publish this device’s identity, resources and shared folders.',
  keywords: 'node network publish alias resources CPU RAM memory disk directory paths access permissions incoming tailcat listener key allowlist 组网 节点 发布',
  icon: semanticIconComponent('object.host'), savedSummary: () => 'This device · publishing and access',
  searchTargets: [{ id: 'publishing', title: 'Node alias and shared folders', kind: 'field' }, { id: 'incoming', title: 'Incoming connections and client keys', kind: 'field' }, { id: 'monitoring', title: 'Private service resources', kind: 'info' }],
  Pane: NetworkNodeSettingsPane
} as const satisfies SettingsModule
