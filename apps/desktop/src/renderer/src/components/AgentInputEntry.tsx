import type { ReactNode } from 'react'
import type { AgentSessionUserMessage } from '@agentmux/core'
import { parseAgentMuxMessagePrefix } from '@agentmux/core/agent-message-render'
import { createSpeakerResolver, speakerOfUserMessage } from '@agentmux/client-ui/conversation-speaker'
import { clampStep } from '@agentmux/client-ui/activity-step-summary'

export type InputPresentation = {
  reading: { text: string; truncated: boolean }; date: Date | null
  author: string; time: string; provenance: string
}

/** Held presentation only; the original input owner supplies media and disclosure. */
export function AgentInputEntry({ presentation: meta, expanded, controls, onOpen, children }: {
  presentation: InputPresentation; expanded: boolean; controls?: string | undefined
  onOpen(anchor: HTMLDivElement): void; children?: ReactNode
}) {
  return <div className="agent-input-recall__entry" role="button" tabIndex={0} aria-label={`Read original input by ${meta.author}`} aria-controls={controls}
    aria-expanded={expanded} onClick={event => onOpen(event.currentTarget)}
    onKeyDown={event => {
      if (['Enter', ' ', 'ArrowDown'].includes(event.key)) { event.preventDefault(); onOpen(event.currentTarget) }
    }}>
    <div className="agent-input-recall__copy"><div className="focus-context-hover__input-meta"><strong>{meta.author}</strong>
      <time dateTime={meta.date?.toISOString()} title={meta.provenance} aria-label={`${meta.time} · ${meta.provenance}`}>{meta.time}</time></div>
      <p className="agent-input-recall__excerpt">{meta.reading.text}</p></div>
    {children}
  </div>
}

export function inputPresentation(message: AgentSessionUserMessage): InputPresentation {
  const raw = message.content.trim(), body = parseAgentMuxMessagePrefix(raw)?.body.trim() || raw
  const recorded = message.recordedAt !== undefined && Number.isFinite(message.recordedAt) ? new Date(message.recordedAt) : null
  const date = recorded && Number.isFinite(recorded.getTime()) ? recorded : null
  return { reading: { text: body || 'Non-text input', truncated: false }, date,
    author: createSpeakerResolver()(speakerOfUserMessage(message)).name,
    time: date ? date.toLocaleString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : 'Time unknown',
    provenance: `${message.source.kind === 'native' ? 'Native record' : 'Submission record'} · Current reading window · Record time, not a verified sender time · ${clampStep(raw.slice(0, 1000), 'head', 360)}` }
}
