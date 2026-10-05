import { semanticIconComponent } from '@agentmux/client-ui/icons'
import { DeviceManagementSettings } from '../DeviceManagementSettings'
import type { SettingsModule } from '../settings-catalog'

const ThemeObjectPhoneIcon = semanticIconComponent('object.phone')


export const devicesSettingsModule = {
  id: 'devices',
  group: 'connections',
  title: 'Phone & Devices',
  description: 'Connect your phone and review devices and recent activity.',
  icon: ThemeObjectPhoneIcon,
  keywords: 'phone mobile device connection relay access network 手机 设备 连接 局域网',
  savedSummary: () => 'Phone connections and device access',
  Pane({ active }) {
    return <div className="settings-pane-stack settings-devices-pane"><DeviceManagementSettings active={active} /></div>
  }
} as const satisfies SettingsModule
