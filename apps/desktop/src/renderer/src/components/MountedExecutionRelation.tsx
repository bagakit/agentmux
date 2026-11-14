import { useRef } from 'react'
import type { SpaceMountRecord } from '../../../shared/space-mount'
import type { MountedSpaceRegion } from '../lib/space-mount-view'
import { useAppStore } from '../store'
import { AgentExecutionRelation } from './AgentExecutionRelation'
import { useWorkbenchNameTooltip, useWorkbenchTooltipFocus } from './WorkbenchNameTooltip'
import './agent-work-mode.css'

/** B's inner aliases stay in B's realm. A's carrier describes access, never an execution hop. */
export function MountedExecutionRelation({ member, target }: { member: MountedSpaceRegion; target?: SpaceMountRecord | undefined }) {
  const carrier = useAppStore(state => state.config?.hosts.find(host => host.id === target?.hostId))
  const projectRuntime = member.zone?.hostId === 'local' ? member.reference.runtimeId : null
  const execution = member.region.execution, agentRuntime = execution?.runtimeId ?? null
  const same = !!projectRuntime && projectRuntime === agentRuntime
  const localSource = carrier?.kind === 'local', route = same ? 'Same device' : 'Execution path unconfirmed'
  const description = `Project · ${member.zone?.hostId ?? 'Host unobserved'}\n${member.zone?.directoryPath ?? 'Directory unobserved'}\nRuntime · ${projectRuntime ?? 'Unconfirmed'}\nAgent · ${execution?.hostId ?? 'Host unobserved'}\n${execution?.cwd ?? 'Startup directory unobserved'}\nRuntime · ${agentRuntime ?? 'Unconfirmed'}\n${route}\nAccess to source · ${carrier?.label ?? target?.hostId ?? 'Unconfirmed'}`
  const detail = <span className="agent-work-detail"><span className="agent-work-detail__end"><span><small>Project · original source</small><strong>{member.zone?.hostId ?? 'Host unobserved'}</strong><code>{member.zone?.directoryPath ?? 'Directory unobserved'}</code><small>Runtime {projectRuntime ?? 'unconfirmed'}</small></span></span>
    <span className="agent-work-detail__end"><span><small>Agent · original source</small><strong>{execution?.hostId ?? 'Host unobserved'}</strong><code>{execution?.cwd ?? 'Startup directory unobserved'}</code><small>Runtime {agentRuntime ?? 'unconfirmed'}</small></span></span>
    <span className="agent-work-detail__route"><small>Execution route</small><span>{route}</span></span><span className="agent-work-detail__access"><small>Access from this device</small><span>Via {carrier?.label ?? target?.hostId ?? 'unconfirmed source route'}</span></span></span>
  const tooltip = useWorkbenchNameTooltip('Execution locations', detail, false), element = useRef<HTMLSpanElement>(null)
  const focusOwner = useWorkbenchTooltipFocus(element, tooltip, false, description)
  return <><span ref={element} className="agent-work-mode-badge" aria-label={description} tabIndex={focusOwner ? undefined : 0} {...tooltip.props}>
    <AgentExecutionRelation projectLocal={localSource && !!projectRuntime} agentLocal={localSource && agentRuntime === member.reference.runtimeId}
      relation={{ kind: same ? 'same-device' : 'unconfirmed' }} />
  </span>{tooltip.content}</>
}
