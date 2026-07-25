import { Bot, CircleDot, Hammer, ShieldAlert, UserRound } from 'lucide-react'
import type { AgentTimelineItem } from '../../../shared/contracts'

function Icon({ kind }: { kind: AgentTimelineItem['kind'] }) {
  if (kind === 'user_message') return <UserRound size={14} />
  if (kind === 'assistant_message') return <Bot size={14} />
  if (kind === 'tool_call') return <Hammer size={14} />
  if (kind === 'permission') return <ShieldAlert size={14} />
  return <CircleDot size={14} />
}

export function ActivityView({
  items,
  capability
}: {
  items: AgentTimelineItem[]
  capability: 'unavailable' | 'complete-events' | 'streaming'
}) {
  return (
    <div className="activity-feed">
      <div className="activity-feed__notice">
        Structured Session activity only · never Terminal output or private chain-of-thought
      </div>
      {capability === 'unavailable' ? (
        <div className="activity-feed__empty">This executor does not provide structured activity. Terminal remains available.</div>
      ) : items.length === 0 ? (
        <div className="activity-feed__empty">No structured activity yet. Terminal remains available.</div>
      ) : (
        items.map((item) => (
          <article key={item.id} className={`activity activity--${item.kind}`}>
            <div className="activity__rail"><Icon kind={item.kind} /></div>
            <div className="activity__body">
              <header>
                <strong>{item.title}</strong>
                {item.status === 'streaming' ? <span className="activity__status">Streaming</span> : null}
                {item.status === 'failed' ? <span className="activity__status">Failed</span> : null}
                <span className={`provenance provenance--${item.source}`}>{item.source}</span>
                <time>{new Date(item.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</time>
              </header>
              {item.content ? <p>{item.content}</p> : null}
              {item.toolInput ? <pre>{item.toolInput}</pre> : null}
            </div>
          </article>
        ))
      )}
    </div>
  )
}
