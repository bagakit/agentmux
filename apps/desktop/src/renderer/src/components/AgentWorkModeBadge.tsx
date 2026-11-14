import { semanticIconComponent } from '@agentmux/client-ui/icons'
import type { AppConfig } from '../../../shared/contracts'
import { useAppStore } from '../store'
import { agentWorkModeLabel, agentWorkPlacement, workHostLabel, workReferenceHostId, type AgentWorkSource } from '../lib/agent-work-mode'
import { useWorkbenchNameTooltip } from './WorkbenchNameTooltip'
import './agent-work-mode.css'

const RemoteIcon = semanticIconComponent('object.remote-execution')
const ProjectIcon = semanticIconComponent('object.folder')
const AgentIcon = semanticIconComponent('object.host')
const UnknownIcon = semanticIconComponent('status.unknown')
const NO_HOSTS: AppConfig['hosts'] = []

/** A reading of original addresses. It never checks a connection or changes a Session. */
export function AgentWorkModeBadge({ source, hosts: suppliedHosts, embedded = false }: {
  source?: AgentWorkSource | undefined
  hosts?: AppConfig['hosts'] | undefined
  embedded?: boolean
}) {
  const configured = useAppStore(state => suppliedHosts ? NO_HOSTS : state.config?.hosts ?? NO_HOSTS)
  const hosts = suppliedHosts ?? configured
  const placement = source ? agentWorkPlacement(source, workReferenceHostId(hosts)) : null
  const mode = placement?.mode ?? 'unknown', label = agentWorkModeLabel(mode)
  const detail = placement ? `Agent · ${workHostLabel(hosts, placement.agentHostId)}\n${placement.agentPath || 'Startup directory unobserved'}\nProject · ${workHostLabel(hosts, placement.projectHostId)}\n${placement.projectPath || 'Project directory unobserved'}`
    : 'The original Agent and project addresses are not observed.'
  const tooltip = useWorkbenchNameTooltip(label, detail, embedded || mode === 'local', { pointerPassThrough: true })
  if (mode === 'local') return null
  const Icon = mode === 'unknown' ? UnknownIcon : mode === 'remote-project' ? ProjectIcon : mode === 'remote-agent' ? AgentIcon : RemoteIcon
  return <><span className="agent-work-mode-badge" data-work-mode={mode} data-agent-host-id={placement?.agentHostId ?? ''}
    data-project-host-id={placement?.projectHostId ?? ''} aria-label={`${label}; ${detail}`} title={embedded ? `${label}\n${detail}` : undefined}
    tabIndex={embedded ? undefined : 0} {...(embedded ? {} : tooltip.props)}><Icon size={11} aria-hidden="true" /><span className="agent-work-mode-badge__label">{label}</span></span>{tooltip.content}</>
}
