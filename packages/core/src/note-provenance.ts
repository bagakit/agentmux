import { AgentMuxError } from './errors.js'
import type { NoteResource, NotebookActor } from './notebook-catalog.js'

export type NoteAuthorship = { actor: NotebookActor; at: number }
export type NoteBlockProvenance = { created: NoteAuthorship | null; lastEdited: NoteAuthorship | null }
export type NoteProvenanceQuery = { noteId: string; resource: NoteResource; revision: string; blockIds: readonly string[] }
/** Trusted metadata for this exact saved body, never content submitted by a file caller. */
export type NoteProvenanceSnapshot = { noteId: string; resource: NoteResource; revision: string; blocks: Record<string, NoteBlockProvenance> } & (
  | { status: 'recorded'; reason?: never }
  | { status: 'unconfirmed'; reason: string })
export type NoteProvenanceWrite = Omit<NoteProvenanceSnapshot, 'status' | 'reason'>

const fail = (message: string): never => { throw new AgentMuxError(message, 'NOTEBOOK_INPUT_INVALID') }
const object = (value: unknown, fields: string[]): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !fields.includes(key))) fail('Unexpected Note provenance data.')
  return value as Record<string, unknown>
}
const text = (value: unknown): string => typeof value === 'string' && value.length > 0 && !/[\0\r\n]/u.test(value) ? value : fail('An exact Note provenance identity is required.')
export function noteProvenanceResourceKey(resource: NoteResource): string {
  const r = object(resource, ['hostId', 'workspaceId', 'workspacePath', 'path'])
  for (const key of ['hostId', 'workspaceId', 'workspacePath', 'path']) text(r[key])
  if (resource.path.startsWith('/') || resource.path.split(/[\\/]/u).includes('..')) fail('Note provenance requires an original relative path.')
  return JSON.stringify([resource.hostId, resource.workspaceId, resource.workspacePath, resource.path])
}
export function parseNoteProvenanceWrite(value: unknown): NoteProvenanceWrite {
  const p = object(value, ['noteId', 'resource', 'revision', 'blocks'])
  text(p.noteId); noteProvenanceResourceKey(p.resource as NoteResource)
  if (typeof p.revision !== 'string' || !/^sha256:[a-f0-9]{64}$/u.test(p.revision)) fail('Note provenance requires the complete saved body revision.')
  if (!p.blocks || typeof p.blocks !== 'object' || Array.isArray(p.blocks)) fail('Note provenance blocks are required.')
  const author = (value: unknown) => {
    if (value === null) return
    const a = object(value, ['actor', 'at']), actor = object(a.actor, ['kind', 'id'])
    if (!['user', 'agent', 'device'].includes(String(actor.kind)) || !Number.isSafeInteger(a.at) || Number(a.at) < 0) fail('The original block author is invalid.')
    text(actor.id)
  }
  for (const [id, value] of Object.entries(p.blocks as Record<string, unknown>)) {
    text(id); const block = object(value, ['created', 'lastEdited']); author(block.created); author(block.lastEdited)
  }
  return structuredClone(value as NoteProvenanceWrite)
}
export function parseNoteProvenanceSnapshot(value: unknown): NoteProvenanceSnapshot {
  const p = object(value, ['noteId', 'resource', 'revision', 'blocks', 'status', 'reason'])
  const { status, reason, ...original } = p
  const write = parseNoteProvenanceWrite(original)
  if (status === 'recorded' && reason === undefined) return { ...write, status }
  if (status === 'unconfirmed') return { ...write, status, reason: text(reason) }
  return fail('The Note provenance confirmation is invalid.')
}
