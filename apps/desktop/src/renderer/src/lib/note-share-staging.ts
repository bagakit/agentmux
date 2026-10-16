import type { Editor, JSONContent } from '@tiptap/core'
import { parseFileReadParams, type FileReadParams } from '@agentmux/core/files'
import { validateNoteDocument } from '@agentmux/client-ui/note/note-document-validation'
import { noteHistoryRevision } from '@agentmux/core/note-history'
import { isNoteWorkspaceRelativePath } from '@agentmux/core/note-format'
import { NOTE_SCHEMA, readNoteDocument, serializeNoteDocument, type NoteInclude } from '../../../shared/note-document'
import type { NoteFileTarget } from './file-document-consumers'
const MIME = 'application/x-agentmux-note-share'
export type { NoteShareCopy, PendingNoteShare } from '../../../shared/note-file-editing'
import type { NoteShareCopy, PendingNoteShare } from '../../../shared/note-file-editing'
import { useAppStore } from '../store'
export function noteBlockFingerprint(node: JSONContent): string {
  const strip = (value: JSONContent): JSONContent => ({ ...value, ...(value.attrs ? { attrs: Object.fromEntries(Object.entries(value.attrs).filter(([key]) => key !== 'blockId' && key !== 'provenance')) } : {}), ...(value.content ? { content: value.content.map(strip) } : {}) })
  return noteHistoryRevision(JSON.stringify(strip(node)))
}
function matchingPendingCopy(copy: NoteShareCopy): PendingNoteShare | undefined {
  return Object.values(useAppStore.getState().documents).flatMap(document => Object.values(document.noteEditing?.shares ?? {})).find(value => {
    const other = value.copy
    if (!(['noteId', 'hostId', 'workspaceId', 'workspacePath', 'path'] as const).every(field => other.source[field] === copy.source[field])) return false
    return other.block.blockId && copy.block.blockId ? other.block.blockId === copy.block.blockId : other.block.fingerprint === copy.block.fingerprint && JSON.stringify(other.block.path) === JSON.stringify(copy.block.path)
  })
}
export function copyNoteBlock(editor: Editor, position: number, source: NoteFileTarget, read: FileReadParams): NoteShareCopy {
  let at = editor.state.doc.resolve(position)
  // A list's first paragraph cannot be replaced by an include without its required item container.
  for (let depth = at.depth; depth > 0; depth--) if (at.node(depth).type.name === 'listItem') { position = at.before(depth); at = editor.state.doc.resolve(position); break }
  const node = editor.state.doc.nodeAt(position)
  if (!node || !node.isBlock) throw Error('Choose the current content block again.')
  const path = Array.from({ length: at.depth + 1 }, (_, depth) => at.index(depth))
  const copy: NoteShareCopy = { version: 1, source, read, block: { path, fingerprint: noteBlockFingerprint(node.toJSON()), ...(typeof node.attrs.blockId === 'string' ? { blockId: node.attrs.blockId } : {}) }, ...(node.type.name === 'noteInclude' ? { include: node.attrs as NoteInclude } : {}) }
  if (!copy.include) copy.proposalId = matchingPendingCopy(copy)?.include.noteId ?? crypto.randomUUID()
  return copy
}
export function writeNoteShareClipboard(owner: Document, copy: NoteShareCopy, text: string): void {
  const encoded = JSON.stringify(copy)
  const listener = (event: ClipboardEvent) => {
    event.preventDefault(); event.clipboardData?.setData(MIME, encoded); event.clipboardData?.setData('text/plain', text)
    const span = owner.createElement('span'); span.dataset.noteShare = encoded; span.textContent = text
    event.clipboardData?.setData('text/html', span.outerHTML)
  }
  owner.addEventListener('copy', listener, { once: true })
  try { if (!owner.execCommand('copy')) throw Error('Copy was not confirmed. Select this block and try copying its reference again.') }
  finally { owner.removeEventListener('copy', listener) }
}
export function readNoteShareClipboard(event: ClipboardEvent, owner: Document): NoteShareCopy | null {
  const data = event.clipboardData
  if (!data) return null
  let raw = data.getData(MIME)
  if (!raw) { const holder = owner.createElement('div'); holder.innerHTML = data.getData('text/html'); raw = holder.querySelector<HTMLElement>('[data-note-share]')?.dataset.noteShare ?? '' }
  if (!raw) return null
  try {
    const copy = JSON.parse(raw) as NoteShareCopy
    const identity = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && !/[\0\r\n]/u.test(value)
    if (copy.version !== 1 || !copy.source || !['hostId', 'workspaceId', 'workspacePath', 'path', 'noteId'].every(key => identity(copy.source[key as keyof typeof copy.source])) || !isNoteWorkspaceRelativePath(copy.source.path) || !Array.isArray(copy.block?.path) || !copy.block.path.every(index => Number.isInteger(index) && index >= 0) || typeof copy.block.fingerprint !== 'string' || copy.block.blockId !== undefined && !identity(copy.block.blockId)) return null
    if (copy.include) validateNoteDocument({ schema: NOTE_SCHEMA, noteId: copy.source.noteId, content: { type: 'doc', content: [{ type: 'noteInclude', attrs: copy.include }] } }, true)
    else { if (!identity(copy.proposalId) || !/^sha256:[a-f0-9]{64}$/u.test(copy.block.fingerprint)) return null; parseFileReadParams(copy.read) }
    return copy
  } catch { return null }
}
export function stageNoteShare(key: string, copy: NoteShareCopy): NoteInclude {
  const referenceId = crypto.randomUUID()
  // A clipboard can outlive its first promotion. Only the exact original identity can
  // turn that old locator into a reuse; matching prose or a nearby position cannot.
  const state = useAppStore.getState(), workspace = state.config?.workspaces.find(value => value.id === copy.source.workspaceId)
  const original = workspace?.hostId === copy.source.hostId && workspace.path === copy.source.workspacePath ? state.documents[`${copy.source.workspaceId}\0${copy.source.path}`] : undefined
  const parsed = original ? readNoteDocument(original.content) : null
  const matches: JSONContent[] = []
  if (!copy.include && parsed?.status === 'valid' && parsed.note.noteId === copy.source.noteId) {
    const visit = (node: JSONContent) => { if ((copy.block.blockId ? node.attrs?.blockId === copy.block.blockId : copy.proposalId && node.type === 'noteInclude' && node.attrs?.noteId === copy.proposalId) && !original?.noteEditing?.shares?.[node.attrs?.referenceId]) matches.push(node); node.content?.forEach(visit) }; visit(parsed.note.content)
  }
  const existing = copy.include ?? (matches.length === 1 && matches[0]!.type === 'noteInclude' ? matches[0]!.attrs as NoteInclude : undefined)
  if (existing) {
    const workspaceId = existing.workspaceId ?? copy.source.workspaceId
    return { noteId: existing.noteId, path: existing.path, referenceId, ...(workspaceId === key.slice(0, key.indexOf('\0')) ? {} : { workspaceId }) }
  }
  const held = new Map(pendingNoteShares(key))
  // Repeated pastes of this exact source share one proposed entity, even before its first commit.
  const same = matchingPendingCopy(copy)
  const noteId = same?.include.noteId ?? copy.proposalId ?? crypto.randomUUID(), parent = copy.source.path.slice(0, Math.max(0, copy.source.path.lastIndexOf('/') + 1))
  const include = { referenceId, noteId, path: same?.include.path ?? `${parent}block-${noteId}.note.md`, ...(copy.source.workspaceId === key.slice(0, key.indexOf('\0')) ? {} : { workspaceId: copy.source.workspaceId }) }
  held.set(referenceId, { copy, operationId: same?.operationId ?? crypto.randomUUID(), include })
  useAppStore.setState(state => state.documents[key] ? { documents: { ...state.documents, [key]: { ...state.documents[key]!, noteEditing: { ...state.documents[key]!.noteEditing, shares: Object.fromEntries(held) } } } } : state)
  return include
}
export function pendingNoteShares(key: string): ReadonlyMap<string, PendingNoteShare> { return new Map(Object.entries(useAppStore.getState().documents[key]?.noteEditing?.shares ?? {})) }
export function clearPendingNoteShares(key: string, references: readonly string[]): void {
  useAppStore.setState(state => {
    const document = state.documents[key]
    if (!document?.noteEditing?.shares) return state
    const shares = Object.fromEntries(Object.entries(document.noteEditing.shares).filter(([id]) => !references.includes(id)))
    return { documents: { ...state.documents, [key]: { ...document, noteEditing: { ...document.noteEditing, shares } } } }
  })
}
export function noteNodeAtPath(content: JSONContent, path: readonly number[]): JSONContent | undefined {
  let current: JSONContent | undefined = content
  for (const index of path) current = current?.content?.[index]
  return current
}

