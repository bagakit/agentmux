import { isDeepStrictEqual } from 'node:util'
import { AgentMuxError } from '@agentmux/core'
import { parseMoteDialogueParams, parseMoteDialogueResult, sameMoteDialogue, moteDialogueSelection,
  type MoteDialogueCallContext, type MoteHeartbeatReportRequest, type MoteHeartbeatSource,
  type MoteMainReader, type MoteMainSnapshot, type MoteHeartbeatIdeaEvidence } from '@agentmux/core/mote-dialogue'
import { parseFileReadResult, parseFileHistoryResult } from '@agentmux/core/files'
import type { MoteDialogueStore } from '@agentmux/core/mote-dialogue-store'

/** One Agent statement in the original dialogue journal; no input or schedule mutation. */
export async function reportMoteHeartbeat(raw: MoteHeartbeatReportRequest, context: MoteDialogueCallContext, options: {
  main: MoteMainReader
  store: MoteDialogueStore
  qualifyHeartbeatSource?(source: MoteHeartbeatSource, main: MoteMainSnapshot, context: MoteDialogueCallContext): Promise<void>
}) {
  const input = structuredClone(parseMoteDialogueParams('space.mote.dialogue.heartbeat.report', raw)), caller = context.caller
  if (!caller?.run || caller.agentSessionId !== input.source.inputKey.agentSessionId || caller.run.runId !== input.source.inputKey.expectedRun.runId)
    throw new AgentMuxError('Only the original Agent and Run may declare work for this selected heartbeat input.', 'CONTROL_PERMISSION_DENIED')
  if (!options.qualifyHeartbeatSource || !context.readInput)
    throw new AgentMuxError('The original heartbeat source owner is unavailable. Keep this report and its input reference.', 'CONTROL_UNAVAILABLE')
  const main = await options.main.readCurrentMoteMain(input.target, context.signal)
  await context.assertCurrent?.()
  if (!main.identity) throw new AgentMuxError('The original Mote identity is unconfirmed. Keep the report and original source.', 'MOTE_DIALOGUE_SOURCE_UNCONFIRMED')
  await options.qualifyHeartbeatSource(input.source, main, context)
  const author = { hostId: caller.hostId, agentSessionId: caller.agentSessionId, run: { ...caller.run } }
  const intent = JSON.stringify({ kind: 'heartbeat-report', ...input, author })
  const prior = await options.store.inspect(main.identity, input.operationId, intent)
  if (prior) return parseMoteDialogueResult('space.mote.dialogue.heartbeat.report', { operationId: input.operationId, links: prior }, input)
  for (const check of input.report.inspected) if (check.kind === 'work') {
    const query = { target: input.target, kind: 'work' as const, ...(check.eventId ? { eventId: check.eventId } : {}), limit: 1 }
    const page = await options.store.read(main.identity, query)
    if (check.incarnation !== null && check.incarnation !== page.incarnation || check.throughSequence > page.throughSequence ||
        check.next && (!sameMoteDialogue(check.next.identity, main.identity) || check.next.selection !== moteDialogueSelection(query)))
      throw new AgentMuxError('The declared reading range belongs to another original Mote journal. Keep its original coverage.', 'MOTE_DIALOGUE_SOURCE_UNCONFIRMED')
  }
  const ideaEvidence: MoteHeartbeatIdeaEvidence[] = []
  for (const [actionIndex, action] of input.report.actions.entries()) {
    if (action.kind !== 'idea') continue
    const resource = action.resource, target = input.target
    if (resource.zoneId !== target.zoneId || resource.hostId !== target.expectedResource.hostId ||
        resource.workspaceId !== target.expectedResource.workspaceId || resource.workspacePath !== target.expectedResource.workspacePath)
      throw new AgentMuxError('The Idea reference belongs to another original Mote Files resource.', 'MOTE_DIALOGUE_SOURCE_UNCONFIRMED')
    const observedAt = Date.now(), unconfirmed = (issue: string) => ideaEvidence.push({ actionIndex, observedAt, status: 'unconfirmed', issue })
    try {
      if (action.note) {
        if (!context.readNoteHistory) { unconfirmed('The original Note history reader is unavailable. No write acknowledgement was inferred.'); continue }
        const request = { ...target, path: action.path, expectedResource: resource, noteId: action.note.noteId, eventId: action.note.eventId, limit: 1 }
        const history = parseFileHistoryResult(await context.readNoteHistory(request), request)
        const event = history.result.status === 'read' ? history.result.entries.find(entry => entry.eventId === action.note!.eventId) : undefined
        if (!event || event.status !== 'committed' || event.revision !== action.revision || event.actor?.kind !== 'agent' || event.actor.id !== caller.agentSessionId) {
          unconfirmed('The exact Note event, committed revision and original Agent attribution are unconfirmed.'); continue
        }
        ideaEvidence.push({ actionIndex, observedAt, status: 'committed-note', noteId: action.note.noteId,
          eventId: action.note.eventId, revision: action.revision, actor: { kind: 'agent', id: caller.agentSessionId } })
      } else {
        if (!context.readFile) { unconfirmed('The original File reader is unavailable. No write acknowledgement was inferred.'); continue }
        const request = { ...target, path: action.path }, result = parseFileReadResult(await context.readFile(request), request)
        if (!isDeepStrictEqual(result.resource, resource) || result.result.status !== 'read' || result.result.document.revision !== action.revision) {
          unconfirmed('The original file at the declared revision is unconfirmed. A read cannot confirm a lost write acknowledgement.'); continue
        }
        ideaEvidence.push({ actionIndex, observedAt, status: 'observed-file', revision: action.revision })
      }
    } catch (error) {
      context.signal?.throwIfAborted()
      unconfirmed('The original Idea evidence is unavailable; no write acknowledgement was inferred. ' + String(error))
    }
  }
  await context.assertCurrent?.()
  await options.qualifyHeartbeatSource(input.source, main, context)
  const links = await options.store.append(main.identity, input.operationId, intent, [{ kind: 'heartbeat', attribution: 'agent-statement',
    source: input.source, author, report: input.report, ideaEvidence, associatedAt: Date.now() }])
  return parseMoteDialogueResult('space.mote.dialogue.heartbeat.report', { operationId: input.operationId, links }, input)
}
