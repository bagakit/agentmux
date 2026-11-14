import type { AdoptedHostRoute } from '@agentmux/core/host-route'
import { semanticIconComponent } from '@agentmux/client-ui/icons'
import { ExecutionRouteLink } from '../AgentExecutionRelation'

const HostIcon = semanticIconComponent('object.host')
/** A selected, explicit logical path. It does not claim current connectivity. */
export function HostRoutePath({ route, sourceLabel }: { route: AdoptedHostRoute; sourceLabel: string }) {
  const nodes = [{ identity: route.source, label: sourceLabel }, ...route.hops.map(hop => ({ identity: hop.target, label: hop.edgeId }))]
  return <ol className="host-route-path" aria-label="Configured logical route">
    {nodes.map((node, index) => <li key={node.identity.runtimeId}>
      {index ? <ExecutionRouteLink relation={{ kind: 'direct' }} /> : null}
      <span title={`${node.label}\nRuntime: ${node.identity.runtimeId}\nKey: ${node.identity.fingerprint}`} tabIndex={0}>
        <HostIcon size={18} aria-hidden="true" /><span><strong>{node.label}</strong><small>{index === 0 ? 'Source' : index === nodes.length - 1 ? 'Destination' : 'Via'}</small></span>
      </span>
    </li>)}
  </ol>
}
