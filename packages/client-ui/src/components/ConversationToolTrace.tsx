import { ConversationSourceLabels } from './ConversationSourceLabels.js'
import type { ConversationSourceDisplay } from '../lib/conversation-sources.js'
import { ConversationToolPayload } from './ConversationToolPayload.js'
import type { AgentSessionHistoryContentPart } from '@agentmux/core'
import { SemanticIcon } from '../theme/icons.js'
import { memo, useEffect, useId, useMemo, useState } from 'react'
import { stepTitle } from '../lib/activity-step-summary.js'

export type ConversationToolTraceProps = {
  sources?: ConversationSourceDisplay | undefined
  part: ToolPart
  workspaceRoot?: string
  copyIdentity?: object
  traceId?: string
  expanded?: boolean
  onToggle?: (open: boolean) => void
}

type ToolPart = Extract<AgentSessionHistoryContentPart, { kind: 'tool-call' | 'tool-result' }>

/** One observed part, in the host's original order. Calls and results are never paired here. */
export const ConversationToolTrace = memo(function ConversationToolTrace({
  part, sources, workspaceRoot = '', traceId, copyIdentity, expanded, onToggle
}: ConversationToolTraceProps) {
  const [localOpen, setLocalOpen] = useState(false)
  const open = expanded ?? localOpen
  const [presented, setPresented] = useState(Boolean(expanded))
  useEffect(() => { if (open) setPresented(true) }, [open])
  const panelId = useId()
  const identity = useMemo(() => ({}), [part, traceId, copyIdentity])
  const sourceIdentity = useMemo(() => ({}), [traceId, copyIdentity, traceId === undefined && copyIdentity === undefined ? part : undefined])
  const isCall = part.kind === 'tool-call'
  const text = isCall ? part.input : part.output
  const failed = part.kind === 'tool-result' && part.failed === true
  const name = part.name ?? 'Tool result'
  const title = useMemo(() => stepTitle(name, isCall ? part.name : undefined, isCall ? part.input : undefined, workspaceRoot), [part, workspaceRoot])
  return (
    <div className="conversation-tool-trace" data-trace-kind={part.kind}
      {...(failed ? { 'data-status': 'failed' } : {})} data-call-id={part.callId} data-trace-id={traceId}>
      <button type="button" className="conversation-tool-trace__row" aria-expanded={open}
        aria-controls={panelId} data-trace-id={traceId}
        onClick={() => {
          if (!open) setPresented(true)
          if (onToggle) onToggle(!open)
          else setLocalOpen(!open)
        }} title={name}>
        <SemanticIcon name={failed ? 'status.failed' : isCall ? 'conversation.tool-call' : 'conversation.tool-result'} size={13} aria-hidden="true" />
        <span className="conversation-tool-trace__title">{title}</span>
        <ConversationSourceLabels sources={sources} /><span className="conversation-tool-trace__kind">{isCall ? 'Tool call' : 'Tool result'}</span>
        {failed ? <span className="conversation-tool-trace__failure">Failed</span> : null}
        <SemanticIcon name="navigation.disclosure" className="conversation-tool-trace__chevron" size={12} aria-hidden="true" />
      </button>
      {open || presented ? <div id={panelId} className="conversation-tool-trace__payload" hidden={!open} inert={!open}>
        <ConversationToolPayload text={text} identity={identity} sourceIdentity={sourceIdentity} {...(part.callId ? { callId: part.callId } : {})}
          copyLabel={isCall ? 'Copy tool input' : 'Copy tool output'} />
      </div> : null}
    </div>
  )
})
