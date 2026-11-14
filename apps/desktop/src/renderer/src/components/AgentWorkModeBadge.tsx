import { semanticIconComponent } from '@agentmux/client-ui/icons'
import { useMemo, useRef } from 'react'
import type { AppConfig } from '../../../shared/contracts'
import { useAppStore } from '../store'
import { agentWorkPlacement, workHostLabel, workReferenceHostId, type AgentWorkSource, type launcherWorkPlacement } from '../lib/agent-work-mode'
import { hostConnectionPresentation } from '../lib/host-connection-presentation'
import { useWorkbenchNameTooltip, useWorkbenchTooltipFocus } from './WorkbenchNameTooltip'
import { AgentExecutionRelation } from './AgentExecutionRelation'
import './agent-work-mode.css'

const ProjectIcon = semanticIconComponent('object.folder')
const AgentIcon = semanticIconComponent('object.agent')
const NO_HOSTS: AppConfig['hosts'] = []

/** A reading of original addresses. It never checks a connection or changes a Session. */
export function AgentWorkModeBadge({ source, placement: suppliedPlacement, hosts: suppliedHosts, showLocal = false, hideTooltip = false }: {
  source?: AgentWorkSource | undefined
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
  const projectId = placement?.projectHostId ?? null, agentId = placement?.agentHostId ?? null
  const projectTransport = useAppStore(state => projectId ? state.hostTransports?.[projectId] : undefined)
  const agentTransport = useAppStore(state => agentId ? state.hostTransports?.[agentId] : undefined)
  const mode = placement?.mode ?? 'unknown'
  const relation = projectId && agentId && projectId === agentId ? 'same-device' : 'unconfirmed'
  const projectLabel = workHostLabel(hosts, projectId), agentLabel = workHostLabel(hosts, agentId)
  const route = relation === 'same-device' ? 'Same device' : 'Execution path unconfirmed'
  const description = `Project · ${projectLabel}\n${placement?.projectPath || 'Project directory unobserved'}\nAgent · ${agentLabel}\n${placement?.agentPath || 'Startup directory unobserved'}\n${route}`
  const detail = useMemo(() => {
    const access = [...new Set([projectId, agentId])].filter((id): id is string => id !== null).map(id => ({
      id, label: workHostLabel(hosts, id), ...hostConnectionPresentation(hosts.find(host => host.id === id), id === projectId ? projectTransport : agentTransport)
    }))
    return <span className="agent-work-detail">
    <span className="agent-work-detail__end"><ProjectIcon size={14} aria-hidden="true" /><span><small>Project</small><strong>{projectLabel}</strong><code>{placement?.projectPath || 'Directory unobserved'}</code></span></span>
    <span className="agent-work-detail__end"><AgentIcon size={14} aria-hidden="true" /><span><small>Agent</small><strong>{agentLabel}</strong><code>{placement?.agentPath || 'Startup directory unobserved'}</code></span></span>
    <span className="agent-work-detail__route"><small>Execution route</small><span>{route}</span></span>
    <span className="agent-work-detail__access"><small>Access from this device</small>{access.map(item => <span key={item.id}><strong>{item.label}</strong><span>{item.summary}</span>{item.source ? <small>{item.source}</small> : null}</span>)}</span>
    </span>
  }, [projectId, agentId, projectLabel, agentLabel, placement?.projectPath, placement?.agentPath, route, hosts, projectTransport, agentTransport])
  const suppressed = hideTooltip || mode === 'local' && !showLocal
  const tooltip = useWorkbenchNameTooltip('Run mode', detail, suppressed)
  const element = useRef<HTMLSpanElement>(null)
  const focusOwner = useWorkbenchTooltipFocus(element, tooltip, suppressed, JSON.stringify([projectId, agentId]))
  if (mode === 'local' && !showLocal) return null
  return <><span ref={element} className="agent-work-mode-badge" data-work-mode={mode} data-execution-relation={relation}
    data-agent-host-id={agentId ?? ''} data-project-host-id={projectId ?? ''} aria-label={`Run mode; ${description}`}
    tabIndex={suppressed || focusOwner ? undefined : 0} {...tooltip.props}>
    <AgentExecutionRelation projectLocal={projectId !== null && projectId === reference} agentLocal={agentId !== null && agentId === reference} relation={{ kind: relation }} />
  </span>{tooltip.content}</>
}
