import { semanticIconComponent } from '@agentmux/client-ui/icons'

const ProjectIcon = semanticIconComponent('object.folder')
const AgentIcon = semanticIconComponent('object.agent')

/** Route facts are supplied by the original owner, never derived from display or transport names. */
export type ExecutionRouteRelation =
  | { kind: 'same-device' | 'direct' | 'unconfirmed' }
  | { kind: 'cascade'; hops: number }

export function ExecutionRouteLink({ relation }: { relation: ExecutionRouteRelation }) {
  const hops = relation.kind === 'cascade' && Number.isSafeInteger(relation.hops) && relation.hops > 1 ? relation.hops : null
  const kind = relation.kind === 'cascade' && hops === null ? 'unconfirmed' : relation.kind
  const label = kind === 'same-device' ? 'Same device' : kind === 'direct' ? 'Direct execution path'
    : kind === 'cascade' ? `${hops} execution hops` : 'Execution path unconfirmed'
  const width = hops === null ? 16 : Math.max(22, 12 + String(hops).length * 6)
  return <svg className="execution-route-link" data-path-state={kind} width={width} height={18} viewBox={`0 0 ${width} 18`}
    role="img" aria-label={label} fill="none" stroke="currentColor" strokeWidth={1.2} strokeLinecap="round" strokeLinejoin="round">
    {kind === 'same-device' ? <path d="M1 9h2m10 0h2M7 6H6a3 3 0 0 0 0 6h1m2-6h1a3 3 0 0 1 0 6H9M6 9h4" />
      : <path d={`M2 9h${width - 4}`} strokeDasharray={kind === 'unconfirmed' ? '2 3' : undefined} />}
    {hops !== null ? <><rect x={width / 2 - (String(hops).length * 6 + 4) / 2} y={2} width={String(hops).length * 6 + 4} height={14} rx={4} className="execution-route-link__count-surface" stroke="none" />
      <text x={width / 2} y={12.5} textAnchor="middle" fill="currentColor" stroke="none" fontSize={10}>{hops}</text></> : null}
  </svg>
}

/** Compact content shared by the running identity and its unstarted Launcher selector. */
export function AgentExecutionRelation({ projectLocal, agentLocal, relation }: {
  projectLocal: boolean; agentLocal: boolean; relation: ExecutionRouteRelation
}) {
  return <span className="agent-execution-relation">
    {(['project', 'agent'] as const).map((role, index) => {
      const local = role === 'project' ? projectLocal : agentLocal
      const Icon = role === 'project' ? ProjectIcon : AgentIcon
      return <span className="agent-execution-relation__part" key={role}>
        {index === 1 ? <ExecutionRouteLink relation={relation} /> : null}
        <span className="agent-execution-relation__end" data-execution-role={role} data-local={local || undefined}>
          <Icon size={15} aria-hidden="true" />
          {local ? <svg className="agent-execution-relation__local" viewBox="0 0 10 10" width={10} height={10} aria-hidden="true" fill="none" stroke="currentColor" strokeWidth={1.1} strokeLinecap="round" strokeLinejoin="round">
            <rect x={2} y={2} width={6} height={4.5} rx={.8} /><path d="M1 8h8" />
          </svg> : null}
        </span>
      </span>
    })}
  </span>
}
