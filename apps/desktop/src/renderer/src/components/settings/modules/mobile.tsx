import { semanticIconComponent } from '@agentmux/client-ui/icons'
import { DeviceManagementSettings } from '../DeviceManagementSettings'
import type { SettingsModule } from '../settings-catalog'

export const mobileSettingsModule = {
  id: 'mobile',
  group: 'remote',
  title: 'Mobile',
  description: 'Connect your phone or browser and manage device access.',
  icon: semanticIconComponent('object.phone'),
  keywords: 'phone browser mobile device relay access network 手机 浏览器 设备 连接 局域网',
  savedSummary: () => 'Phone and device access',
  Pane({ active }) {
    return <div className="settings-pane-stack settings-devices-pane"><DeviceManagementSettings active={active} /></div>
  }
} as const satisfies SettingsModule
