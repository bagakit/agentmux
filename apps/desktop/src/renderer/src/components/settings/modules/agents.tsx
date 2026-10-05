import { semanticIconComponent } from '@agentmux/client-ui/icons'
import { BUILT_IN_AGENT_PROVIDER_IDS } from '@agentmux/core/provider-id'
import type { AgentExecutorConfig } from '../../../../../shared/contracts'
import { api } from '../../../lib/api'
import { useAppStore } from '../../../store'
import { AgentSettingsPane } from '../AgentSettingsPane'
import type { SettingsModule } from '../settings-catalog'

const ThemeObjectAgentIcon = semanticIconComponent('object.agent')


// Provider search terms follow the Core source of truth.
const AGENT_PROVIDER_KEYWORDS = BUILT_IN_AGENT_PROVIDER_IDS.map((id) => id.toLowerCase()).join(' ')

async function saveExecutors(executors: Record<string, AgentExecutorConfig>, expected: Record<string, AgentExecutorConfig>): Promise<void> {
  const current = useAppStore.getState().config
  if (!current) return
  await api.config.save({ ...current, executors }, { ...current, executors: expected })
}

export const agentsSettingsModule = {
  id: 'agents',
  group: 'resources',
  title: 'Agents',
  description: 'Reusable executors for your next agent session.',
  icon: ThemeObjectAgentIcon,
  keywords: `${AGENT_PROVIDER_KEYWORDS} executor command args env installed provider`,
  savedSummary(config) {
    const count = Object.keys(config.executors).length
    return `${count} ${count === 1 ? 'executor' : 'executors'}`
  },
  Pane({ config, active, executorId, navigationRequest }) {
    return <AgentSettingsPane config={config} onSave={saveExecutors} active={active} executorId={executorId} navigationRequest={navigationRequest} />
  }
} as const satisfies SettingsModule
