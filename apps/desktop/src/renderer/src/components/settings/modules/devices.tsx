import { Smartphone } from 'lucide-react'
import { DeviceManagementSettings } from '../DeviceManagementSettings'
import type { SettingsModule } from '../settings-catalog'

export const devicesSettingsModule = {
  id: 'devices',
  group: 'connections',
  title: 'Phones & devices',
  description: 'Connect devices to this Mac and manage their access.',
  icon: Smartphone,
  keywords: 'phone mobile device invite pairing access certificate private network 手机 设备 授权 邀请',
  savedSummary: () => 'Pairing & access',
  Pane({ active }) {
    return <div className="settings-pane-stack settings-devices-pane"><DeviceManagementSettings active={active} /></div>
  }
} as const satisfies SettingsModule
