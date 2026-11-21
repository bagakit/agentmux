import { useId, useLayoutEffect, useRef, useState } from 'react'
import { Button } from '@agentmux/client-ui/components/Button'
import { Tabs } from '@agentmux/client-ui/components/Tabs'
import type { AppConfig, HostConfig, WorkspaceRecord } from '../../../../shared/contracts'
import { HostSettingsPane, type HostAddRequest } from './HostSettingsPane'
import { LocalIncomingConnections } from './LocalIncomingConnections'
import { MeshNetworkSettings } from './MeshNetworkSettings'
import { NetworkNodeSettingsPane } from './NetworkNodeSettingsPane'
import { saveConfigSlice } from './save-config-slice'
import type { SettingsPaneProps } from './settings-catalog'
import './cluster-settings.css'

const tabs = [
  { id: 'publishing', title: 'Identity & access' },
  { id: 'mesh-configuration', title: 'Gateway' },
  { id: 'incoming', title: 'Tailcat' },
  { id: 'mesh-devices', title: 'SSH' },
] as const

type NodeTab = typeof tabs[number]['id']
const gatewayFields = new Set(['mesh-configuration', 'mesh-link', 'mesh-device-approval', 'mesh-separate-gateway'])

function nodeTab(field?: string): NodeTab {
  if (!field || field === 'publishing' || field === 'monitoring') return 'publishing'
  if (gatewayFields.has(field)) return 'mesh-configuration'
  if (field === 'incoming') return 'incoming'
  return 'mesh-devices'
}

async function saveHosts(hosts: HostConfig[], workspaces: WorkspaceRecord[], expected: Pick<AppConfig, 'hosts' | 'workspaces'>) {
  await saveConfigSlice((current, value: Pick<AppConfig, 'hosts' | 'workspaces'>) => ({ ...current, ...value }), { hosts, workspaces }, expected)
}

export function ClusterNodeSettingsPane(props: SettingsPaneProps) {
  const { config, active, onNavigate, navigationRequest, onSubpageChange } = props
  const applied = useRef(navigationRequest)
  const request = active ? navigationRequest : applied.current
  const processedAdd = useRef<SettingsPaneProps['navigationRequest']>(undefined)
  const addCount = useRef(0)
  const [addHost, setAddHost] = useState<HostAddRequest>()
  const [tab, setTab] = useState(() => nodeTab(request?.field))
  const selected = applied.current !== request && request ? nodeTab(request.field) : tab
  const [visited, setVisited] = useState<ReadonlySet<NodeTab>>(() => new Set([selected]))
  const id = useId()
  const locals = config.hosts.filter(host => host.kind === 'local')
  const local = locals.length === 1 ? locals[0] : undefined
  const tailcatUnavailable = request?.field === 'incoming' && request.hostId !== undefined && request.hostId !== local?.id
  const sshRequest = nodeTab(request?.field) === 'mesh-devices' ? request : undefined
  const gatewayRequest = nodeTab(request?.field) === 'mesh-configuration' ? request : undefined
  const publicationRequest = nodeTab(request?.field) === 'publishing' ? request : undefined

  useLayoutEffect(() => {
    if (!active) return
    if (applied.current !== request) {
      applied.current = request
      if (request) setTab(nodeTab(request.field))
      setAddHost(undefined)
    }
    if (request?.field === 'add-ssh' && processedAdd.current !== request) {
      processedAdd.current = request
      addCount.current += 1
      setAddHost({ intentId: `${id}/${addCount.current}` })
    }
  }, [active, request, id])

  useLayoutEffect(() => {
    onSubpageChange?.(selected)
    setVisited(current => current.has(selected) ? current : new Set([...current, selected]))
  }, [onSubpageChange, selected])

  return <div className="cluster-workspace cluster-node" data-cluster-page="node">
    <Tabs aria-label="Node settings" className="cluster-node-tabs" value={selected} onValueChange={next => { setTab(next); setAddHost(undefined) }}
      options={tabs.map(({ id: value, title }) => ({ value, label: title, panelId: `${id}-${value}`, button: { id: `${id}-tab-${value}` } }))} />
    {tabs.map(({ id: value }) => {
      const shown = value === selected
      return <section key={value} id={`${id}-${value}`} role="tabpanel" aria-labelledby={`${id}-tab-${value}`} hidden={!shown} inert={!shown}
        className="cluster-panel" data-cluster-node-panel={value}>
        {shown || visited.has(value) ? {
          publishing: <NetworkNodeSettingsPane {...props} active={active && shown} navigationRequest={publicationRequest} />,
          'mesh-configuration': <div data-settings-field="mesh-separate-gateway">
            <MeshNetworkSettings active={active && shown} showTopology={false} operatorRequest={gatewayRequest}
              onConnections={() => onNavigate('network-node', 'mesh-devices')}
              onJoin={() => onNavigate('remote-execution', 'mesh-join')}
              onShare={() => onNavigate('remote-execution', 'mesh-share')} />
          </div>,
          incoming: <>
            <div className="cluster-section-heading"><div><h3>Receive Tailcat connections</h3><p>Give approved clients access to the service on this Mac.</p></div>
              <Button type="button" onClick={() => onNavigate('network-node', 'mesh-devices')}>Manage saved clients</Button></div>
            {tailcatUnavailable || !local ? <p data-settings-field="incoming" role="status">The requested local Host is unavailable. Select This Mac to check the local listener.</p> : null}
            {tailcatUnavailable && local ? <Button type="button" onClick={() => onNavigate('network-node', 'incoming', local.id)}>Open this Mac’s listener</Button> : null}
            {!tailcatUnavailable && local ? <LocalIncomingConnections config={config} active={active && shown} /> : null}
          </>,
          'mesh-devices': <div data-settings-field={sshRequest?.field ?? 'mesh-devices'}>
            <div className="cluster-section-heading">
              <div><h3>SSH & saved connections</h3><p>Set up SSH to another machine or open an existing connection.</p></div>
              {local ? <Button type="button" onClick={() => onNavigate('network-node', 'resources', local.id)}>Inspect this Mac</Button> : null}
            </div>
            <HostSettingsPane {...props} navigationRequest={sshRequest} active={active && shown} onSave={saveHosts}
              addHostRequest={applied.current === request ? addHost : undefined}
              onRemoteWork={() => onNavigate('remote-execution', 'prepare')}
              onIncoming={hostId => onNavigate('network-node', 'incoming', hostId)} />
          </div>,
        }[value] : null}
      </section>
    })}
  </div>
}
