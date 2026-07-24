import { Bot, CircleDot, Hammer, ShieldAlert, UserRound } from 'lucide-react'
import type { AgentActivity } from '../../../shared/contracts'

function Icon({ kind }: { kind: AgentActivity['kind'] }) {
  if (kind === 'prompt') return <UserRound size={14} />
  if (kind === 'assistant') return <Bot size={14} />
  if (kind === 'tool') return <Hammer size={14} />
  if (kind === 'permission') return <ShieldAlert size={14} />
  return <CircleDot size={14} />
}

export function ConversationView({ activities }: { activities: AgentActivity[] }) {
  return (
    <div className="conversation">
      <div className="conversation__notice">
        Observable agent activity · hook and user events only, not private chain-of-thought
      </div>
      {activities.length === 0 ? (
        <div className="conversation__empty">No structured activity yet. Terminal output remains available.</div>
      ) : (
        activities.map((item) => (
          <article key={item.id} className={`activity activity--${item.kind}`}>
            <div className="activity__rail"><Icon kind={item.kind} /></div>
            <div className="activity__body">
              <header>
                <strong>{item.title}</strong>
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
