import { createHash, randomUUID } from 'node:crypto'
import { mkdir, open, lstat, readFile, readdir, realpath, unlink } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import type { JSONContent } from '@tiptap/core'
import type { NoteResource } from '@agentmux/core/notebook-catalog'
import { parseNoteProvenanceWrite, type NoteProvenanceWrite } from '@agentmux/core/note-provenance'
import { noteContentSchema } from '@agentmux/client-ui/note/note-content-schema'
import { readLegacyNoteDocument } from '@agentmux/client-ui/note/note-legacy-document'
import { readNoteDocument, serializeNoteDocument, type NoteDocument } from '@agentmux/client-ui/note/note-document'
import { readNoteBlockProvenance } from '@agentmux/client-ui/note/note-provenance'
import type { AgentMuxNotesStorage, NotesStorageConversion, NotesStorageOperation, NotesConversionIssue } from '@agentmux/core/notebook-store'

export type PreparedLegacyNoteMarkdown = {
  noteId: string
  source: NoteResource
  destination: NoteResource
  sourceHash: string
  targetHash: string
  targetBytes: Uint8Array
  provenance: NoteProvenanceWrite
}
const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
const fail = (message: string): never => {
  throw Object.assign(new Error(message + ' The original Note bytes and identities are retained; retry this conversion after resolving the exact source.'), { code: 'NOTE_CONVERSION_UNCONFIRMED' })
}

/** Compare the installed schema's semantic defaults; authors are imported separately. */
function semanticContent(note: NoteDocument): string {
  const content = noteContentSchema.nodeFromJSON(note.content).toJSON()
  const visit = (node: JSONContent) => { if (node.attrs) delete node.attrs.provenance; node.content?.forEach(visit) }
  visit(content)
  return JSON.stringify(content)
}

/** Pure conversion input for the original NotesStorage journal; never reads or writes a file. */
export function prepareLegacyNoteMarkdown(source: NoteResource, bytes: Uint8Array, expectedNoteId?: string): PreparedLegacyNoteMarkdown {
  if (source.hostId !== 'local' || !isAbsolute(source.workspacePath) || isAbsolute(source.path) ||
    source.path.split(/[\\/]/u).includes('..') || /[\0\r\n]/u.test(source.path) || !source.path.endsWith('.note.json')) {
    return fail('This conversion requires the exact local legacy Note resource.')
  }
  let raw: string
  try { raw = new TextDecoder('utf-8', { fatal: true }).decode(bytes) }
  catch { return fail('The original legacy Note is not complete UTF-8 text.') }
  const legacy = readLegacyNoteDocument(raw)
  if (legacy.status !== 'valid') return fail(legacy.message)
  if (expectedNoteId !== undefined && legacy.note.noteId !== expectedNoteId) return fail('The original Note identity does not match its registered resource.')

  const targetBytes = Buffer.from(serializeNoteDocument(legacy.note), 'utf8')
  const read = readNoteDocument(targetBytes.toString('utf8'))
  if (read.status !== 'valid' || read.unanchoredBlockCount !== 0 || read.note.noteId !== legacy.note.noteId ||
    semanticContent(read.note) !== semanticContent(legacy.note)) return fail('The Markdown conversion did not preserve the complete original Note content and identities.')

  const destination = { ...source, path: source.path.slice(0, -'.note.json'.length) + '.note.md' }
  const blocks: NoteProvenanceWrite['blocks'] = Object.create(null)
  const collect = (node: JSONContent) => {
    if (typeof node.attrs?.blockId === 'string') blocks[node.attrs.blockId] = readNoteBlockProvenance(node.attrs.provenance) ?? { created: null, lastEdited: null }
    node.content?.forEach(collect)
  }
  collect(legacy.note.content)
  const targetHash = digest(targetBytes)
  const provenance = parseNoteProvenanceWrite({ noteId: legacy.note.noteId, resource: destination, revision: 'sha256:' + targetHash, blocks })
  return { noteId: legacy.note.noteId, source: { ...source }, destination, sourceHash: digest(bytes), targetHash, targetBytes, provenance }
}

type ConversionSnapshot = Parameters<Parameters<AgentMuxNotesStorage['convert']>[1]>[0]
type LocalWorkspace = { id: string; hostId: string; path: string }
const within = (root: string, file: string) => { const path = relative(root, file); return path !== '' && !path.startsWith('..') && !isAbsolute(path) }
async function stageMarkdown(converted: PreparedLegacyNoteMarkdown, stagingDirectory: string): Promise<string> {
  const destination = resolve(converted.destination.workspacePath, converted.destination.path)
  try { if (!(await lstat(destination)).isFile() || digest(await readFile(destination)) !== converted.targetHash) return fail('The Markdown destination already contains different bytes.') }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  await mkdir(stagingDirectory, { recursive: true, mode: 0o700 })
  const preparedSource = join(stagingDirectory, randomUUID() + '.note.md')
  const handle = await open(preparedSource, 'wx', 0o600)
  try { await handle.writeFile(converted.targetBytes); await handle.sync() } finally { await handle.close() }
  const stageDirectory = await open(dirname(preparedSource), 'r')
  try { await stageDirectory.sync() } finally { await stageDirectory.close() }
  return preparedSource
}

