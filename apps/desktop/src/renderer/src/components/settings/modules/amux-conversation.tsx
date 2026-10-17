import { semanticIconComponent } from '@agentmux/client-ui/icons'
import { DeviceManagementSettings } from '../DeviceManagementSettings'
import type { SettingsModule } from '../settings-catalog'

const ThemeObjectPhoneIcon = semanticIconComponent('object.phone')

export const amuxConversationSettingsModule = {
  id: 'amux-conversation',
  group: 'conversation-channels',
  title: 'Amux Conversation',
  description: 'Talk with your Agents here, on your phone or in a browser.',
  icon: ThemeObjectPhoneIcon,
  keywords: 'amux native conversation desktop phone browser mobile device relay access network 本地 对话 手机 浏览器 设备 连接 局域网',
  savedSummary: () => 'Native conversations and device access',
  Pane({ active, onNavigate }) {
    return <div className="settings-pane-stack settings-devices-pane"><DeviceManagementSettings active={active} /><section className="settings-group"><header><span>Input preferences</span></header><p className="settings-group-note">Customize your input layout and shortcuts in Input &amp; Mailbox.</p><button className="small-button" onClick={() => onNavigate('message-tool')}>Open Input &amp; Mailbox</button></section></div>
  }
} as const satisfies SettingsModule
