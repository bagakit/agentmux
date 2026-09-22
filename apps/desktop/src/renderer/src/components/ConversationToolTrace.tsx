import type { AgentSessionHistoryContentPart } from '@agentmux/core'
import { ChevronRight, CircleX, Terminal } from 'lucide-react'
import { memo, useId, useState } from 'react'
import { stepTitle } from '../lib/activity-step-summary'

export type ConversationToolTraceProps = {
  part: ToolPart
  workspaceRoot?: string
  traceId?: string
  expanded?: boolean
  onToggle?: (open: boolean) => void
}

type ToolPart = Extract<AgentSessionHistoryContentPart, { kind: 'tool-call' | 'tool-result' }>

/** One observed part, in the host's original order. Calls and results are never paired here. */
export const ConversationToolTrace = memo(function ConversationToolTrace({
  part, workspaceRoot = '', traceId, expanded, onToggle
}: ConversationToolTraceProps) {
  const [localOpen, setLocalOpen] = useState(false)
  const open = expanded ?? localOpen
  const panelId = useId()
  const isCall = part.kind === 'tool-call'
  const failed = part.kind === 'tool-result' && part.failed === true
  const name = part.name ?? 'Tool result'
  const title = stepTitle(name, isCall ? part.name : undefined, isCall ? part.input : undefined, workspaceRoot)
  return (
    <div className="conversation-tool-trace" data-trace-kind={part.kind}
      {...(failed ? { 'data-status': 'failed' } : {})} data-call-id={part.callId} data-trace-id={traceId}>
      <button type="button" className="conversation-tool-trace__row" aria-expanded={open}
        aria-controls={panelId} data-trace-id={traceId}
        onClick={() => {
          if (onToggle) onToggle(!open)
          else setLocalOpen(!open)
        }} title={name}>
        {failed ? <CircleX size={13} aria-hidden="true" /> : <Terminal size={13} aria-hidden="true" />}
        <span className="conversation-tool-trace__title">{title}</span>
        <span className="conversation-tool-trace__kind">{isCall ? 'Tool call' : 'Tool result'}</span>
        {failed ? <span className="conversation-tool-trace__failure">Failed</span> : null}
        <ChevronRight className="conversation-tool-trace__chevron" size={12} aria-hidden="true" />
      </button>
      {open ? <div id={panelId} className="conversation-tool-trace__payload">
        {part.callId ? <span className="conversation-tool-trace__identity">Call <code>{part.callId}</code></span> : null}
        <pre>{isCall ? part.input : part.output}</pre>
      </div> : null}
    </div>
  )
})
