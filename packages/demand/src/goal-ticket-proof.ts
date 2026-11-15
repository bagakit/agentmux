/** Portable record contract. Only the Runtime owning the Goal is allowed to attest writes. */
export type GoalTicketOwner = { runtimeId: string; namespace: string }
export type GoalTicketScope = GoalTicketOwner & { goalId: string }
export type GoalTicketActor = { kind: 'agent' | 'user' | 'device'; id: string; runtimeId?: string; hostId?: string }
export type GoalTicketTask = { outcome: string; check: string; criteria: { id: string; text: string }[] }
export type GoalTicketDependency = { ticketId: string; completionHash: string }
export type GoalTicketCheck = { command: string; result: string; evidence: string[] }
export type GoalTicketRecord = { scope: GoalTicketScope; operationId: string; actor: GoalTicketActor } & (
  | { kind: 'issued'; draftId: string; task: GoalTicketTask; predecessors: string[]; proposal?: { attemptId: string; replyId: string; author: GoalTicketActor } }
  | { kind: 'claim' | 'dispatch'; ticketId: string; executor: { id: string; hostId: string; runtimeId?: string }; task: GoalTicketTask; predecessors: GoalTicketDependency[] }
  | { kind: 'completed'; ticketId: string; attemptId: string; executionHash: string; deliveryHash: string; check: GoalTicketCheck; note: string }
)
export type GoalTicketProof = { schema: 'agentmux.goal-ticket-proof.v1'; hash: string; publicKey: string; signature: string; record: GoalTicketRecord }
export type GoalTicketSigner = {
  owner: GoalTicketOwner
  issue(record: GoalTicketRecord): GoalTicketProof
  verify(proof: GoalTicketProof): void
}

export function isGoalTicketHash(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/u.test(value)
}

function record(value: unknown, required: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || required.some(key => !Object.hasOwn(value, key)) ||
      Object.keys(value).some(key => !required.includes(key) && !optional.includes(key)))
    throw new Error('Invalid Goal Ticket proof record fields')
  return value as Record<string, unknown>
}
function id(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || /[\0\r\n\p{Surrogate}]/u.test(value)) throw new Error('Invalid Goal Ticket proof identity')
  return value
}
function text(value: unknown): string {
  if (typeof value !== 'string') throw new Error('Invalid Goal Ticket proof text')
  return value
}
function hash(value: unknown): string {
  if (!isGoalTicketHash(value)) throw new Error('Invalid Goal Ticket proof hash')
  return value
}
function array<T>(value: unknown, parse: (part: unknown) => T): T[] {
  if (!Array.isArray(value)) throw new Error('Invalid Goal Ticket proof list')
  return value.map(parse)
}
function parseActor(value: unknown): GoalTicketActor {
  const a = record(value, ['kind', 'id'], ['hostId', 'runtimeId'])
  if (a.kind !== 'agent' && a.kind !== 'user' && a.kind !== 'device') throw new Error('Invalid Goal Ticket proof actor')
  return { kind: a.kind, id: id(a.id), ...(a.hostId !== undefined ? { hostId: id(a.hostId) } : {}), ...(a.runtimeId !== undefined ? { runtimeId: id(a.runtimeId) } : {}) }
}
function parseTask(value: unknown): GoalTicketTask {
  const t = record(value, ['outcome', 'check', 'criteria'])
  const criteria = array(t.criteria, value => { const c = record(value, ['id', 'text']); return { id: id(c.id), text: text(c.text) } })
  return { outcome: text(t.outcome), check: text(t.check), criteria }
}
export function parseGoalTicketRecord(value: unknown): GoalTicketRecord {
  const root = ['kind', 'scope', 'operationId', 'actor']
  const candidate = value as { kind?: unknown } | null
  const v = candidate?.kind === 'issued' ? record(value, [...root, 'draftId', 'task', 'predecessors'], ['proposal'])
    : candidate?.kind === 'claim' || candidate?.kind === 'dispatch' ? record(value, [...root, 'ticketId', 'executor', 'task', 'predecessors'])
    : record(value, [...root, 'ticketId', 'attemptId', 'executionHash', 'deliveryHash', 'check', 'note'])
  const s = record(v.scope, ['runtimeId', 'namespace', 'goalId'])
  const base = { scope: { runtimeId: id(s.runtimeId), namespace: id(s.namespace), goalId: id(s.goalId) }, operationId: id(v.operationId), actor: parseActor(v.actor) }
  if (v.kind === 'issued') {
    const p = v.proposal === undefined ? undefined : record(v.proposal, ['attemptId', 'replyId', 'author'])
    return { ...base, kind: v.kind, draftId: id(v.draftId), task: parseTask(v.task), predecessors: array(v.predecessors, hash),
      ...(p ? { proposal: { attemptId: id(p.attemptId), replyId: id(p.replyId), author: parseActor(p.author) } } : {}) }
  }
  const ticketId = hash(v.ticketId)
  if (v.kind === 'claim' || v.kind === 'dispatch') {
    const e = record(v.executor, ['id', 'hostId'], ['runtimeId'])
    const predecessors = array(v.predecessors, value => { const p = record(value, ['ticketId', 'completionHash']); return { ticketId: hash(p.ticketId), completionHash: hash(p.completionHash) } })
    return { ...base, kind: v.kind, ticketId, executor: { id: id(e.id), hostId: id(e.hostId), ...(e.runtimeId !== undefined ? { runtimeId: id(e.runtimeId) } : {}) }, task: parseTask(v.task), predecessors }
  }
  if (v.kind !== 'completed' || typeof v.deliveryHash !== 'string' || !/^[a-f0-9]{64}$/u.test(v.deliveryHash)) throw new Error('Invalid Goal Ticket completion')
  const c = record(v.check, ['command', 'result', 'evidence'])
  return { ...base, kind: v.kind, ticketId, attemptId: id(v.attemptId), executionHash: hash(v.executionHash), deliveryHash: v.deliveryHash,
    check: { command: text(c.command), result: text(c.result), evidence: array(c.evidence, text) }, note: text(v.note) }
}
export function parseGoalTicketProof(value: unknown): GoalTicketProof {
  const proof = record(value, ['schema', 'hash', 'publicKey', 'signature', 'record'])
  if (proof.schema !== 'agentmux.goal-ticket-proof.v1' || typeof proof.publicKey !== 'string' || !/^[A-Za-z0-9_-]{59}$/u.test(proof.publicKey) ||
      typeof proof.signature !== 'string' || !/^[A-Za-z0-9_-]{86}$/u.test(proof.signature)) throw new Error('Invalid Goal Ticket proof encoding')
  return { schema: proof.schema, hash: hash(proof.hash), publicKey: proof.publicKey, signature: proof.signature, record: parseGoalTicketRecord(proof.record) }
}
