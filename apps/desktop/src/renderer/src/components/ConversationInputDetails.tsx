import type { AgentSessionUserMessageSource } from '@agentmux/core'
import { useId, useState } from 'react'
import type { ConversationSenderDetails, ConversationSpeaker, DescribeSpeaker } from '../lib/conversation-speaker'
import { ProjectIcon } from './ProjectIcon'

/** Opening this disclosure never changes the message's author. */
export function ConversationInputDetails({ messageId, source, speaker, declaredAgentSessionId, describeSpeaker }: {
  messageId: string
  source?: AgentSessionUserMessageSource | undefined
  speaker?: ConversationSpeaker | undefined
  declaredAgentSessionId?: string | null | undefined
  describeSpeaker?: DescribeSpeaker | undefined
}) {
  const senderId = speaker?.role === 'agent' ? speaker.id : declaredAgentSessionId
  const declared = speaker?.role !== 'agent' && Boolean(senderId)
  const identity = JSON.stringify([messageId, source, speaker, senderId])
  const [opened, setOpened] = useState<{ identity: string; details?: ConversationSenderDetails } | null>(null)
  const contentId = useId()
  const open = opened?.identity === identity
  if (!source && !senderId) return null

  function toggle(): void {
    if (open) { setOpened(null); return }
    const details = senderId ? describeSpeaker?.({ role: 'agent', id: senderId }).readDetails?.() : undefined
    setOpened({ identity, ...(details && details.sessionId === senderId ? { details } : {}) })
  }
  const details = open ? opened.details : undefined
  return <div className="conversation-input-details">
    <button type="button" className="conversation-input-details__toggle" aria-expanded={open}
      aria-controls={contentId} onClick={toggle}>Message details</button>
    {open ? <section id={contentId} className="conversation-input-details__body" aria-label="Message details">
      {source ? <dl>
        <dt>Source</dt><dd>{source.kind === 'native' ? `Provider native input · ${source.providerId}` : 'AgentMux submitted record'}</dd>
        <dt>{source.kind === 'native' ? 'Record' : 'Submission'}</dt><dd>{source.kind === 'native' ? source.recordId : source.submissionId}</dd>
        {source.kind === 'native' ? <><dt>Native session</dt><dd>{source.nativeSessionId}</dd></> : null}
        <dt>Delivery channel</dt><dd>Not recorded</dd>
        <dt>Recorded author</dt><dd>{speaker?.role === 'unknown' ? 'Not recorded · shown as You' : speaker?.role ?? 'Not recorded'}</dd>
      </dl> : null}
      {senderId ? <div className="conversation-input-details__sender">
        <h4>{declared ? 'Current details from message header' : 'Current sender'}</h4>
        {details ? <>
          <strong>{details.label}</strong>
          {details.project ? <div className="conversation-input-details__project"><ProjectIcon
            workspaceId={details.project.workspaceId} name={details.project.name} />
            <span>{details.project.name}{details.project.branch ? <small>{details.project.branch}</small> : null}</span></div> : <p>Project not recorded.</p>}
          <dl><dt>Session</dt><dd>{details.sessionId}</dd><dt>Provider</dt><dd>{details.providerId}</dd>
            <dt>Lifecycle start</dt><dd>{Number.isFinite(details.createdAt) ? new Date(details.createdAt).toLocaleString() : 'Unknown'}</dd>
            <dt>Lifecycle end</dt><dd>Not recorded</dd></dl>
          <h4>Explicitly linked goals</h4>
          {details.goals.length ? <ul>{details.goals.map((goal) => <li key={goal.id}>{goal.title}</li>)}</ul> : <p>No linked goal recorded.</p>}
          <p className="conversation-input-details__notice">Current metadata; title, project and goals at message time were not recorded.</p>
        </> : <p>No current sender metadata for this exact session.</p>}
        {declared ? <p className="conversation-input-details__notice">The message header is a source declaration. This lookup does not authenticate its author.</p> : null}
      </div> : null}
    </section> : null}
  </div>
}
