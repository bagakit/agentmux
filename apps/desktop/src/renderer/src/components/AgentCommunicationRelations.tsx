import { useEffect, useState } from 'react'
import type { AgentMuxRpcResult } from '@agentmux/core'
import type { AgentSessionControl } from '../../../shared/contracts'
import { api } from '../lib/api'

type Page = AgentMuxRpcResult<'message.dispatch.ls'>
type Reading = { scope: string; page?: Page; issue?: string }
const reason = (error: unknown) => error instanceof Error ? error.message : String(error)

/** An explicitly opened, bounded view of original supervised requests; never an inbox consumer. */
export function AgentCommunicationRelations({ control }: { control: AgentSessionControl }) {
  const scope = JSON.stringify([control.hostId, control.agentSessionId, control.run.runId])
  const [reading, setReading] = useState<Reading>()
  useEffect(() => {
    let current = true
    const subject = { hostId: control.hostId, agentSessionId: control.agentSessionId }
    void api.sessions.dispatches(subject, { limit: 10 }).then(page => {
      if (!current) return
      if (page.hostId !== subject.hostId || page.participantSessionId !== subject.agentSessionId ||
        page.dispatches.some(item => item.ownerAgentSessionId !== subject.agentSessionId && item.workerAgentSessionId !== subject.agentSessionId)) {
        setReading({ scope, issue: 'The original Host or participant did not match this reading source.' }); return
      }
      setReading({ scope, page })
    }, error => { if (current) setReading({ scope, issue: reason(error) }) })
    return () => { current = false }
  }, [scope])
  const held = reading?.scope === scope ? reading : undefined
  const page = held?.page
  const relations = new Map<string, { id: string; direction: 'to' | 'from'; count: number; awaiting: number }>()
  for (const request of page?.dispatches ?? []) {
    const direction = request.ownerAgentSessionId === control.agentSessionId ? 'to' : 'from'
    const id = direction === 'to' ? request.workerAgentSessionId : request.ownerAgentSessionId
    const key = JSON.stringify([direction, id]), held = relations.get(key) ?? { id, direction, count: 0, awaiting: 0 }
    ++held.count; if (request.originAwaits) ++held.awaiting
    relations.set(key, held)
  }
  return <section className="agent-information-relations__messages" aria-label="Recorded message relationships">
    <h4>Supervised requests</h4>
    <p className="focus-context-hover__coverage">Loaded records only; other messages and current execution are separate. Peer location is not confirmed by these records.</p>
    {held?.issue ? <p role="status">Message relationships unavailable. {held.issue}</p> : !page ? <p role="status">Reading message relationships…</p> : <>
      {relations.size ? <ul>{[...relations].map(([key, relation]) => <li key={key}>
        <span>Request {relation.direction} </span><code>{relation.id}</code>
        <small>{relation.count} loaded {relation.count === 1 ? 'request' : 'requests'}{relation.awaiting ? ` · ${relation.awaiting} awaiting report` : ' · Reports recorded'}</small>
      </li>)}</ul> : <p>No supervised requests in this reading window.</p>}
      {page.nextSourceMessageId ? <p className="focus-context-hover__coverage">More records are available in the Agent’s Mailbox.</p> : null}
    </>}
  </section>
}
