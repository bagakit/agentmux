import { semanticIconComponent } from '@agentmux/client-ui/icons'
import { BUILT_IN_AGENT_PROVIDER_IDS } from '@agentmux/core/provider-id'
import type { AgentExecutorConfig } from '../../../../../shared/contracts'
import { AgentSettingsPane } from '../AgentSettingsPane'
import type { SettingsModule } from '../settings-catalog'
import { saveConfigSlice } from '../save-config-slice'

const ThemeObjectAgentIcon = semanticIconComponent('object.agent')


// Provider search terms follow the Core source of truth.
const AGENT_PROVIDER_KEYWORDS = BUILT_IN_AGENT_PROVIDER_IDS.map((id) => id.toLowerCase()).join(' ')

async function saveExecutors(executors: Record<string, AgentExecutorConfig>, expected: Record<string, AgentExecutorConfig>): Promise<void> {
  await saveConfigSlice((current, value: Record<string, AgentExecutorConfig>) => ({ ...current, executors: value }), executors, expected)
}

export const agentsSettingsModule = {
  id: 'agents', archetype: 'library',
  group: 'agents',
  title: 'Agent CLIs',
  overviewShortcut: 2,
  description: 'Providers, CLI availability and launch configurations.',
  subpages: [{ field: 'providers', title: 'Providers' }, { field: 'executors', title: 'Executors' }],
  searchTargets: [
    { id: 'providers', title: 'Provider capabilities', keywords: 'compare history streaming permissions resume adapter', kind: 'info' },
    { id: 'host-executors', title: 'Host Executors and managed Hooks', keywords: 'check hook update configuration workspace scope', kind: 'info' }
  ],
  icon: ThemeObjectAgentIcon,
  keywords: `${AGENT_PROVIDER_KEYWORDS} agent agents cli clis executor launch startup command args env installed provider`,
  savedSummary(config) {
    const count = Object.keys(config.executors).length
    return `${count} ${count === 1 ? 'executor' : 'executors'}`
  },
  Pane({ config, active, executorId, navigationRequest, onSubpageChange }) {
    return <AgentSettingsPane config={config} onSave={saveExecutors} active={active} executorId={executorId} navigationRequest={navigationRequest} onSubpageChange={onSubpageChange} />
  }
} as const satisfies SettingsModule
