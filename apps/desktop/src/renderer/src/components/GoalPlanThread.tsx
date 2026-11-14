import { useEffect, useState } from 'react'
import type { AgentMuxRpcResult } from '@agentmux/core'
import type { DemandDelegation } from '@agentmux/demand/delegations'
import { Button } from '@agentmux/client-ui/components/Button'
import { api } from '../lib/api'
import { MailboxOriginalMessage } from './MailboxCollaboration'

/** Read the original dispatch on demand; opening a plan never sends or consumes input. */
export function GoalPlanThread({ delegation }: { delegation: DemandDelegation }) {
  const [expanded, setExpanded] = useState(false), [retry, setRetry] = useState(0)
  const [record, setRecord] = useState<AgentMuxRpcResult<'message.dispatch.read'> | null>(null)
  const [issue, setIssue] = useState<string | null>(null), [loading, setLoading] = useState(false)
  const { hostId, sourceMessageId, threadId, ownerAgentSessionId, workerAgentSessionId, ownerRunId, workerRunId } = delegation
  useEffect(() => {
    if (!expanded) return
    let current = true
    setLoading(true); setIssue(null)
    void api.sessions.dispatch({ hostId, agentSessionId: ownerAgentSessionId }, sourceMessageId).then(value => {
      const source = value.source.envelope, dispatch = value.dispatch
      if (value.hostId !== hostId || dispatch.sourceMessageId !== sourceMessageId || source.messageId !== sourceMessageId ||
        dispatch.threadId !== threadId || source.threadId !== threadId || dispatch.ownerAgentSessionId !== ownerAgentSessionId ||
        dispatch.workerAgentSessionId !== workerAgentSessionId || source.senderSessionId !== ownerAgentSessionId ||
        source.recipientSessionId !== workerAgentSessionId || source.senderRunId !== ownerRunId || source.recipientRunId !== workerRunId)
        throw new Error('The original thread did not match this plan attempt. Its reference and Agents are retained.')
      if (current) setRecord(value)
    }).catch(error => { if (current) setIssue(error instanceof Error ? error.message : String(error)) })
      .finally(() => { if (current) setLoading(false) })
    return () => { current = false }
  }, [expanded, retry, hostId, sourceMessageId, threadId, ownerAgentSessionId, workerAgentSessionId, ownerRunId, workerRunId])
  return <div className="goal-plan-node__thread">
    <Button type="button" aria-expanded={expanded} data-goal-plan-thread={sourceMessageId}
      onClick={() => setExpanded(value => !value)}>{expanded ? 'Hide original thread' : 'Read original thread'}</Button>
    {expanded ? <section aria-label="Original plan thread">
      {loading ? <p className="goals-caption" role="status">Reading original thread…</p> : null}
      {issue ? <p className="goals-service" role="status">{issue} <Button type="button" onClick={() => setRetry(value => value + 1)}>Read again</Button></p> : null}
      {record ? <>
        <MailboxOriginalMessage record={record.source} />
        {record.replies.map(reply => <MailboxOriginalMessage key={reply.envelope.messageId} record={reply} />)}
        {!record.replies.length ? <p className="goals-caption">No replies recorded in this thread.</p> : null}
      </> : null}
    </section> : null}
  </div>
}
