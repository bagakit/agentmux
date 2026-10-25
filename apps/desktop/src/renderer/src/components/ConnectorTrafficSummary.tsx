import { semanticIconComponent } from '@agentmux/client-ui/icons'
import type { ConnectorGroupSummary, ConnectorProblem, ConnectorProblemAction, ConnectorProblemKind } from '../lib/connector-group-status'
import '../styles/connector-traffic-summary.css'

const OutgoingIcon = semanticIconComponent('conversation.outgoing'), IncomingIcon = semanticIconComponent('conversation.incoming')
const PausedIcon = semanticIconComponent('status.paused'), DisabledIcon = semanticIconComponent('status.disabled'), PermissionIcon = semanticIconComponent('status.permission'), WaitingIcon = semanticIconComponent('status.waiting'), DocumentIcon = semanticIconComponent('object.document'), AgentIcon = semanticIconComponent('object.agent'), UnknownIcon = semanticIconComponent('status.unknown')
export function ConnectorProblemIcon({ kind }: { kind: ConnectorProblemKind }) {
  const Icon = kind === 'sync-off' || kind === 'platform-off' || kind === 'bot-off' ? DisabledIcon : kind === 'sharing-paused' ? PausedIcon : kind === 'member-access' || kind === 'access-unconfirmed' ? PermissionIcon :
    kind === 'content-gap' ? DocumentIcon : kind === 'outgoing-unconfirmed' || kind === 'outgoing-not-applied' ? OutgoingIcon :
    kind === 'agent-waiting' ? WaitingIcon : kind === 'agent-unconfirmed' || kind === 'agent-stopped' || kind === 'agent-not-applied' ? AgentIcon : UnknownIcon
  return <Icon size={13} />
}

/** The same bounded facts in popover and details. It cannot dispatch or authorize an operation. */
export function ConnectorTrafficSummary({ summary, compact = false, onInspect, actions }: { summary: ConnectorGroupSummary; compact?: boolean; onInspect?(): void;
  actions?: Partial<Record<ConnectorProblemAction['kind'], () => void>> }) {
  function action(problem: ConnectorProblem | undefined) {
    const request = problem?.action, perform = request && actions?.[request.kind]
    return request && perform ? <button type="button" className="agent-connector-text-action connector-traffic-summary__action" onClick={perform}>{request.label}</button> : null
  }
  const primary = new Set([summary.outgoing.problem, summary.incoming.problem].filter(Boolean))
  const problems = summary.problems.filter(problem => !primary.has(problem.kind))
  return <div className={'connector-traffic-summary' + (compact ? ' connector-traffic-summary--compact' : '')}>
    <div className="connector-traffic-summary__directions">
      {[summary.outgoing, summary.incoming].map(direction => {
        const problem = summary.problems.find(problem => problem.kind === direction.problem)
        return <section className="connector-traffic-summary__tile" key={direction.direction} data-direction={direction.direction} data-tone={direction.tone} aria-label={direction.title}>
          {compact ? <><span className="connector-traffic-summary__direction">{direction.direction === 'outgoing' ? <OutgoingIcon size={14} /> : <IncomingIcon size={14} />}{direction.direction === 'outgoing' ? 'To group' : 'To Agent'}</span><div className="connector-traffic-summary__copy"><strong>{direction.value}</strong>{direction.secondary ? <small>{direction.secondary}</small> : null}</div></>
            : <><span className="connector-traffic-summary__leading" aria-hidden="true">{direction.direction === 'outgoing' ? <OutgoingIcon size={16} /> : <IncomingIcon size={16} />}</span>
              <div className="connector-traffic-summary__copy"><span className="connector-traffic-summary__direction">{direction.title}</span><strong>{direction.value}</strong>{direction.secondary ? <small>{direction.secondary}</small> : null}<small>{direction.detail}</small></div>{action(problem)}</>}
        </section>
      })}
    </div>
    {!compact && problems.length ? <ul className="connector-traffic-summary__problems" aria-label="Connection observations">{problems.map(problem => <li key={problem.kind} data-problem-kind={problem.kind} data-tone={problem.tone}>
      <span className="connector-traffic-summary__problem-icon"><ConnectorProblemIcon kind={problem.kind} /></span><div><strong>{problem.title}</strong><small>{problem.detail}</small></div>{action(problem)}
    </li>)}</ul> : null}
    {compact && summary.note ? <p className="connector-traffic-summary__retained">{summary.note}</p> : !compact && summary.retained ? <p className="connector-traffic-summary__retained">Earlier matching observations are kept; the latest check is incomplete.</p> : null}
    {onInspect ? <button type="button" className="agent-connector-text-action connector-traffic-summary__inspect" onClick={onInspect}>View original receipts</button> : null}
  </div>
}
