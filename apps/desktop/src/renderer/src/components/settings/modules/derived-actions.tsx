import { semanticIconComponent } from '@agentmux/client-ui/icons'
import { AGENT_BUILT_IN_DERIVED_ACTIONS, type AgentDerivedActionsConfig } from '@agentmux/core/agent-derived-actions'
import { api } from '../../../lib/api'
import { useAppStore } from '../../../store'
import { DerivedActionsSettingsPane } from '../DerivedActionsSettingsPane'
import type { SettingsModule } from '../settings-catalog'

const DerivedActionsIcon = semanticIconComponent('object.derived-actions')

// Absent keys stay absent: no custom actions and every official action visible is the default.
async function saveDerivedActions(next: AgentDerivedActionsConfig, expected: AgentDerivedActionsConfig): Promise<void> {
  const current = useAppStore.getState().config
  if (!current) return
  const write = (value: AgentDerivedActionsConfig) => {
    const { agentDerivedActions: _drop, ...rest } = current
    return value.actions || value.hidden ? { ...rest, agentDerivedActions: value } : rest
  }
  await api.config.save(write(next), write(expected))
}

export const derivedActionsSettingsModule = {
  id: 'derived-actions',
  group: 'agents',
  title: 'Derived actions',
  description: 'Start new work from an Agent: official Take over, Fork and Pass on experience, plus your own.',
  icon: DerivedActionsIcon,
  keywords: 'derived action take over takeover fork pass on experience learning review second agent menu custom instruction handover',
  savedSummary(config) {
    const shown = AGENT_BUILT_IN_DERIVED_ACTIONS.length - (config.agentDerivedActions?.hidden?.length ?? 0)
    const own = config.agentDerivedActions?.actions?.length ?? 0
    return `${shown} official · ${own} custom`
  },
  Pane({ config, active }) {
    return <DerivedActionsSettingsPane config={config} active={active} onSave={saveDerivedActions} />
  }
} as const satisfies SettingsModule
