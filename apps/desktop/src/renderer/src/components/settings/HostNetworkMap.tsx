import { useMemo, useRef } from 'react'
import { Handle, Position, ReactFlow, type Edge, type Node, type NodeProps, type ReactFlowInstance } from '@xyflow/react'
import { semanticIconComponent } from '@agentmux/client-ui/icons'
import { configuredNetworkPath, hostNetworkView, networkDuration, type NetworkPathStep } from './host-network-view'
import { NetworkInterfaces, NetworkReadButton, SourceIssue, SourceTime, type HostNetworkViewProps } from './HostNetworkSources'
import './host-network-map.css'

const FitIcon = semanticIconComponent('layout.expand')
const RouteIcon = semanticIconComponent('object.topology')
type PathNode = Node<{ step: NetworkPathStep; index: number }, 'networkStep'>
function PathStep({ data: { step, index } }: NodeProps<PathNode>) {
  return <div className="network-path-node" data-network-map-step={step.kind} data-network-step-id={step.id}>
    {step.kind !== 'origin' ? <Handle type="target" position={Position.Top} isConnectable={false} /> : null}
    <span className="network-path-node__index" aria-hidden="true">{String(index + 1).padStart(2, '0')}</span>
    <span className="network-path-node__body"><small>{step.label}</small><strong title={step.address}>{step.address}</strong><span title={step.detail}>{step.detail}</span></span>
    {step.kind !== 'destination' ? <Handle type="source" position={Position.Bottom} isConnectable={false} /> : null}
  </div>
}
const nodeTypes = { networkStep: PathStep }

/** A read-only configuration drawing. Interface inventories never become route edges. */
export function HostNetworkMap(props: HostNetworkViewProps) {
  const { host, state, committed } = props
  const { held, latest, retained, policy, observer, target, partial } = hostNetworkView(host, state)
  const instance = useRef<ReactFlowInstance<PathNode, Edge> | null>(null)
  const steps = useMemo(() => configuredNetworkPath(host, policy), [host, policy])
  const nodes = useMemo<PathNode[]>(() => steps.map((step, index) => ({ id: step.id, type: 'networkStep', position: { x: index % 2 * 40, y: index * 120 }, selectable: false, data: { step, index } })), [steps])
  const edges = useMemo<Edge[]>(() => {
    const className = steps.some(step => step.kind === 'unknown') ? 'network-path-edge network-path-edge--unknown' : 'network-path-edge'
    return steps.slice(1).map((step, index) => ({ id: `path:${step.id}`, source: steps[index]!.id, target: step.id,
      type: 'smoothstep', pathOptions: { offset: 10, borderRadius: 8 }, selectable: false, className }))
  }, [steps])
  return <section className="network-map" data-network-map={host.id} aria-label="Selected connection path">
    <header className="network-map__heading"><div><small>CONFIGURATION PATH</small><strong>{host.label}</strong><span>{host.kind === 'ssh' ? host.hostname : 'Local execution'}</span></div><NetworkReadButton {...props} label="Read selected link" /></header>
    <div className="network-map__readout"><span title="May include connection setup, queueing and service processing">Owner request <strong>{target ? networkDuration(target.requestDurationMs) : 'Unconfirmed'}</strong></span>
      {retained?.target ? <SourceTime source={retained.target} current={latest?.target} /> : null}
      {retained?.ssh ? <span className="network-map__policy-time">SSH <SourceTime source={retained.ssh} current={latest?.ssh} /></span> : null}</div>
    <p className="network-map__boundary">Configured intermediaries · not physical hops or proof of the live channel’s route</p>
    {!committed ? <p className="host-network__hint">Save this environment to read its network sources.</p> : !retained ? <p className="host-network__hint">No network read yet. This view does not start a probe.</p> : null}
    {held?.error ? <p className="host-network__issue" role="status">{held.error}</p> : null}
    {partial ? <p className="host-network__issue">Some sources could not be read. Last confirmed values retain their original time.</p> : null}
    <div className="network-map__canvas"><ReactFlow<PathNode, Edge> nodes={nodes} edges={edges} nodeTypes={nodeTypes}
      onInit={value => { instance.current = value }} fitView fitViewOptions={{ padding: .12, minZoom: .7, maxZoom: 1 }}
      nodesDraggable={false} nodesConnectable={false} nodesFocusable={false} edgesFocusable={false} edgesReconnectable={false}
      elementsSelectable={false} deleteKeyCode={null} zoomOnDoubleClick={false} minZoom={.35} maxZoom={1.5} proOptions={{ hideAttribution: true }} />
      <button type="button" className="network-map__fit icon-button" aria-label="Fit configuration path" onClick={() => void instance.current?.fitView({ padding: .12, maxZoom: 1 })}><FitIcon size={15} /></button>
    </div>
    <div className="network-map__racks" aria-label="Endpoint interface inventories">
      <section data-interface-rack="observer"><header><RouteIcon size={14} /><strong>Source interfaces</strong><small>OBSERVATION SERVICE</small></header>
        {observer && retained?.observer.state === 'available' ? <NetworkInterfaces title="Interface inventory" source={retained.observer} current={latest?.observer} addresses={observer.interfaces}
          sampledAt={observer.observedAt} identity={`Observation process ${observer.processId}`} /> : <p className="host-network__hint">Source interfaces not observed.</p>}
        <SourceIssue source={latest?.observer} /></section>
      <section data-interface-rack="target"><header><RouteIcon size={14} /><strong>Target interfaces</strong><small>ORIGINAL OWNER</small></header>
        {target && retained?.target.state === 'available' ? <NetworkInterfaces title="Interface inventory" source={retained.target} current={latest?.target} addresses={target.sample.interfaces}
          sampledAt={target.sample.observedAt} identity={`Core ${target.sample.owner.runtimeId} · owner ${target.sample.owner.ownerInstanceId}`} /> : <p className="host-network__hint">Target interfaces not observed.</p>}
        <SourceIssue source={latest?.target} /></section>
    </div>
    <p className="network-map__boundary">An interface’s presence does not confirm a VPN or this connection’s egress. Socket endpoints, gateways and physical routers are not observed.</p>
    <SourceIssue source={latest?.ssh ?? undefined} />
  </section>
}
