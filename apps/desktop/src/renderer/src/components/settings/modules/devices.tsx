import { Smartphone } from 'lucide-react'
import { DeviceManagementSettings } from '../DeviceManagementSettings'
import type { SettingsModule } from '../settings-catalog'

export const devicesSettingsModule = {
  id: 'devices',
  group: 'connections',
  title: 'Phones & devices',
  description: 'Connect devices to this Mac and manage their access.',
  icon: Smartphone,
  keywords: 'phone mobile device connection relay access network 手机 设备 连接 局域网',
  savedSummary: () => 'Connection & devices',
  Pane({ active }) {
    return <div className="settings-pane-stack settings-devices-pane"><DeviceManagementSettings active={active} /></div>
  }
} as const satisfies SettingsModule