/** Live editor capabilities, for the explicit first-use identity transaction before its canonical echo. */
const editors = new Map<string, Set<Editor>>()
export function retainNoteDraftEditor(key: string, editor: Editor): () => void {
  const values = editors.get(key) ?? new Set<Editor>(); values.add(editor); editors.set(key, values)
  return () => { values.delete(editor); if (!values.size && editors.get(key) === values) editors.delete(key) }
}
export function bindNoteDraftBlockIdentity(key: string, path: readonly number[], fingerprint: string, blockId: string): void {
  for (const editor of editors.get(key) ?? []) {
    if (editor.isDestroyed || editor.view.composing) continue
    let current = editor.state.doc, position = -1
    for (const index of path) { if (index >= current.childCount) break; let offset = 0; for (let before = 0; before < index; before++) offset += current.child(before).nodeSize; position += 1 + offset; current = current.child(index) }
    if (noteBlockFingerprint(current.toJSON()) !== fingerprint || current.attrs.blockId) continue
    editor.view.dispatch(editor.state.tr.setNodeMarkup(position, undefined, { ...current.attrs, blockId }).setMeta('addToHistory', false))
  }
}

/** The original share receipt authorizes this structural conversion, never an arbitrary snapshot. */
export function applyNoteDraftShareEcho(key: string, before: string, canonical: string, sourceBlockIds: readonly string[]): void {
  const previous = readNoteDocument(before), next = readNoteDocument(canonical)
  if (previous.status !== 'valid' || next.status !== 'valid' || previous.note.noteId !== next.note.noteId) return
  const includes = new Set<string>(), visit = (node: JSONContent) => { if (node.type === 'noteInclude' && typeof node.attrs?.blockId === 'string') includes.add(node.attrs.blockId); node.content?.forEach(visit) }; visit(next.note.content)
  if (!sourceBlockIds.length || !sourceBlockIds.every(id => includes.has(id))) return
  const normalized = serializeNoteDocument(previous.note)
  const comparable = (node: JSONContent): string => JSON.stringify(node, (name, value) => name === 'provenance' ? undefined : value)
  for (const editor of editors.get(key) ?? []) {
    if (editor.isDestroyed || editor.view.composing || serializeNoteDocument({ ...previous.note, content: editor.getJSON() }) !== normalized) continue
    const target = editor.schema.nodeFromJSON(next.note.content), current = editor.state.doc
    let prefix = 0, suffix = 0, from = 0, end = current.content.size
    while (prefix < current.childCount && prefix < target.childCount && comparable(current.child(prefix).toJSON()) === comparable(target.child(prefix).toJSON())) { from += current.child(prefix++).nodeSize }
    while (suffix < current.childCount - prefix && suffix < target.childCount - prefix && comparable(current.child(current.childCount - suffix - 1).toJSON()) === comparable(target.child(target.childCount - suffix - 1).toJSON())) { end -= current.child(current.childCount - ++suffix).nodeSize }
    let targetFrom = 0, targetEnd = target.content.size
    for (let index = 0; index < prefix; index++) targetFrom += target.child(index).nodeSize
    for (let index = 0; index < suffix; index++) targetEnd -= target.child(target.childCount - index - 1).nodeSize
    editor.view.dispatch(editor.state.tr.replaceWith(from, end, target.content.cut(targetFrom, targetEnd)).setMeta('noteRemoteSnapshot', true).setMeta('preventUpdate', true).setMeta('addToHistory', false))
  }
}

