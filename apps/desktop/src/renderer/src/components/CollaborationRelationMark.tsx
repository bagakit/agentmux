import { SemanticIcon } from '@agentmux/client-ui/icons'
import type { CollaborationRelation } from '../lib/agent-collaboration'

/** Category comes from the theme; the directional head remains Map geometry. */
export function CollaborationRelationArrow({ kind }: { kind: CollaborationRelation['kind'] }) {
  return kind === 'creation' ? <>
    <SemanticIcon name="object.agent-creation" x={0} y={0} size={12} />
    <path data-direction-head="open" d="M 13 2 L 19 6 L 13 10" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" />
  </> : <path data-direction-head="filled" d="M 11 2 L 19 6 L 11 10 z" fill="currentColor" />
}

export function CollaborationRelationKey({ kind }: { kind: CollaborationRelation['kind'] }) {
  return <svg className="collaboration-relation-key" data-kind={kind} width={22} height={12} viewBox="0 0 20 12" aria-hidden="true" focusable="false">
    <path d="M 0 6 H 19" stroke="currentColor" strokeWidth={1.3} />
    <CollaborationRelationArrow kind={kind} />
  </svg>
}
