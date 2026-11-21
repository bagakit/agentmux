import { semanticIconComponent } from '@agentmux/client-ui/icons'
import { ClusterQuickSettingsPane } from '../quick/ClusterQuickSettingsPane'
import type { SettingsModule } from '../settings-catalog'

export const remoteExecutionSettingsModule = {
  id: 'remote-execution', archetype: 'console', group: 'cluster', title: 'Quick',
  description: 'Get connected and work across devices, step by step.',
  keywords: 'onboarding setup relay gateway pair identity open device work agent remote execution prepare resume guide 接入 向导 远程',
  icon: semanticIconComponent('object.remote-execution'),
  savedSummary: () => 'Connect, share and work across devices',
  searchTargets: [
    { id: 'mesh-join', title: 'Connect to a Relay Gateway', kind: 'action' },
    { id: 'mesh-share', title: 'Share a device', kind: 'action' },
    { id: 'mesh-access-work', title: 'Open a device by access link', kind: 'action' },
    { id: 'prepare', title: 'Start cross-device work in Launcher', kind: 'action' },
    { id: 'guide', title: 'Step-by-step remote execution guide', kind: 'info' },
    { id: 'bindings', title: 'Continue existing remote work', kind: 'info' },
    { id: 'routes', title: 'Direct and delegated work routes', kind: 'field' }
  ],
  Pane: ClusterQuickSettingsPane
} as const satisfies SettingsModule