type DraftNavigation = { editor: Editor; focusBlock(blockId: string, focus?: boolean, reveal?: boolean): boolean }
const navigation = new Map<string, { key: string; handle: DraftNavigation }>()
export function retainNoteDraftNavigation(occurrence: string, key: string, handle: DraftNavigation): () => void {
  const held = { key, handle }; navigation.set(occurrence, held)
  for (const [parent, listeners] of navigationReady) if (occurrence.startsWith(parent + '/')) listeners.forEach(listener => listener())
  return () => { if (navigation.get(occurrence) === held) navigation.delete(occurrence) }
}
export function focusIncludedNoteDraft(occurrence: string, key: string, blockId: string, focus: boolean, reveal: boolean): boolean {
  const held = navigation.get(occurrence)
  return Boolean(held?.key === key && !held.handle.editor.isDestroyed && held.handle.focusBlock(blockId, focus, reveal))
}

const navigationReady = new Map<string, Set<() => void>>()
export function observeNoteDraftNavigation(occurrence: string, listener: () => void): () => void {
  const values = navigationReady.get(occurrence) ?? new Set<() => void>(); values.add(listener); navigationReady.set(occurrence, values)
  return () => { values.delete(listener); if (!values.size && navigationReady.get(occurrence) === values) navigationReady.delete(occurrence) }
}
