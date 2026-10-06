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

export const messageToolSettingsModule = {
  id: 'message-tool',
  group: 'message-tool',
  title: 'Input & Mailbox',
  description: 'Input layout, sending shortcuts, and each Agent’s mailbox.',
  icon: semanticIconComponent('object.inbox'),
  keywords: 'message tool composer input initial layout one line two lines send immediately steer queue mailbox inbox outbox history source keyboard shortcuts enter draft 一行 两行 初始 发送 立即发送 邮箱 历史 快捷键',
  savedSummary: config => `${(config.messageToolInitialLayout ?? MESSAGE_TOOL_INITIAL_LAYOUT_DEFAULT) === 'one-line' ? 'One-line' : 'Two-line'} input · Per-Agent mailbox`,
  Pane({ config }) {
    return <MessageToolSettingsPane initialLayout={config.messageToolInitialLayout ?? MESSAGE_TOOL_INITIAL_LAYOUT_DEFAULT} onSave={saveInitialLayout} />
  }
} as const satisfies SettingsModule
