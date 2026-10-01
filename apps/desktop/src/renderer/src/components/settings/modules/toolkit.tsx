import { Wrench } from 'lucide-react'
import type { ToolkitToolDefinition } from '@agentmux/core/control'
import { api } from '../../../lib/api'
import { useAppStore } from '../../../store'
import { resolvePerformancePreferences, type PerformancePreferences } from '../../../../../shared/toolkit-preferences'
import { ToolkitSettingsPane } from '../ToolkitSettingsPane'
import type { SettingsModule } from '../settings-catalog'

async function savePerformance(performance: PerformancePreferences, expected: PerformancePreferences): Promise<void> {
  const current = useAppStore.getState().config
  if (!current) throw new Error('Settings are not loaded. Your draft is kept.')
  await api.config.save(
    { ...current, toolkit: { ...current.toolkit, performance } },
    { ...current, toolkit: { ...current.toolkit, performance: expected } }
  )
}

export const toolkitSettingsModule = {
  id: 'toolkit', group: 'preferences', title: 'Toolkit', icon: Wrench,
  description: 'Local tools and results, right where you work.',
  keywords: 'performance cpu memory rss process resource toolkit tool built in script javascript directory arguments status bar icon label',
  savedSummary(config) {
    const preferences = resolvePerformancePreferences(config)
    const count = config.toolkit?.tools?.length ?? 0
    return `${count} ${count === 1 ? 'user tool' : 'user tools'} · ${preferences.enabled ? 'Performance available' : 'Performance hidden'}`
  },
  Pane({ config, active, toolId, navigationRequest }) {
    return <ToolkitSettingsPane performance={resolvePerformancePreferences(config)} tools={config.toolkit?.tools ?? []} toolId={toolId} navigationRequest={navigationRequest} active={active} onSave={savePerformance}
      writer={{ add: async (id, value) => (await api.toolkit.add(id, value)).definition, update: async (id, changes, expected) => (await api.toolkit.update(id, changes, expected)).definition }}
      onRemoveTool={async (id, expected) => { await api.toolkit.remove(id, expected) }} onRunTool={runSavedTool} />
  }
} as const satisfies SettingsModule

async function runSavedTool(definition: ToolkitToolDefinition): Promise<string> {
  const snapshot = await api.toolkit.get(definition.id)
  if (snapshot.kind !== 'script') throw new Error('This tool is not a user script.')
  if (snapshot.admission) throw new Error(snapshot.admission.state === 'unknown' ? 'Execution unconfirmed. Check this tool’s status before running again.' : 'This tool already has an execution in progress.')
  const result = await api.toolkit.run(definition.id, { invocationId: crypto.randomUUID(), expectedRevision: definition.revision, expectedLatestExecutionId: snapshot.latestConfirmed?.executionId ?? null })
  if (result.kind !== 'script') throw new Error('The execution result could not be confirmed.')
  return result.state === 'unknown' ? 'Execution unconfirmed. Open this tool in the status bar to check its status.' : 'Execution admitted. View its actual result in the status bar.'
}
