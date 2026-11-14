import { AgentMuxError } from '../errors.js'
import { rpcRecord, rpcString } from '../rpc-data.js'
import { AGENTMUX_RPC_MAX_MESSAGE_BYTES } from '../public-rpc-frame.js'
import { validateAgentPromptInputKey, type AgentPromptInputKey } from '../agent-prompt-condition.js'
import { parseFileReadParams, parseFileReadResource, parseFileReadResult, type FileReadResource } from '../public-rpc-files.js'
import type { MoteDialogueCursor } from './dialogue-contract.js'
import type { AgentMuxRunRef } from '../types.js'

/** An explicitly selected original automatic input, never the latest tick. */
export type MoteHeartbeatSource = {
  inputKey: Extract<AgentPromptInputKey, { kind: 'prompt' }>
  scheduleId: string
  definitionIntentId: string
  occurrenceAt: number
  mainRoleRevision: string
}
/** These are the Agent's declared reading scope, not a server log of tool use. */
export type MoteHeartbeatInspection = ({ kind: 'work'; incarnation: string | null; throughSequence: number;
  next: MoteDialogueCursor | null; eventId?: string } | { kind: 'goal'; hostId: string; goalId: string; alignmentRevision: number | null }) & {
  sourceStatus: 'read' | 'unconfirmed'; issue: string | null
}
export type MoteHeartbeatAction =
  | { kind: 'work'; eventId: string; messageHostId: string; messageId: string; threadId: string }
  | { kind: 'goal'; hostId: string; goalId: string; operationId: string }
  | { kind: 'idea'; path: string; resource: FileReadResource; revision: string; note?: { noteId: string; eventId: string } }
export type MoteHeartbeatReport = { disposition: 'quiet' | 'needs-attention'; summary: string;
  inspected: MoteHeartbeatInspection[]; actions: MoteHeartbeatAction[] }
export type MoteHeartbeatIdeaEvidence = { actionIndex: number; observedAt: number } & (
  | { status: 'observed-file'; revision: string }
  | { status: 'committed-note'; noteId: string; eventId: string; revision: string; actor: { kind: 'agent'; id: string } }
  | { status: 'unconfirmed'; issue: string })
export type MoteHeartbeatStatement = {
  kind: 'heartbeat'; attribution: 'agent-statement'; source: MoteHeartbeatSource
  author: { hostId: string; agentSessionId: string; run: AgentMuxRunRef }
  report: MoteHeartbeatReport; ideaEvidence: MoteHeartbeatIdeaEvidence[]
}

