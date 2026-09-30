import type { AgentSessionHistoryContentPart } from '@agentmux/core'
import { memo, useState } from 'react'
import { AgentMarkdown, type LinkClickModifiers, type OpenWorkspaceFile } from './AgentMarkdown'
import type { ReadPastedImage } from './ConversationImage'

const MemoizedAgentMarkdown = memo(AgentMarkdown)

export type ConversationReasoningTraceProps = {
  part: Extract<AgentSessionHistoryContentPart, { kind: 'reasoning' }>
  traceId?: string
  expanded?: boolean
  onToggle?: (open: boolean) => void
  workspaceRoot?: string
  homeDir?: string
  openWorkspaceFile?: OpenWorkspaceFile
  readPastedImage?: ReadPastedImage
  openHttpLink?: (url: string, event: LinkClickModifiers) => void
}

/**
 * A lightweight reasoning trace block.
 * Reasoning is collapsed by default and does not mount heavy prose/markdown until opened.
 * Controlled disclosure (e.g. from session history) and local interactive toggle are preserved.
 */
export const ConversationReasoningTrace = memo(function ConversationReasoningTrace({
  part,
  traceId,
  expanded,
  onToggle,
  workspaceRoot = '',
  homeDir = '',
  openWorkspaceFile,
  readPastedImage,
  openHttpLink
}: ConversationReasoningTraceProps) {
  const [localOpen, setLocalOpen] = useState(false)
  const open = expanded ?? localOpen

  const handleToggle = (event: React.SyntheticEvent<HTMLDetailsElement>) => {
    const nextOpen = event.currentTarget.open
    if (onToggle) {
      onToggle(nextOpen)
    }
    setLocalOpen(nextOpen)
  }

  return (
    <details
      className="log-turn__trace"
      data-trace-kind="reasoning"
      data-trace-id={traceId}
      open={open}
      onToggle={handleToggle}
    >
      <summary className="log-turn__trace-summary">Reasoning</summary>
      {open ? (
        <div className="log-turn__trace-payload">
          {part.redacted ? (
            <pre className="log-turn__trace-redacted">Reasoning content redacted.</pre>
          ) : part.text.length === 0 ? (
            <pre className="log-turn__trace-empty">No reasoning text recorded.</pre>
          ) : (
            <div className="log-turn__trace-body">
              <MemoizedAgentMarkdown
                content={part.text}                workspaceRoot={workspaceRoot}
                homeDir={homeDir}
                {...(openWorkspaceFile ? { openWorkspaceFile } : {})}
                {...(readPastedImage ? { readPastedImage } : {})}
                {...(openHttpLink ? { openHttpLink } : {})}
              />
            </div>
          )}
        </div>
      ) : null}
    </details>
  )
})
