import { semanticIconComponent } from '@agentmux/client-ui/icons'
import { RemoteExecutionSettingsPane } from '../RemoteExecutionSettingsPane'
import type { SettingsModule } from '../settings-catalog'

export const remoteExecutionSettingsModule = {
  id: 'remote-execution',
  group: 'remote',
  title: 'Remote execution',
  description: 'Run your Agent and its tools on the machines you choose.',
  keywords: 'remote execution agent runtime tools binding workspace project 双向 远程执行 运行端 工具',
  icon: semanticIconComponent('object.terminal'),
  savedSummary: () => 'Agent runtime · Project & tools',
  searchTargets: [
    { id: 'prepare', title: 'Prepare a remote Agent', kind: 'action' },
    { id: 'bindings', title: 'Original execution bindings', kind: 'info' }
  ],
  Pane: RemoteExecutionSettingsPane
} as const satisfies SettingsModule
