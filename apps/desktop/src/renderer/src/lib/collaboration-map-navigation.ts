import type { CollaborationSubject } from './agent-collaboration'
import type { CollaborationAreaRequest } from './collaboration-areas'

/** Client camera intent. It carries no message, execution or ownership authority. */
export type CollaborationMapTarget = { kind: 'focus'; subject: CollaborationSubject; name: string } | ({ kind: 'space' } & CollaborationAreaRequest)