const fail = (code: string): never => { throw new AgentMuxError('The original heartbeat statement or reference is invalid. Its input and existing work are retained.', code) }
const id = (value: unknown, code: string): string => { try { return rpcString(value, 'Heartbeat reference') } catch { return fail(code) } }
const count = (value: unknown, code: string): number => Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : fail(code)
const revision = (value: unknown, code: string): string => typeof value === 'string' && /^sha256:[a-f0-9]{64}$/u.test(value) ? value : fail(code)
export function parseMoteHeartbeatSource(value: unknown, code = 'INVALID_CONTROL_REQUEST'): MoteHeartbeatSource {
  const p = rpcRecord(value, ['inputKey', 'scheduleId', 'definitionIntentId', 'occurrenceAt', 'mainRoleRevision'], code)
  const key = validateAgentPromptInputKey(p.inputKey)
  if (key.kind !== 'prompt') return fail(code)
  id(p.scheduleId, code); id(p.definitionIntentId, code); id(p.mainRoleRevision, code); count(p.occurrenceAt, code)
  return p as MoteHeartbeatSource
}
export function parseMoteHeartbeatReport(value: unknown, code = 'INVALID_CONTROL_REQUEST'): MoteHeartbeatReport {
  const p = rpcRecord(value, ['disposition', 'summary', 'inspected', 'actions'], code)
  if (!['quiet', 'needs-attention'].includes(p.disposition as string) || !Array.isArray(p.inspected) || !Array.isArray(p.actions)) return fail(code)
  id(p.summary, code)
  // Use the original RPC envelope and short-text contract, not a second quota policy.
  if (new TextEncoder().encode(JSON.stringify(p)).byteLength > AGENTMUX_RPC_MAX_MESSAGE_BYTES) return fail(code)
  for (const raw of p.inspected) {
    const item = rpcRecord(raw, undefined, code)
    rpcRecord(item, ['kind', 'sourceStatus', 'issue', ...(item.kind === 'work' ? ['incarnation', 'throughSequence', 'next', 'eventId'] : ['hostId', 'goalId', 'alignmentRevision'])], code)
    if (item.sourceStatus === 'read' ? item.issue !== null : item.sourceStatus !== 'unconfirmed' || typeof item.issue !== 'string' || !item.issue.trim()) return fail(code)
    if (item.kind === 'goal') {
      id(item.hostId, code); id(item.goalId, code)
      if (item.alignmentRevision !== null) count(item.alignmentRevision, code)
      if (item.sourceStatus === 'read' && item.alignmentRevision === null) return fail(code)
    } else if (item.kind === 'work') {
      count(item.throughSequence, code)
      if (item.eventId !== undefined) id(item.eventId, code)
      if (item.incarnation !== null) id(item.incarnation, code)
      if (item.next !== null) {
        const cursor = rpcRecord(item.next, ['identity', 'incarnation', 'selection', 'throughSequence', 'beforeSequence'], code)
        const identity = rpcRecord(cursor.identity, ['hostId', 'moteId'], code)
        id(identity.hostId, code); id(identity.moteId, code); id(cursor.incarnation, code); id(cursor.selection, code)
        count(cursor.throughSequence, code); count(cursor.beforeSequence, code)
        if (cursor.incarnation !== item.incarnation || cursor.throughSequence !== item.throughSequence || Number(cursor.beforeSequence) < 1 || Number(cursor.beforeSequence) > Number(cursor.throughSequence) + 1) return fail(code)
      }
      if (item.incarnation === null && (item.throughSequence !== 0 || item.next !== null)) return fail(code)
    } else return fail(code)
  }
  for (const raw of p.actions) {
    const action = rpcRecord(raw, undefined, code)
    if (action.kind === 'idea') {
      rpcRecord(action, ['kind', 'path', 'resource', 'revision', 'note'], code)
      const resource = parseFileReadResource(action.resource, code)
      const request = { zoneId: resource.zoneId, path: action.path as string, expectedResource: { hostId: resource.hostId, workspaceId: resource.workspaceId, workspacePath: resource.workspacePath } }
      parseFileReadParams(request)
      try { parseFileReadResult({ resource, result: { status: 'directory' } }, request) } catch { return fail(code) }
      revision(action.revision, code)
      if (action.note !== undefined) { const note = rpcRecord(action.note, ['noteId', 'eventId'], code); id(note.noteId, code); id(note.eventId, code) }
    } else if (action.kind === 'work') {
      rpcRecord(action, ['kind', 'eventId', 'messageHostId', 'messageId', 'threadId'], code)
      for (const key of ['eventId', 'messageHostId', 'messageId', 'threadId']) id(action[key], code)
    } else if (action.kind === 'goal') {
      rpcRecord(action, ['kind', 'hostId', 'goalId', 'operationId'], code)
      for (const key of ['hostId', 'goalId', 'operationId']) id(action[key], code)
    } else return fail(code)
  }
  return p as MoteHeartbeatReport
}
export function parseMoteHeartbeatStatement(value: unknown, code = 'CONTROL_PROTOCOL_ERROR'): MoteHeartbeatStatement {
  const p = rpcRecord(value, ['kind', 'attribution', 'source', 'author', 'report', 'ideaEvidence'], code)
  if (p.kind !== 'heartbeat' || p.attribution !== 'agent-statement' || !Array.isArray(p.ideaEvidence)) return fail(code)
  const source = parseMoteHeartbeatSource(p.source, code), report = parseMoteHeartbeatReport(p.report, code)
  const author = rpcRecord(p.author, ['hostId', 'agentSessionId', 'run'], code), run = rpcRecord(author.run, ['runId'], code)
  id(author.hostId, code); id(author.agentSessionId, code); id(run.runId, code)
  if (author.agentSessionId !== source.inputKey.agentSessionId || run.runId !== source.inputKey.expectedRun.runId) return fail(code)
  const ideas = report.actions.flatMap((action, index) => action.kind === 'idea' ? [index] : [])
  if (ideas.length !== p.ideaEvidence.length) return fail(code)
  for (const [index, raw] of p.ideaEvidence.entries()) {
    const evidence = rpcRecord(raw, undefined, code)
    rpcRecord(evidence, ['actionIndex', 'observedAt', 'status', ...(evidence.status === 'observed-file' ? ['revision'] : evidence.status === 'committed-note' ? ['noteId', 'eventId', 'revision', 'actor'] : ['issue'])], code)
    if (evidence.actionIndex !== ideas[index]) return fail(code)
    count(evidence.observedAt, code)
    const action = report.actions[ideas[index]!] as Extract<MoteHeartbeatAction, { kind: 'idea' }>
    if (evidence.status === 'observed-file' || evidence.status === 'committed-note') {
      if (revision(evidence.revision, code) !== action.revision) return fail(code)
      if (evidence.status === 'committed-note') {
        const actor = rpcRecord(evidence.actor, ['kind', 'id'], code)
        if (actor.kind !== 'agent' || actor.id !== author.agentSessionId || !action.note || evidence.noteId !== action.note.noteId || evidence.eventId !== action.note.eventId) return fail(code)
      }
    } else if (evidence.status === 'unconfirmed') { if (typeof evidence.issue !== 'string' || !evidence.issue.trim()) return fail(code) }
    else return fail(code)
  }
  return p as MoteHeartbeatStatement
}
