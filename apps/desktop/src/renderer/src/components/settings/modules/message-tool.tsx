import { type ComposerInputConfig } from '@agentmux/client-ui/composer-input-config'
import { semanticIconComponent } from '@agentmux/client-ui/icons'
import type { MessageToolInitialLayout } from '../../../../../shared/contracts'
import { MESSAGE_TOOL_INITIAL_LAYOUT_DEFAULT } from '../../../../../shared/contracts'
import { api } from '../../../lib/api'
import { useAppStore } from '../../../store'
import { MessageToolSettingsPane } from '../MessageToolSettingsPane'
import type { SettingsModule } from '../settings-catalog'

async function saveInitialLayout(messageToolInitialLayout: MessageToolInitialLayout, expected: MessageToolInitialLayout): Promise<void> {
  const current = useAppStore.getState().config
  if (!current) throw new Error('Configuration is unavailable. Your layout choice is kept; retry when configuration is available.')
  await api.config.save({ ...current, messageToolInitialLayout }, { ...current, messageToolInitialLayout: expected })
}

async function saveCompletion(messageToolCompletion: ComposerInputConfig, expected: ComposerInputConfig): Promise<void> {
  const current = useAppStore.getState().config
  if (!current) throw new Error('Configuration is unavailable. Your shortcut choices are kept; retry when configuration is available.')
  await api.config.save({ ...current, messageToolCompletion }, { ...current, messageToolCompletion: expected })
}

export const messageToolSettingsModule = {
  id: 'message-tool',
  group: 'message-tool',
  title: 'User Input',
  description: 'Input layout, shortcut prefixes, prompt suggestions and sending shortcuts.',
  icon: semanticIconComponent('object.user-input'),
  keywords: 'message tool composer user input initial layout one line two lines send immediately steer queue keyboard shortcuts enter draft skills commands files agents trigger prefix dollar slash at 技能 指令 文件 引用 快捷输入 用户输入 一行 两行 初始 发送 立即发送 快捷键',
  searchTargets: [
    { id: 'initial-layout', title: 'Initial layout', keywords: 'one line two lines input composer' },
    { id: 'completion-command', title: 'Commands prefix', keywords: 'shortcut input trigger symbol slash prompts' },
    { id: 'completion-skill', title: 'Skills prefix', keywords: 'shortcut input trigger symbol dollar' },
    { id: 'completion-reference', title: 'Agents & files prefix', keywords: 'shortcut input trigger symbol at references' },
    { id: 'completion-keywords', title: 'Suggest saved prompts by keyword', keywords: 'shortcut input suggestions bare keyword' },
    { id: 'message-shortcuts', title: 'Keyboard shortcuts', keywords: 'sending enter steer queue draft', kind: 'info' },
  ],
  savedSummary: config => `${(config.messageToolInitialLayout ?? MESSAGE_TOOL_INITIAL_LAYOUT_DEFAULT) === 'one-line' ? 'One-line' : 'Two-line'} input · Shortcut prefixes`,
  Pane({ config }) {
    return <MessageToolSettingsPane initialLayout={config.messageToolInitialLayout ?? MESSAGE_TOOL_INITIAL_LAYOUT_DEFAULT} onSave={saveInitialLayout} {...(config.messageToolCompletion ? { completion: config.messageToolCompletion } : {})} onSaveCompletion={saveCompletion} />
  }
} as const satisfies SettingsModule
