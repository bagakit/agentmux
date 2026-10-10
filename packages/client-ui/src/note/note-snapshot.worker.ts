import { Schema } from '@tiptap/pm/model'
import { EditorState } from '@tiptap/pm/state'
import { noteSnapshotTransaction } from './note-snapshot-transaction.js'
import type { NoteSnapshotRequest, NoteSnapshotReply } from './note-snapshot-sync.js'

export function computeNoteSnapshot(request: NoteSnapshotRequest): NoteSnapshotReply {
  try {
    const schema = new Schema(request.schema)
    const state = EditorState.create({ doc: schema.nodeFromJSON(request.before) })
    const result = noteSnapshotTransaction(state, schema.nodeFromJSON(request.target))
    return result.status === 'failed' ? { generation: request.generation, ...result }
      : { generation: request.generation, status: 'ready', steps: result.status === 'ready' ? result.transaction.steps.map(step => step.toJSON()) : [] }
  } catch (error) { return { generation: request.generation, status: 'failed', message: 'The incoming update is waiting; your current input is kept. ' + (error instanceof Error ? error.message : String(error)) } }
}
if (typeof self !== 'undefined' && typeof document === 'undefined') self.onmessage = (event: MessageEvent<NoteSnapshotRequest>) => self.postMessage(computeNoteSnapshot(event.data))
