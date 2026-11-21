import { useLayoutEffect, useRef, useState } from 'react'
import { Button } from '@agentmux/client-ui/components/Button'
import { SemanticIcon, semanticIconComponent } from '@agentmux/client-ui/icons'
import meshArt from '@agentmux/client-ui/brand/illustrations/concepts/mesh-relay.jpg'
import workArt from '@agentmux/client-ui/brand/illustrations/concepts/remote-project-agent.jpg'
import { MeshNetworkSettings } from '../MeshNetworkSettings'
import { MeshDeviceAccess } from '../MeshDeviceAccess'
import { RemoteExecutionSettingsPane } from '../RemoteExecutionSettingsPane'
import type { SettingsPaneProps } from '../settings-catalog'
import { useAppStore } from '../../../store'
import '../cluster-settings.css'

const tasks = [
  { id: 'mesh-join', title: 'Connect to a Relay Gateway', description: 'Join a network using a code from its operator.', Icon: semanticIconComponent('object.topology') },
  { id: 'mesh-share', title: 'Share a device', description: 'Create an access link, then approve the other device.', Icon: semanticIconComponent('object.node') },
  { id: 'mesh-access-work', title: 'Open a device', description: 'Use a saved device or an access link to open its workspace.', Icon: semanticIconComponent('object.host') },
  { id: 'prepare', title: 'Start cross-device work', description: 'Choose where your project lives and where the Agent runs.', Icon: semanticIconComponent('object.agent') },
  { id: 'bindings', title: 'Continue existing work', description: 'Return to an original Session on a connected machine.', Icon: semanticIconComponent('object.folder') },
] as const

const workFields = new Set(['prepare', 'bindings', 'guide', 'routes'])

