import { createHash } from 'node:crypto'
import { AgentMuxError } from '@agentmux/core'
import { parseFileEntryWitness, type FileDeleteParams, type FileEntryWitness } from '@agentmux/core/files'
import { readNoteMarkdownHeader } from '@agentmux/core/note-format'
import { noteHistoryRevision } from '@agentmux/core/note-history'
import type { AgentMuxNotebookStore, NotebookActor } from '@agentmux/core/notebook-store'
import { noteProvenanceResourceKey } from '@agentmux/core/note-provenance'
import { fileBytesAreBinary, type OrdinaryWorkspaceFiles } from './ordinary-files.js'
import { WORKSPACE_FILE_MAX_BYTES } from './workspace-file-bytes.js'
import type { WorkspaceRecord } from './content-types.js'

/** Only this finite deletion owns these pending events; bodies stay in original history. */
export class FileDeleteHistory {
  private catalog?: Promise<Map<string, string[]>>
  private readonly events = new Map<string, string>()
  constructor(private readonly notes: Pick<AgentMuxNotebookStore, 'fileResourceIdentities' | 'readHistory' | 'readHistoryOperation' | 'recordHistory'>,
    private readonly files: Pick<OrdinaryWorkspaceFiles, 'readByteRange'>, private readonly workspace: WorkspaceRecord,
    private readonly input: FileDeleteParams, private readonly digest: string, private readonly actor: NotebookActor) {}
  private registered(): Promise<Map<string, string[]>> {
    return this.catalog ??= this.notes.fileResourceIdentities(this.input.expectedResource).then(originals => {
      const result = new Map<string, string[]>(), resource = this.input.expectedResource
      for (const page of originals) {
        const r = page.resource
        if (r.hostId !== resource.hostId || r.workspaceId !== resource.workspaceId || r.workspacePath !== resource.workspacePath || r.path !== resource.path && !r.path.startsWith(resource.path + '/')) continue
        const key = noteProvenanceResourceKey(r), ids = result.get(key) ?? []; ids.push(page.noteId); result.set(key, ids)
      }
      return result
    })
  }
  async snapshot(value: { suffix: string; entry: FileEntryWitness; prefixHex: string; location: { root: string; path: string } }): Promise<string | null> {
    const { suffix, prefixHex, location: { root, path } } = value, witness = structuredClone(parseFileEntryWitness(value.entry))
    if (suffix && this.input.expected.entry.kind !== 'directory') throw new AgentMuxError('The original delete producer returned another subtree.', 'FILE_DELETE_SNAPSHOT_CONFLICT')
    const resource = { hostId: this.workspace.hostId, workspaceId: this.workspace.id,
      workspacePath: this.workspace.path, path: this.input.expectedResource.path + (suffix ? '/' + suffix : '') }
    // An ordinary Unix child may contain literal backslashes. Query the exact
    // existing key without imposing Note-path validation on a non-Note file.
    const registered = (await this.registered()).get(JSON.stringify([resource.hostId, resource.workspaceId, resource.workspacePath, resource.path])) ?? []
    if (registered.length > 1) throw new AgentMuxError('The current file has ambiguous registered Note identities. Its claim is retained.', 'FILE_DELETE_NOTE_IDENTITY_CONFLICT')
    // A necessary prefix of the existing machine format, never an identity or
    // suffix-based classification. Potential headers are read with the full budget.
    const potentialHeader = ['2d2d2d0a', '2d2d2d0d0a', 'efbbbf2d2d2d0a', 'efbbbf2d2d2d0d0a'].some(prefix => prefixHex.startsWith(prefix))
    if (!registered.length && !potentialHeader) return null
    // The finite producer still holds the original inode open. The original byte
    // reader compares this precise FD generation before reading, rather than
    // reopening the old logical path or checking only a later path stat.
    const read = await this.files.readByteRange({ ...this.workspace, path: root }, path,
      { offset: 0, maxBytes: WORKSPACE_FILE_MAX_BYTES, maxFileBytes: WORKSPACE_FILE_MAX_BYTES, expectedWitness: witness })
    if (read.nextOffset !== null || read.totalBytes !== Number(witness.size) || fileBytesAreBinary(read.bytes)) throw new AgentMuxError('The exact current Note body is unreadable or binary. The original claim and request are retained.', 'FILE_DELETE_NOTE_BODY_UNAVAILABLE')
    const content = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(read.bytes), header = readNoteMarkdownHeader(content)
    if (header.status === 'valid' && registered.length && registered[0] !== header.noteId) throw new AgentMuxError('The registered resource and current Note header disagree. The original body is retained in its claim.', 'FILE_DELETE_NOTE_IDENTITY_CONFLICT')
    const noteId = registered[0] ?? (header.status === 'valid' ? header.noteId : undefined)
    if (!noteId) return null
    const eventId = this.input.operationId + '/note-delete/' + createHash('sha256').update(JSON.stringify([noteId, resource])).digest('hex')
    const fingerprint = noteHistoryRevision(JSON.stringify(['agentmux.file-delete-snapshot.v1', this.digest, noteId, resource, witness, read.revision]))
    const existing = await this.notes.readHistoryOperation(eventId)
    if (existing) {
      if (existing.operation !== 'delete' || existing.requestFingerprint !== fingerprint || existing.source !== undefined || existing.beforeContent !== content || existing.baseRevision !== read.revision) throw new AgentMuxError('The original Note snapshot belongs to another deletion or body.', 'FILE_DELETE_NOTE_OPERATION_CONFLICT')
      this.events.set(eventId, fingerprint); return read.revision
    }
    const previous = (await this.notes.readHistory({ noteId, resource, limit: 1 })).entries[0]
    const { birthtimeNs: _birth, ...fileWitness } = witness
    const saved = await this.notes.recordHistory({ eventId, sequence: 0, batchId: this.input.operationId, noteId, resource, originalResource: resource,
      status: 'prepared', at: Date.now(), actor: this.actor, operation: 'delete', requestFingerprint: fingerprint,
      parentEventId: previous?.status === 'committed' && previous.revision === read.revision ? previous.eventId : null,
      baseRevision: read.revision, beforeContent: content, revision: null, content: null, fileWitness })
    if (saved.operation !== 'delete' || saved.requestFingerprint !== fingerprint || saved.beforeContent !== content || saved.source !== undefined) throw new AgentMuxError('The original Note snapshot was not confirmed.', 'FILE_DELETE_NOTE_HISTORY_UNCONFIRMED')
    this.events.set(eventId, fingerprint)
    return read.revision
  }
  /** Called only after the exact finite Native producer positively acknowledges all unlink effects. */
  async confirmDeleted(): Promise<void> {
    for (const [eventId, fingerprint] of this.events) {
      const event = await this.notes.readHistoryOperation(eventId)
      if (!event || event.operation !== 'delete' || event.requestFingerprint !== fingerprint || event.source !== undefined) throw new AgentMuxError('The original retained Note snapshot cannot be confirmed after Native deletion.', 'FILE_DELETE_NOTE_HISTORY_UNCONFIRMED')
      await this.notes.recordHistory({ ...event, status: 'committed' })
    }
  }
}
