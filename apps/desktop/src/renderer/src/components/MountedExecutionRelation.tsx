import { useRef } from 'react'
import type { SpaceSessionOccurrence } from '@agentmux/core/space-sessions'
import type { SpaceMountRecord } from '../../../shared/space-mount'
import type { MountedSpaceRegion } from '../lib/space-mount-view'
import { useAppStore } from '../store'
import { AgentExecutionRelation, type ExecutionRouteRelation } from './AgentExecutionRelation'
import { useWorkbenchNameTooltip, useWorkbenchTooltipFocus } from './WorkbenchNameTooltip'
import './agent-work-mode.css'

/** B's inner aliases stay in B's realm. A's carrier describes access, never an execution hop. */
export function MountedExecutionRelation({ member, target, occurrence }: { member: MountedSpaceRegion; target?: SpaceMountRecord | undefined; occurrence?: SpaceSessionOccurrence | undefined }) {
  const carrier = useAppStore(state => state.config?.hosts.find(host => host.id === target?.hostId))
  const projectRuntime = member.zone?.hostId === 'local' ? member.reference.runtimeId : null
  const execution = member.region.execution, agentRuntime = execution?.runtimeId ?? null
  const projectLabel = member.zone?.hostId === 'local' ? 'Project device' : member.zone?.hostId ?? 'Host unobserved'
  const path = occurrence?.executionRoute
  const chain = path?.kind === 'adopted' ? [path.route.source, ...path.route.hops.map(hop => hop.target)] : []
  const relation: ExecutionRouteRelation = path?.kind === 'same' ? { kind: 'same-device' }
    : path?.kind === 'adopted' ? path.route.hops.length > 1 ? { kind: 'cascade', hops: path.route.hops.length } : { kind: 'direct' }
    : { kind: 'unconfirmed' }
  const localSource = carrier?.kind === 'local', route = relation.kind === 'same-device' ? 'Same device'
    : relation.kind === 'direct' ? 'Direct execution path' : relation.kind === 'cascade' ? `${relation.hops} execution hops` : 'Execution path unconfirmed'
  const fullPath = chain.map(identity => identity.runtimeId).join(' → ')
  const description = `Project · ${projectLabel}\n${member.zone?.directoryPath ?? 'Directory unobserved'}\nRuntime · ${projectRuntime ?? 'Unconfirmed'}\nAgent · ${execution?.hostId ?? 'Host unobserved'}\n${execution?.cwd ?? 'Startup directory unobserved'}\nRuntime · ${agentRuntime ?? 'Unconfirmed'}\n${route}${fullPath ? '\n' + fullPath : ''}\nAccess to source · ${carrier?.label ?? target?.hostId ?? 'Unconfirmed'}`
  const detail = <span className="agent-work-detail"><span className="agent-work-detail__end"><span><small>Project · original source</small><strong>{projectLabel}</strong><code>{member.zone?.directoryPath ?? 'Directory unobserved'}</code><small>Runtime {projectRuntime ?? 'unconfirmed'}</small></span></span>
    <span className="agent-work-detail__end"><span><small>Agent · original source</small><strong>{execution?.hostId ?? 'Host unobserved'}</strong><code>{execution?.cwd ?? 'Startup directory unobserved'}</code><small>Runtime {agentRuntime ?? 'unconfirmed'}</small></span></span>
    <span className="agent-work-detail__route"><small>Execution route</small><span>{route}</span>{chain.map((identity, index) => <code key={index}>{index + 1}. {identity.runtimeId}</code>)}</span><span className="agent-work-detail__access"><small>Access from this device</small><span>Via {carrier?.label ?? target?.hostId ?? 'unconfirmed source route'}</span></span></span>
  const tooltip = useWorkbenchNameTooltip('Run mode', detail, false), element = useRef<HTMLSpanElement>(null)
  const focusOwner = useWorkbenchTooltipFocus(element, tooltip, false, description)
  return <><span ref={element} className="agent-work-mode-badge" aria-label={description} tabIndex={focusOwner ? undefined : 0} {...tooltip.props}>
    <AgentExecutionRelation projectLocal={localSource && !!projectRuntime} agentLocal={localSource && agentRuntime === member.reference.runtimeId}
      relation={relation} />
  </span>{tooltip.content}</>
}
