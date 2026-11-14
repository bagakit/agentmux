import { semanticIconComponent } from '@agentmux/client-ui/icons'
import { useMemo, useRef } from 'react'
import type { AppConfig } from '../../../shared/contracts'
import { useAppStore } from '../store'
import { agentWorkPlacement, workHostLabel, workReferenceHostId, type AgentWorkSource, type launcherWorkPlacement } from '../lib/agent-work-mode'
import { hostConnectionPresentation } from '../lib/host-connection-presentation'
import { useWorkbenchNameTooltip, useWorkbenchTooltipFocus } from './WorkbenchNameTooltip'
import { AgentExecutionRelation, type ExecutionRouteRelation } from './AgentExecutionRelation'
import type { LauncherSourceExecution } from '../lib/launcher-source'
import './agent-work-mode.css'

const ProjectIcon = semanticIconComponent('object.folder')
const AgentIcon = semanticIconComponent('object.agent')
const NO_HOSTS: AppConfig['hosts'] = []

/** A reading of original addresses. It never checks a connection or changes a Session. */
export function AgentWorkModeBadge({ source, sourceSelection, placement: suppliedPlacement, hosts: suppliedHosts, showLocal = false, hideTooltip = false }: {
  source?: AgentWorkSource | undefined
  sourceSelection?: LauncherSourceExecution | undefined
  placement?: ReturnType<typeof launcherWorkPlacement> | undefined
  hosts?: AppConfig['hosts'] | undefined
  embedded?: boolean
  showLocal?: boolean
  hideTooltip?: boolean
}) {
  const configured = useAppStore(state => suppliedHosts ? NO_HOSTS : state.config?.hosts ?? NO_HOSTS)
  const hosts = suppliedHosts ?? configured
  const reference = workReferenceHostId(hosts)
  const placement = suppliedPlacement ?? (source ? agentWorkPlacement(source, reference) : null)
  const selectedAgent = sourceSelection?.kind === 'source-coordinator' ? sourceSelection.coordinator : sourceSelection?.agentTarget
  const selectedRoute = sourceSelection?.kind === 'source-coordinator' ? undefined : sourceSelection?.agentTarget.adoptedRoute
  const sourceSame = !!sourceSelection && selectedAgent?.runtimeId === sourceSelection.target.reference.runtimeId
  const projectId = sourceSelection?.project.hostId ?? placement?.projectHostId ?? null
  // A's Host directory describes its own access only. A B-realm D selector is
  // never looked up as if it were A's identically named configured Host.
  const agentId = sourceSelection ? sourceSelection.kind === 'source-coordinator' ? sourceSelection.coordinator.hostId : sourceSame ? projectId : null : placement?.agentHostId ?? null
  const projectTransport = useAppStore(state => projectId ? state.hostTransports?.[projectId] : undefined)
  const agentTransport = useAppStore(state => agentId ? state.hostTransports?.[agentId] : undefined)
  const mode = placement?.mode ?? 'unknown'
  const relation: ExecutionRouteRelation = sourceSelection ? sourceSame ? { kind: 'same-device' } : selectedRoute
    ? selectedRoute.hops.length > 1 ? { kind: 'cascade', hops: selectedRoute.hops.length } : { kind: 'direct' } : { kind: 'unconfirmed' }
    : { kind: projectId && agentId && projectId === agentId ? 'same-device' : 'unconfirmed' }
  const projectLabel = workHostLabel(hosts, projectId), agentLabel = sourceSelection && !agentId
    ? `${selectedAgent?.hostId ?? 'Unconfirmed'} · project device’s selection` : workHostLabel(hosts, agentId)
  const projectPath = sourceSelection?.project.path ?? placement?.projectPath, agentPath = sourceSelection?.kind === 'source-coordinator' ? sourceSelection.coordinator.homeDirectory : sourceSelection ? undefined : placement?.agentPath
  const route = relation.kind === 'same-device' ? 'Same device' : relation.kind === 'direct' ? 'Direct execution path' : relation.kind === 'cascade' ? `${relation.hops} execution hops` : 'Execution path unconfirmed'
  const chain = selectedRoute ? [selectedRoute.source, ...selectedRoute.hops.map(hop => hop.target)] : []
  const description = `Project · ${projectLabel}\n${projectPath || 'Project directory unobserved'}\nAgent · ${agentLabel}\n${agentPath || 'Startup directory unobserved'}\n${route}${chain.length ? '\n' + chain.map(item => item.runtimeId).join(' → ') : ''}`
  const detail = useMemo(() => {
    const access = [...new Set([projectId, agentId])].filter((id): id is string => id !== null).map(id => ({
      id, label: workHostLabel(hosts, id), ...hostConnectionPresentation(hosts.find(host => host.id === id), id === projectId ? projectTransport : agentTransport)
    }))
    return <span className="agent-work-detail">
    <span className="agent-work-detail__end"><ProjectIcon size={14} aria-hidden="true" /><span><small>Project</small><strong>{projectLabel}</strong><code>{projectPath || 'Directory unobserved'}</code>{sourceSelection ? <small>Runtime {sourceSelection.target.reference.runtimeId}</small> : null}</span></span>
    <span className="agent-work-detail__end"><AgentIcon size={14} aria-hidden="true" /><span><small>Agent</small><strong>{agentLabel}</strong><code>{agentPath || 'Startup directory unobserved'}</code>{selectedAgent ? <small>Runtime {selectedAgent.runtimeId}</small> : null}</span></span>
    <span className="agent-work-detail__route"><small>Execution route</small><span>{route}</span>{chain.map((item, index) => <code key={index}>{index + 1}. {item.runtimeId}</code>)}</span>
    <span className="agent-work-detail__access"><small>Access from this device</small>{access.map(item => <span key={item.id}><strong>{item.label}</strong><span>{item.summary}</span>{item.source ? <small>{item.source}</small> : null}</span>)}</span>
    </span>
  }, [projectId, agentId, projectLabel, agentLabel, projectPath, agentPath, route, hosts, projectTransport, agentTransport, sourceSelection, selectedAgent, selectedRoute])
  const suppressed = hideTooltip || !sourceSelection && mode === 'local' && !showLocal
  const tooltip = useWorkbenchNameTooltip('Run mode', detail, suppressed)
  const element = useRef<HTMLSpanElement>(null)
  const focusOwner = useWorkbenchTooltipFocus(element, tooltip, suppressed, JSON.stringify([projectId, agentId]))
  if (!sourceSelection && mode === 'local' && !showLocal) return null
  return <><span ref={element} className="agent-work-mode-badge" data-work-mode={mode} data-execution-relation={relation.kind}
    data-agent-host-id={agentId ?? ''} data-project-host-id={projectId ?? ''} aria-label={`Run mode; ${description}`}
    tabIndex={suppressed || focusOwner ? undefined : 0} {...tooltip.props}>
    <AgentExecutionRelation projectLocal={projectId !== null && projectId === reference} agentLocal={agentId !== null && agentId === reference} relation={relation} />
  </span>{tooltip.content}</>
}
