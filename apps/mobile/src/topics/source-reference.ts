import { parseFileReadParams, parseFileReadResult, type FileReadParams, type FileReadResource } from '@agentmux/core/files'
import type { TopicKnowledgeSource } from '@agentmux/core/control'
import type { NoteResource, NotebookWorkface } from '@agentmux/core/notebook-catalog'

/** References only. Bodies, listings, revisions and Note drafts remain with their original owners. */
export type MobileTopicFileReference = {
  target: Pick<FileReadParams, 'zoneId' | 'path' | 'expectedResource'>
  resource: FileReadResource
}
export type MobileTopicNoteMapping = { noteId: string; blockId?: string; resource: NoteResource; workface?: NotebookWorkface }
export type MobileTopicSourceContentReference =
  | { kind: 'file'; trail: MobileTopicFileReference[] }
  | { kind: 'note'; mapping: MobileTopicNoteMapping | null; trail: MobileTopicFileReference[] }
  | { kind: 'notebook'; selectedNote: (MobileTopicNoteMapping & { trail: MobileTopicFileReference[] }) | null }

function invalid(): never { throw new Error('原来源内层引用无法完整核实；原记录、阅读与草稿保留。') }
function object(value: unknown, required: string[], optional: string[] = []): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid()
  const v = value as Record<string, unknown>
  if (required.some(key => !Object.hasOwn(v, key)) || Object.keys(v).some(key => !required.includes(key) && !optional.includes(key))) invalid()
  return v
}
function text(value: unknown): value is string { return typeof value === 'string' && value.length > 0 && !/[\0\r\n]/u.test(value) }
function trail(value: unknown): void {
  if (!Array.isArray(value)) invalid()
  let original: FileReadResource | undefined
  for (const entry of value) {
    const v = object(entry, ['target', 'resource'])
    object(v.target, ['zoneId', 'path', 'expectedResource'])
    object(v.resource, ['hostId', 'workspaceId', 'workspacePath', 'zoneId', 'zonePath', 'path'], ['logicalDirectory'])
    // The public Files codec owns confinement and logical/physical resource mapping.
    const target = parseFileReadParams(v.target)
    parseFileReadResult({ resource: v.resource, result: { status: 'directory' } }, target)
    const resource = v.resource as FileReadResource
    if (original && (['hostId', 'workspaceId', 'workspacePath', 'zoneId', 'zonePath', 'logicalDirectory'] as const).some(key => original![key] !== resource[key])) invalid()
    original ??= resource
  }
}
function mapping(value: unknown, withTrail = false): void {
  const v = object(value, ['noteId', 'resource', ...(withTrail ? ['trail'] : [])], ['blockId', 'workface'])
  if (!text(v.noteId) || v.blockId !== undefined && !text(v.blockId)) invalid()
  const r = object(v.resource, ['hostId', 'workspaceId', 'workspacePath', 'path'])
  for (const key of ['hostId', 'workspaceId', 'workspacePath', 'path']) if (!text(r[key])) invalid()
  // A Note catalog path is Workspace-relative. Reuse the public path validator.
  parseFileReadParams({ zoneId: 'reference', path: r.path, expectedResource: {
    hostId: r.hostId, workspaceId: r.workspaceId, workspacePath: r.workspacePath } })
  if (v.workface !== undefined) {
    const w = object(v.workface, ['zoneId', 'workspaceId'])
    if (!text(w.zoneId) || w.workspaceId !== r.workspaceId) invalid()
  }
  if (withTrail) { trail(v.trail); noteTrail(v as unknown as MobileTopicNoteMapping, v.trail as MobileTopicFileReference[]) }
}
function noteTrail(mapping: MobileTopicNoteMapping, trail: MobileTopicFileReference[]): void {
  // NoteReader owns Note references; this Source layer never descends into another File.
  if (trail.length > 1) invalid()
  const first = trail[0]
  if (first && ((['hostId', 'workspaceId', 'workspacePath', 'path'] as const).some(key => first.resource[key] !== mapping.resource[key])
    || mapping.workface && (first.target.zoneId !== mapping.workface.zoneId || first.resource.workspaceId !== mapping.workface.workspaceId))) invalid()
}
export function parseMobileTopicSourceContentReference(value: unknown, source: TopicKnowledgeSource): MobileTopicSourceContentReference {
  if (source.kind !== 'file' && source.kind !== 'note' && source.kind !== 'notebook') invalid()
  const v = object(value, source.kind === 'file' ? ['kind', 'trail'] : source.kind === 'note' ? ['kind', 'mapping', 'trail'] : ['kind', 'selectedNote'])
  if (v.kind !== source.kind) invalid()
  if (source.kind === 'notebook') {
    if (v.selectedNote !== null) mapping(v.selectedNote, true)
  } else {
    trail(v.trail)
    if (source.kind === 'file' && (v.trail as MobileTopicFileReference[]).some(pin => pin.resource.hostId !== source.hostId)) invalid()
    if (source.kind === 'note' && v.mapping !== null) {
      mapping(v.mapping)
      const m = v.mapping as MobileTopicNoteMapping
      if (m.noteId !== source.noteId || m.blockId !== source.blockId) invalid()
      noteTrail(m, v.trail as MobileTopicFileReference[])
    }
    if (source.kind === 'note' && v.mapping === null && (v.trail as MobileTopicFileReference[]).length) invalid()
  }
  return structuredClone(value) as MobileTopicSourceContentReference
}
export function sameTopicFileResource(a: FileReadResource, b: FileReadResource): boolean {
  return (['hostId', 'workspaceId', 'workspacePath', 'zoneId', 'zonePath', 'path', 'logicalDirectory'] as const).every(key => a[key] === b[key])
}
export function sameTopicNoteMapping(a: MobileTopicNoteMapping, b: MobileTopicNoteMapping): boolean {
  return a.noteId === b.noteId && a.blockId === b.blockId
    && (['hostId', 'workspaceId', 'workspacePath', 'path'] as const).every(key => a.resource[key] === b.resource[key])
    && a.workface?.zoneId === b.workface?.zoneId && a.workface?.workspaceId === b.workface?.workspaceId
}
