import { semanticIconComponent } from '@agentmux/client-ui/icons'
import { GeneralSettingsPane, type GeneralSettingsValues } from '../GeneralSettingsPane'
import type { SettingsModule } from '../settings-catalog'
import { saveConfigSlice } from '../save-config-slice'

const ThemeObjectSettingsIcon = semanticIconComponent('object.settings')


async function saveGeneralSettings(value: GeneralSettingsValues, expected: GeneralSettingsValues): Promise<void> {
  // Only an authored path choice is written; an unchanged one stays as the owner has it.
  const pathChange = value.copyPathsAsAbsolute !== expected.copyPathsAsAbsolute
  await saveConfigSlice((current, values: GeneralSettingsValues) => ({ ...current, ...(pathChange ? { copyPathsAsAbsolute: values.copyPathsAsAbsolute } : {}) }), value, expected)
}

export const generalSettingsModule = {
  id: 'general', archetype: 'preference',
  group: 'preferences',
  title: 'General',
  description: 'Project paths, local data, running versions, and diagnostics.',
  icon: ThemeObjectSettingsIcon,
  keywords: 'copy path clipboard home directory ~ tilde abbreviate absolute full shorten core runtime terminal tmux ssh show crash log session recovery',
  searchTargets: [
    { id: 'copy-paths', title: 'Project path display and copying', keywords: 'clipboard home directory ~ absolute full path' },
    { id: 'local-data', title: 'Local data', keywords: 'configuration machine storage', kind: 'info' },
    { id: 'session-recovery', title: 'Session recovery', keywords: 'restore tabs layouts running agents', kind: 'info' },
    { id: 'system-ssh', title: 'System SSH', keywords: 'remote private keys', kind: 'info' },
    { id: 'runtime-versions', title: 'App and kernel versions', keywords: 'about version build source commit Renderer Core protocol ctxmux 应用版本 内核版本 关于', kind: 'info' },
    { id: 'crash-log', title: 'Show crash log', keywords: 'crash log diagnostics local file', kind: 'action' },
  ],
  savedSummary: (config) => config.copyPathsAsAbsolute === true ? 'Absolute paths' : 'Home paths (~)',
  Pane({ config, onNavigate, active }) {
    return <GeneralSettingsPane active={active} copyPathsAsAbsolute={config.copyPathsAsAbsolute} onSave={saveGeneralSettings} onOpenRecovery={() => onNavigate('continuity')} onOpenHosts={() => onNavigate('hosts')} />
  }
} as const satisfies SettingsModule