export function ClusterQuickSettingsPane(props: SettingsPaneProps) {
  const { config, active, onNavigate, navigationRequest } = props
  const separateRuntimeId = useAppStore(state => state.meshGatewayRuntimeId)
  const field = navigationRequest?.field
  const task = tasks.find(item => item.id === field)
  const work = Boolean(field && workFields.has(field))
  const remoteHost = field === 'mesh-join' && navigationRequest?.hostId
    && !config.hosts.some(host => host.kind === 'local' && host.id === navigationRequest.hostId) ? navigationRequest.hostId : undefined
  const [visited, setVisited] = useState<ReadonlySet<string>>(() => new Set())
  const showJoin = field === 'mesh-join' && !remoteHost
  const showAccess = field === 'mesh-access-work'
  const showShare = field === 'mesh-share'
  const home = !task && !work
  const lastTask = useRef<string | undefined>(undefined)
  const content = useRef<HTMLDivElement>(null)
  const journey = useRef<HTMLElement>(null)
  const [workRequest, setWorkRequest] = useState(navigationRequest)

  useLayoutEffect(() => {
    if (field === undefined) return
    setVisited(current => current.has(field) ? current : new Set([...current, field]))
    if (work) setWorkRequest(navigationRequest)
  }, [field, work, navigationRequest])

  useLayoutEffect(() => {
    if (!active) return
    if (home && lastTask.current) {
      const button = content.current?.querySelector<HTMLButtonElement>(`[data-quick-task="${lastTask.current}"]`)
      button?.focus()
    }
    if (!home && lastTask.current !== field && journey.current) {
      const scroll = journey.current.closest<HTMLElement>('[data-settings-pane]')
      if (scroll) scroll.scrollTop = 0
      journey.current.focus({ preventScroll: true })
    }
    lastTask.current = field
  }, [active, home, field])

  function go(next?: string) { onNavigate('remote-execution', next) }

  return <div className="cluster-workspace cluster-quick" data-cluster-page="quick" data-quick-view={home ? 'home' : field}>
    <div hidden={!home} inert={!home} className="cluster-panel" ref={content}>
      <header className="cluster-landing">
        <img src={meshArt} width="1100" height="619" alt="" draggable={false} />
        <div><h2>Work beyond this Mac.</h2><p>Connect your devices and bring the right machine into your work.</p>
          <Button type="button" variant="primary" data-quick-task="mesh-join" onClick={() => go('mesh-join')}>Connect to a Relay Gateway</Button></div>
      </header>
      <div className="cluster-task-grid" aria-label="Quick tasks">
        {tasks.slice(1).map(({ id, title, description, Icon }) => <button key={id} type="button" data-quick-task={id} onClick={() => go(id)}>
          <span className="cluster-task-icon"><Icon size={20} /></span>
          <span><strong>{title}</strong><small>{description}</small></span><span className="cluster-task-arrow" aria-hidden="true">↗</span>
        </button>)}
      </div>
      <div className="cluster-quick-links"><Button type="button" data-quick-task="routes" onClick={() => go('routes')}>Work routes</Button>
        <Button type="button" onClick={() => onNavigate('hosts')}>View network</Button></div>
    </div>
    {!home ? <header className="cluster-journey-nav" ref={journey} tabIndex={-1}>
      <Button type="button" onClick={() => go()}><SemanticIcon name="navigation.back" size={14} />All Quick tasks</Button>
    </header> : null}
    {remoteHost ? <section className="cluster-panel cluster-task-content" data-settings-field="mesh-join">
      <h3>Connect {config.hosts.find(host => host.id === remoteHost)?.label ?? remoteHost}</h3>
      <p>Open the requested Host’s Gateway settings to configure its connection.</p>
      <Button type="button" variant="primary" onClick={() => onNavigate('network-node', 'mesh-configuration', remoteHost)}>Open Host gateway</Button>
      <Button type="button" onClick={() => go('mesh-join')}>Connect this Mac instead</Button>
    </section> : null}
    <div hidden={!showJoin} inert={!showJoin} className="cluster-panel">
      {showJoin || visited.has('mesh-join') ? <MeshNetworkSettings join active={active && showJoin}
        onDone={() => onNavigate('hosts')} onAccess={() => go('mesh-access-work')} onManage={() => onNavigate('network-node', separateRuntimeId ? 'mesh-separate-gateway' : 'mesh-configuration')} /> : null}
    </div>
    <div hidden={!showAccess} inert={!showAccess} className="cluster-panel" data-settings-field="mesh-access-work">
      {showAccess || visited.has('mesh-access-work') ? <MeshDeviceAccess /> : null}
    </div>
    {showShare ? <section className="cluster-panel cluster-task-content" data-settings-field="mesh-share">
      <header className="cluster-landing cluster-landing--compact"><img src={meshArt} width="1100" height="619" alt="" draggable={false} />
        <div><h2>Give a device access.</h2><p>Invite another Mac to open a workspace through a reachable Relay Gateway.</p></div>
      </header>
      <ol className="cluster-checklist">
        <li><div><strong>Create and share a link</strong><p>Choose the original endpoint and a published Gateway address. Copy the link to the accessing Mac.</p></div>
          <Button type="button" variant="primary" onClick={() => onNavigate('network-node', 'mesh-link')}>Create the access link</Button></li>
        <li><div><strong>Approve the device’s public key</strong><p>Open the link on the other Mac and copy its public key. Return to the sharing device, paste that key into its approvals and save.</p></div>
          <Button type="button" onClick={() => onNavigate('network-node', 'mesh-device-approval')}>Open device approvals</Button></li>
        <li><div><strong>Open the workspace</strong><p>On the accessing Mac, retry the same link after the owner confirms the key.</p></div>
          <Button type="button" onClick={() => go('mesh-access-work')}>Open a device</Button></li>
      </ol>
      <Button type="button" onClick={() => go('mesh-join')}>Need a gateway? Open connection guide</Button>
    </section> : null}
    <div hidden={!work} inert={!work} className="cluster-panel cluster-task-content">
      {work ? <header className="cluster-landing cluster-landing--compact" data-settings-field={field === 'guide' ? 'guide' : undefined}>
        <img src={workArt} width="1100" height="619" alt="" draggable={false} />
        <div><h2>{task?.title ?? (field === 'routes' ? 'Work routes' : 'Prepare remote work')}</h2>
          <p>{task?.description ?? (field === 'routes' ? 'Manage direct and delegated access between known devices.' : 'Choose the project and the Agent device before opening Launcher.')}</p></div>
      </header> : null}
      {work || workRequest && workFields.has(workRequest.field ?? '') ? <RemoteExecutionSettingsPane {...props} embedded
        active={active && work} navigationRequest={work ? navigationRequest : workRequest} /> : null}
    </div>
  </div>
}
