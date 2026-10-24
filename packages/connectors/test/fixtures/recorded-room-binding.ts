import type { DatabaseSync } from 'node:sqlite'
import { parseRoomBinding, parseRoomBindingOperation, parseRecordedRoomBindingInput, type RoomBindingAuthority, type RoomBindingRecordedBindInput } from '../../../core/src/connections.js'
import type { ConversationCheckpointPage } from '../../../core/src/conversation-changes.js'

/** A controlled original database from an earlier request contract, never a new narrow API call. */
export function recordedGroupBinding(database: DatabaseSync, value: RoomBindingRecordedBindInput,
  checkpoint: ConversationCheckpointPage, application: { domain: string; appId: string }, actor: RoomBindingAuthority) {
  const input = parseRecordedRoomBindingInput('connection.bind', value)
  const cuts = checkpoint.checkpoint.frontier.cuts.filter(cut => cut.kind === 'native')
  const sourceFrontier = input.scope.publication === 'future-shared-conversation' ? checkpoint.checkpoint : {
    ...checkpoint.checkpoint, frontier: { ...checkpoint.checkpoint.frontier,
      scope: { sources: checkpoint.scope.sources.filter(source => source.kind === 'native') }, cuts }
  }
  const { operationId: _operationId, expectedConnectionRevision: _expectedConnectionRevision, expectedSource: _expectedSource, ...target } = input
  const binding = parseRoomBinding({ ...target, revision: 1, state: 'active', application,
    sourceCheckpoints: cuts.map(cut => cut.checkpoint), sourceFrontier, authorizedBy: actor })
  const operation = parseRoomBindingOperation({ operationId: input.operationId, action: 'bind', state: 'applied', binding })
  database.exec('BEGIN IMMEDIATE')
  try {
    database.prepare('INSERT INTO room_binding_revision VALUES (?,?,?)').run(binding.bindingId, 1, JSON.stringify(binding))
    database.prepare('INSERT INTO room_binding_head VALUES (?,?,?,?,?,?,?,?)').run(binding.bindingId, 1, binding.connectionId,
      application.domain, application.appId, binding.externalConversationId, binding.executionHostId, binding.agentSessionId)
    database.prepare('INSERT INTO room_binding_operation VALUES (?,?,?)').run(input.operationId,
      JSON.stringify({ action: 'bind', input, actor }), JSON.stringify(operation))
    database.exec('COMMIT')
  } catch (error) { database.exec('ROLLBACK'); throw error }
  return operation
}