/** Called under the original location/catalog lock. Only stages bytes; the journal owns publication and backup. */
export async function prepareLegacyNotesConversion(snapshot: ConversionSnapshot, options: { directory: string; stagingDirectory: string; workspaces: readonly LocalWorkspace[] }): Promise<NotesStorageConversion & { issues: NotesConversionIssue[] }> {
  const issues: NotesConversionIssue[] = []
  const sources = new Map<string, { resource: NoteResource; expectedNoteId?: string }>()
  const ambiguousPaths = new Set<string>()
  for (const page of Object.values(snapshot.state.pages)) {
    if (!page.resource.path.endsWith('.note.json')) continue
    if (page.resource.hostId !== 'local') { issues.push({ noteId: page.noteId, resource: page.resource, code: 'NOTE_CONVERSION_REMOTE', message: 'The original remote host has not converted this Note. Its resource and identities are retained; inspect or retry at that host.' }); continue }
    const path = resolve(page.resource.workspacePath, page.resource.path), previous = sources.get(path)
    if (ambiguousPaths.has(path) || previous && previous.expectedNoteId !== page.noteId) {
      if (previous) issues.push({ noteId: previous.expectedNoteId ?? null, resource: previous.resource, code: 'NOTE_CONVERSION_RESOURCE_AMBIGUOUS', message: 'More than one Note identity claims this original file. Its bytes are retained; confirm the exact identity before conversion.' })
      issues.push({ noteId: page.noteId, resource: page.resource, code: 'NOTE_CONVERSION_RESOURCE_AMBIGUOUS', message: 'More than one Note identity claims this original file. Its bytes are retained; confirm the exact identity before conversion.' })
      ambiguousPaths.add(path); sources.delete(path); continue
    }
    sources.set(path, { resource: page.resource, expectedNoteId: page.noteId })
  }
  const collect = async (directory: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true }).catch(error => {
      if (error.code !== 'ENOENT' || directory !== options.directory) issues.push({ noteId: null, resource: { hostId: 'local', workspaceId: '__notes__', workspacePath: options.directory, path: relative(options.directory, directory) || '.' }, code: 'NOTE_CONVERSION_LIST_UNCONFIRMED', message: 'The original legacy directory listing is unavailable: ' + String(error) + '. Existing resources are retained; retry this listing.' })
      return []
    })
    for (const entry of entries) {
      const path = join(directory, entry.name)
      if (entry.name === '.agentmux-note-backups') continue
      if (entry.isDirectory()) { await collect(path); continue }
      if (!entry.name.endsWith('.note.json') || sources.has(path) || ambiguousPaths.has(path)) continue
      const candidates = options.workspaces.filter(workspace => workspace.hostId === 'local' && within(workspace.path, path)).sort((a, b) => b.path.length - a.path.length)
      const owner = candidates[0]
      if (owner && candidates[1]?.path === owner.path && candidates[1]?.id !== owner.id) { issues.push({ noteId: null, resource: { hostId: 'local', workspaceId: owner.id, workspacePath: owner.path, path: relative(owner.path, path) }, code: 'NOTE_CONVERSION_RESOURCE_AMBIGUOUS', message: 'The original legacy Note Workspace is ambiguous. Its bytes are retained; confirm the exact resource before retrying.' }); continue }
      const workspacePath = owner?.path ?? options.directory
      sources.set(path, { resource: { hostId: 'local', workspaceId: owner?.id ?? '__notes__', workspacePath, path: relative(workspacePath, path) } })
    }
  }
  await collect(options.directory)
  const prepared: NotesStorageConversion & { issues: NotesConversionIssue[] } = { files: [], resourceChanges: [], provenance: [], issues }
  const identities = new Map<string, { resource: NoteResource; path: string }>()
  for (const [path, source] of sources) {
    let observedNoteId = source.expectedNoteId ?? null
    try {
    if (!(await lstat(path)).isFile() || !within(await realpath(source.resource.workspacePath), await realpath(path))) return fail('The original legacy Note escaped its exact Workspace.')
    const converted = prepareLegacyNoteMarkdown(source.resource, await readFile(path), source.expectedNoteId)
    observedNoteId = converted.noteId
    const registered = snapshot.state.pages[converted.noteId]
    const duplicate = identities.get(converted.noteId)
    if (duplicate) {
      for (const old of prepared.files.filter(file => file.source === duplicate.path)) if (old.preparedSource) await unlink(old.preparedSource)
      prepared.files = prepared.files.filter(file => file.source !== duplicate.path)
      prepared.resourceChanges = prepared.resourceChanges.filter(change => change.noteId !== converted.noteId)
      prepared.provenance = prepared.provenance.filter(row => row.noteId !== converted.noteId)
      issues.push({ noteId: converted.noteId, resource: duplicate.resource, code: 'NOTE_CONVERSION_IDENTITY_AMBIGUOUS', message: 'This Note identity has another original file. Both copies are retained; confirm the exact source before conversion.' })
      return fail('A legacy Note identity belongs to more than one original resource.')
    }
    if (registered && (registered.resource.hostId !== source.resource.hostId || registered.resource.workspaceId !== source.resource.workspaceId || registered.resource.workspacePath !== source.resource.workspacePath || registered.resource.path !== source.resource.path)) return fail('A legacy Note identity belongs to another original resource.')
    identities.set(converted.noteId, { resource: source.resource, path })
    const destination = resolve(converted.destination.workspacePath, converted.destination.path)
    const preparedSource = await stageMarkdown(converted, options.stagingDirectory)
    prepared.files.push({ source: path, destination, hash: converted.sourceHash, targetHash: converted.targetHash, preparedSource,
      backup: join(converted.source.workspacePath, '.agentmux-note-backups', converted.source.path + '.' + converted.sourceHash + '.bak') })
    prepared.resourceChanges.push({ noteId: converted.noteId, from: converted.source, to: converted.destination,
      conversion: { sourceRevision: 'sha256:' + converted.sourceHash, targetRevision: 'sha256:' + converted.targetHash } })
    prepared.provenance.push(converted.provenance)
    } catch (error) { issues.push({ noteId: observedNoteId, resource: source.resource, code: typeof (error as NodeJS.ErrnoException).code === 'string' ? (error as NodeJS.ErrnoException).code! : 'NOTE_CONVERSION_UNCONFIRMED', message: String(error) + ' This original resource is retained; other local Notes remain available.' }) }
  }
  return prepared
}

