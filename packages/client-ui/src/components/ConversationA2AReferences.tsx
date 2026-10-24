import type { DurableAgentMuxMessage } from '@agentmux/core'
import type { AgentMuxMessagePrefix } from '@agentmux/core/agent-message-render'
import type { ConversationRef } from '@agentmux/core/conversation'
import { useEffect, useMemo, useState, type ComponentProps } from 'react'
import { useA2AMessageReader } from '../platform.js'
import { ConversationA2ATiming, ConversationA2ADetails } from './ConversationA2AMetadata.js'
import { ConversationMessage } from './ConversationMessage.js'

type Reference = Extract<AgentMuxMessagePrefix, { kind: 'references' }>['references'][number]
type Reading = Pick<ComponentProps<typeof ConversationMessage>, 'active' | 'describeSpeaker' | 'workspaceRoot' | 'homeDir' | 'openWorkspaceFile' | 'readPastedImage' | 'openHttpLink' | 'timeFormatter'>

/** Original notice scope is supplied by the qualified record, never by its wire declaration. */
export function ConversationA2AReferences({ references, scope, ...reading }: Reading & { references: readonly Reference[]; scope?: ConversationRef | undefined; notificationId?: string | undefined }) {
  return <section className="conversation-a2a-originals" aria-label="Original A2A messages">
    {references.map((reference, index) => <Original key={JSON.stringify([reference.declaredMessageId, index])} reference={reference} scope={scope} {...reading} />)}
  </section>
}

function Original({ reference, scope, notificationId, active = true, ...reading }: Reading & { reference: Reference; scope?: ConversationRef | undefined; notificationId?: string | undefined }) {
  const read = useA2AMessageReader()
  const owner = useMemo(() => ({}), [read, scope?.hostId, scope?.agentSessionId, reference.declaredMessageId, reference.declaredAgentSessionId, notificationId])
  const [attempt, setAttempt] = useState(0)
  const [state, setState] = useState<{ owner: object; attempt: number; message?: DurableAgentMuxMessage; error?: string }>({ owner, attempt })
  const current = state.owner === owner ? state : undefined
  useEffect(() => {
    if (!active || !read || !scope || current?.message && current.attempt === attempt) return
    let retained = true
    setState(previous => previous.owner === owner && previous.message ? previous : { owner, attempt })
    const failed = (error: string) => setState(previous => previous.owner === owner && previous.message
      ? { ...previous, attempt, error } : { owner, attempt, error })
    // The effect belongs to one original Host/participant/MID and is invalidated on hide or replacement.
    void Promise.resolve().then(() => read({ hostId: scope.hostId, agentSessionId: scope.agentSessionId }, reference.declaredMessageId, notificationId)).then(message => {
      if (!retained) return
      const envelope = message?.envelope
      if (!envelope) failed('The original message was not found at this Host. The reference is retained.')
      else if (envelope.messageId !== reference.declaredMessageId || envelope.recipientSessionId !== scope.agentSessionId ||
        envelope.sender.kind !== 'agent-session' || envelope.sender.agentSessionId !== reference.declaredAgentSessionId || envelope.senderSessionId !== envelope.sender.agentSessionId) {
        failed('The original message identity does not match this reference. The reference is retained.')
      } else setState({ owner, attempt, message: message! })
    }, failure => { if (retained) failed(failure instanceof Error ? failure.message : 'The original message could not be read.') })
    return () => { retained = false }
  }, [owner, active, attempt])
  if (current?.message && scope) {
    const envelope = current.message.envelope
    return <div data-a2a-original-message-id={envelope.messageId}>
      <ConversationMessage {...reading} active={active} recordedIdentity expandedContent contextInDetails
        conversationSessionId={scope.agentSessionId} executionHostId={scope.hostId} messageId={envelope.messageId}
        speaker={{ role: 'agent', id: envelope.senderSessionId! }} content={envelope.body} contentBoundary="body" createdAt={envelope.createdAt}
        messageTiming={<ConversationA2ATiming message={current.message} notificationId={notificationId} timeFormatter={reading.timeFormatter}
          onRefresh={() => setAttempt(value => value + 1)} refreshing={current.attempt !== attempt} readIssue={current.error} />}
        messageDetails={<ConversationA2ADetails message={current.message} notificationId={notificationId} hostId={scope.hostId} />} />
    </div>
  }
  return <div className="conversation-a2a-originals__pending" data-a2a-reference-id={reference.declaredMessageId}>
    <span>From <code>{reference.declaredAgentSessionId}</code> · Message <code>{reference.declaredMessageId}</code></span>
      <p role="status">{current?.error ?? (!scope ? 'The original message Host is unknown. The reference is retained.' : read ? 'Reading original message…' : 'Original message reading is unavailable in this client.')}</p>
    {current?.error && read ? <button type="button" className="small-button" onClick={() => setAttempt(value => value + 1)}>Retry original message</button> : null}
  </div>
}
