import { useContext } from 'react'
import { useAppStore } from '../store'
import { runtimeEndpointNotice } from '../lib/runtime-endpoint-notice'
import { ServiceWindowNotice } from './ServiceWindowNotice'
import { SettingsNavigation } from './SettingsNavigation'

/** Automatic connection facts stay visible without opening the notification inbox. */
export function RemoteCoreUpgradeNotices() {
  const warnings = useAppStore(state => state.runtimeEndpointWarnings)
  const config = useAppStore(state => state.config)
  const settings = useContext(SettingsNavigation)
  const upgrades = (warnings ?? []).filter(warning => warning.code === 'REMOTE_CORE_UPGRADE_REQUIRED')
  if (!upgrades.length) return null
  return <div className="remote-core-upgrade-notices">
    {upgrades.map(warning => {
      const item = runtimeEndpointNotice(warning, config?.hosts.find(host => host.id === warning.hostId)?.label ?? warning.hostId,
        hostId => settings?.openHost(hostId))
      return <ServiceWindowNotice key={item.id} notice={item.notice} {...(item.summary ? { summary: item.summary } : {})}
        actions={<button type="button" className="small-button" onClick={item.action!.run}>{item.action!.label}</button>} />
    })}
  </div>
}
