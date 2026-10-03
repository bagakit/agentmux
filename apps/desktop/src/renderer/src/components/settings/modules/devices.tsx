import { Smartphone } from 'lucide-react'
import { DeviceManagementSettings } from '../DeviceManagementSettings'
import type { SettingsModule } from '../settings-catalog'

export const devicesSettingsModule = {
  id: 'devices',
  group: 'connections',
  title: '手机与设备',
  description: '复制链接连接手机，查看设备和最近操作。',
  icon: Smartphone,
  keywords: 'phone mobile device connection relay access network 手机 设备 连接 局域网',
  savedSummary: () => '连接手机与管理设备',
  Pane({ active }) {
    return <div className="settings-pane-stack settings-devices-pane"><DeviceManagementSettings active={active} /></div>
  }
} as const satisfies SettingsModule
