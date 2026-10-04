import { useContext } from 'react'
import { useAppStore } from '../store'
import { runtimeEndpointNotice } from '../lib/runtime-endpoint-notice'
import { ServiceNoticeDisclosure } from './ServiceNoticeDisclosure'
import { ServiceWindowNotice } from './ServiceWindowNotice'
import { SettingsNavigation } from './SettingsNavigation'

/** Automatic connection facts stay visible without opening the notification inbox. */
export function RemoteCoreUpgradeNotices() {
  const warnings = useAppStore(state => state.runtimeEndpointWarnings)
  const config = useAppStore(state => state.config)
  const settings = useContext(SettingsNavigation)
  const upgrades = (warnings ?? []).filter(warning => warning.code === 'REMOTE_CORE_UPGRADE_REQUIRED').map(warning => ({ warning, item: runtimeEndpointNotice(warning,
    config?.hosts.find(host => host.id === warning.hostId)?.label ?? warning.hostId, hostId => settings?.openHost(hostId)) }))
  if (!upgrades.length) return null
  return <div className="remote-core-upgrade-notices">
    {upgrades.map(({ item }) => <ServiceNoticeDisclosure key={item.id} scope="global:runtime-endpoints"
      notices={[item]} available={warnings !== undefined} complete={false} title={item.summary?.step ?? item.notice.notice.step} persistentTitle
      inlineActions={<button type="button" className="small-button" onClick={item.action!.run}>{item.action!.label}</button>}>
      <ServiceWindowNotice notice={item.notice} />
    </ServiceNoticeDisclosure>)}
  </div>
}
