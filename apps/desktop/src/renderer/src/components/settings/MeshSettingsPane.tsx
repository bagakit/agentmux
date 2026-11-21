import { Button } from '@agentmux/client-ui/components/Button'
import { MeshPathsPane } from './MeshPathsPane'
import { ClusterMachinesPane } from './ClusterMachinesPane'
import type { SettingsPaneProps } from './settings-catalog'
import { useAppStore } from '../../store'
import './cluster-settings.css'

/** One overview for the visible network, with links to each original owner. */
export function MeshSettingsPane({ config, active, onNavigate }: SettingsPaneProps) {
  const separateRuntimeId = useAppStore(state => state.meshGatewayRuntimeId) ?? undefined
  const openConnection = (hostId: string) => onNavigate('network-node', 'connection', hostId)
  return <div className="cluster-workspace cluster-overview" data-cluster-page="mesh">
    <header className="cluster-overview-header">
      <div><h2>Network overview</h2><p>Explore your network, the paths it uses, and the machines you’ve saved.</p></div>
      <div className="cluster-actions">
        <Button type="button" variant="primary" onClick={() => onNavigate('remote-execution', 'mesh-join')}>Connect to a Relay Gateway</Button>
        <Button type="button" onClick={() => onNavigate('remote-execution', 'mesh-access-work')}>Open a device</Button>
        <a className="cluster-inline-link" href="#cluster-machine-resources" onClick={event => {
          event.preventDefault()
          const machines = event.currentTarget.closest('.cluster-workspace')?.querySelector<HTMLElement>('[data-settings-field="mesh-machines"]')
          machines?.scrollIntoView?.({ block: 'start' })
          machines?.focus({ preventScroll: true })
        }}>Machines <span aria-hidden="true">↓</span></a>
      </div>
    </header>
    <MeshPathsPane key={separateRuntimeId ?? 'original'} separateRuntimeId={separateRuntimeId} active={active}
      hosts={config.hosts} locations={config.meshMapLocations} onDevice={openConnection}
      onGateway={() => onNavigate('network-node', separateRuntimeId ? 'mesh-separate-gateway' : 'mesh-configuration')} />
    <ClusterMachinesPane hosts={config.hosts} active={active} onAddDevice={() => onNavigate('network-node', 'add-ssh')}
      onConnections={openConnection} />
  </div>
}