/** Recover only the old journal's verified copies, retaining its original move identity and destination. */
export async function prepareLegacyPendingConversion(operation: NotesStorageOperation, stagingDirectory: string): Promise<NotesStorageConversion> {
  const prepared: NotesStorageConversion = { files: [], resourceChanges: [], provenance: [] }
  const identities = new Set<string>()
  for (const file of operation.files) {
    const move = operation.resourceChanges.find(change => resolve(change.from.workspacePath, change.from.path) === file.source && resolve(change.to.workspacePath, change.to.path) === file.destination)
    if (!move || !move.to.path.endsWith('.note.json') || identities.has(move.noteId)) return fail('The original pending Note resource is ambiguous.')
    identities.add(move.noteId)
    let staged: PreparedLegacyNoteMarkdown | undefined, preparedSource: string | undefined
    for (const [path, resource] of [[file.source, move.from], [file.destination, move.to]] as const) {
      if (path === file.source && path === file.destination && staged) continue
      const raw = await readFile(path).catch(error => { if (error.code === 'ENOENT' && (operation.phase === 'committed' && path === file.source || operation.phase === 'prepared' && path === file.destination)) return null; throw error })
      if (!raw) continue
      if (!(await lstat(path)).isFile() || !within(await realpath(resource.workspacePath), await realpath(path)) || digest(raw) !== file.hash) return fail('An original pending JSON copy changed or escaped its Workspace.')
      const converted = prepareLegacyNoteMarkdown(resource, raw, move.noteId)
      converted.destination = { ...move.to, path: move.to.path.slice(0, -'.note.json'.length) + '.note.md' }
      converted.provenance.resource = converted.destination
      if (staged && staged.targetHash !== converted.targetHash) return fail('The old pending copies no longer describe the same Note.')
      if (!staged) { staged = converted; preparedSource = await stageMarkdown(converted, stagingDirectory); prepared.provenance.push(converted.provenance) }
      prepared.files.push({ source: path, destination: resolve(converted.destination.workspacePath, converted.destination.path), hash: converted.sourceHash, targetHash: converted.targetHash, preparedSource: preparedSource!,
        backup: join(resource.workspacePath, '.agentmux-note-backups', resource.path + '.' + converted.sourceHash + '.bak') })
      prepared.resourceChanges.push({ noteId: move.noteId, from: resource, to: converted.destination,
        conversion: { sourceRevision: 'sha256:' + converted.sourceHash, targetRevision: 'sha256:' + converted.targetHash } })
    }
    if (!staged) return fail('No exact original pending Note copy is available.')
  }
  return prepared
}
