import { mintObjectId } from '@agentmux/core/object-id'
import { Decoration, type Editor, type JSONContent } from '@tiptap/core'
import { noteShareSiblingRange, noteBlockFingerprint, noteNodeAtPath } from '@agentmux/client-ui/note/note-share-range'
export { noteBlockFingerprint, noteNodeAtPath } from '@agentmux/client-ui/note/note-share-range'
import { parseFileReadParams, type FileReadParams } from '@agentmux/core/files'
import { validateNoteDocument } from '@agentmux/client-ui/note/note-document-validation'
import { noteHistoryRevision } from '@agentmux/core/note-history'
import { isNoteWorkspaceRelativePath } from '@agentmux/core/note-format'
import { NOTE_SCHEMA, readNoteDocument, serializeNoteDocument, type NoteDocument, type NoteInclude } from '../../../shared/note-document'
import type { NoteFileTarget } from './file-document-consumers'
type ProseMirrorNode = Editor['state']['doc']
const MIME = 'application/x-agentmux-note-share'
export type { NoteShareCopy, PendingNoteShare } from '../../../shared/note-file-editing'
import type { NoteShareCopy, PendingNoteShare } from '../../../shared/note-file-editing'
import { useAppStore } from '../store'
function matchingPendingCopy(copy: NoteShareCopy): PendingNoteShare | undefined {
  return Object.values(useAppStore.getState().documents).flatMap(document => Object.values(document.noteEditing?.shares ?? {})).find(value => {
    const other = value.copy
    if (!(['noteId', 'hostId', 'workspaceId', 'workspacePath', 'path'] as const).every(field => other.source[field] === copy.source[field])) return false
    return other.block.blockId && copy.block.blockId ? other.block.blockId === copy.block.blockId : other.block.fingerprint === copy.block.fingerprint && JSON.stringify(other.block.path) === JSON.stringify(copy.block.path)
  })
}
export function copyNoteBlock(editor: Editor, position: number, source: NoteFileTarget, read: FileReadParams): NoteShareCopy {
  let at = editor.state.doc.resolve(position)
  // A cell owns one paragraph flow; share the whole table rather than replacing
  // that flow with an invalid include. List items similarly own their first paragraph.
  const table = Array.from({ length: at.depth }, (_, index) => at.depth - index).find(depth => at.node(depth).type.name === 'table')
  if (table !== undefined) { position = at.before(table); at = editor.state.doc.resolve(position) }
  else for (let depth = at.depth; depth > 0; depth--) if (['listItem', 'taskItem'].includes(at.node(depth).type.name)) { position = at.before(depth); at = editor.state.doc.resolve(position); break }
  const node = editor.state.doc.nodeAt(position)
  if (!node || !node.isBlock) throw Error('Choose the current content block again.')
  const path = Array.from({ length: at.depth + 1 }, (_, depth) => at.index(depth))
  const pending = node.type.name === 'noteInclude' ? pendingNoteShares(`${source.workspaceId}\0${source.path}`).get(node.attrs.referenceId) : undefined
  if (pending && node.attrs.noteId === pending.include.noteId && node.attrs.path === pending.include.path && (node.attrs.workspaceId ?? source.workspaceId) === (pending.include.workspaceId ?? source.workspaceId)) return pending.copy
  const copy: NoteShareCopy = { version: 1, source, read, block: { path, fingerprint: noteBlockFingerprint(node.toJSON()), ...(typeof node.attrs.blockId === 'string' ? { blockId: node.attrs.blockId } : {}) }, ...(node.type.name === 'noteInclude' ? { include: node.attrs as NoteInclude } : {}) }
  if (!copy.include) copy.proposalId = matchingPendingCopy(copy)?.include.noteId ?? mintObjectId()
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
  const referenceId = mintObjectId()
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
  const noteId = same?.include.noteId ?? copy.proposalId ?? mintObjectId(), parent = copy.source.path.slice(0, Math.max(0, copy.source.path.lastIndexOf('/') + 1))
  const include = { referenceId, noteId, path: same?.include.path ?? `${parent}block-${noteId}.note.md`, ...(copy.source.workspaceId === key.slice(0, key.indexOf('\0')) ? {} : { workspaceId: copy.source.workspaceId }) }
  held.set(referenceId, { copy, operationId: same?.operationId ?? mintObjectId(), include })
  useAppStore.setState(state => state.documents[key] ? { documents: { ...state.documents, [key]: { ...state.documents[key]!, noteEditing: { ...state.documents[key]!.noteEditing, shares: Object.fromEntries(held) } } } } : state)
  rememberPendingSourceTarget(key)
  return include
}
/** A source receipt may promote a proposal while another use has no mounted preview. */
export function promotedPendingNoteShares(key: string): string[] {
  const state = useAppStore.getState(), settled: string[] = []
  for (const [reference, ticket] of pendingNoteShares(key)) {
    const source = ticket.copy.source, workspace = state.config?.workspaces.find(value => value.id === source.workspaceId)
    if (workspace?.hostId !== source.hostId || workspace.path !== source.workspacePath) continue
    const original = state.documents[`${source.workspaceId}\0${source.path}`], parsed = original ? readNoteDocument(original.content) : null
    if (parsed?.status !== 'valid' || parsed.note.noteId !== source.noteId) continue
    let declarations = 0
    const visit = (node: JSONContent) => {
      if (node.type === 'noteInclude' && node.attrs?.noteId === ticket.include.noteId && node.attrs?.referenceId === `${ticket.operationId}:source` && node.attrs.path === ticket.include.path && !original?.noteEditing?.shares?.[node.attrs.referenceId] && (!ticket.copy.block.blockId || node.attrs.blockId === ticket.copy.block.blockId)) declarations++
      node.content?.forEach(visit)
    }
    visit(parsed.note.content)
    if (declarations === 1) settled.push(reference)
  }
  return settled
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

/** Live editor capabilities, for the explicit first-use identity transaction before its canonical echo. */
const editors = new Map<string, Set<Editor>>()
export function retainNoteDraftEditor(key: string, editor: Editor): () => void {
  const values = editors.get(key) ?? new Set<Editor>(); values.add(editor); editors.set(key, values)
  if (pendingSourceTargets.has(key) || Object.keys(useAppStore.getState().documents[key]?.noteEditing?.shares ?? {}).length) rememberPendingSourceTarget(key)
  return () => { values.delete(editor); if (!values.size && editors.get(key) === values) editors.delete(key); const current = pendingSourceTargets.get(key); current?.editors.get(editor)?.(); current?.editors.delete(editor); if (current) rememberPendingSourceTarget(key) }
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
  applyExactNoteDraftEcho(key, previous.note, next.note)
}
/** Only an original inverse-file receipt authorizes include-to-original structure, never a text resemblance. */
export function applyNoteDraftRestoreEcho(key: string, before: string, canonical: string, sharedNoteId: string): void {
  const previous = readNoteDocument(before), next = readNoteDocument(canonical)
  if (previous.status !== 'valid' || next.status !== 'valid' || previous.note.noteId !== next.note.noteId) return
  const roots = new Set<string>(), restored = new Set<string>()
  const visit = (node: JSONContent) => { if (node.type === 'noteInclude' && node.attrs?.noteId === sharedNoteId && typeof node.attrs.blockId === 'string') roots.add(node.attrs.blockId); node.content?.forEach(visit) }; visit(previous.note.content)
  const found = (node: JSONContent) => { if (node.type !== 'noteInclude' && typeof node.attrs?.blockId === 'string' && roots.has(node.attrs.blockId)) restored.add(node.attrs.blockId); node.content?.forEach(found) }; found(next.note.content)
  if (!restored.size) return
  applyExactNoteDraftEcho(key, previous.note, next.note)
}
function applyExactNoteDraftEcho(key: string, previous: NoteDocument, next: NoteDocument): void {
  const normalized = serializeNoteDocument(previous)
  const equivalent = (left: JSONContent, right: JSONContent): boolean => {
    const attrs = (node: JSONContent) => Object.fromEntries(Object.entries(node.attrs ?? {}).filter(([name]) => name !== 'provenance' && (name !== 'blockId' || left.attrs?.blockId && right.attrs?.blockId)))
    return left.type === right.type && left.text === right.text && JSON.stringify(left.marks) === JSON.stringify(right.marks) && JSON.stringify(attrs(left)) === JSON.stringify(attrs(right)) && (left.content?.length ?? 0) === (right.content?.length ?? 0) && (left.content ?? []).every((node, index) => equivalent(node, right.content![index]!))
  }
  for (const editor of editors.get(key) ?? []) {
    if (editor.isDestroyed || editor.view.composing || serializeNoteDocument({ ...previous, content: editor.getJSON() }) !== normalized) continue
    const target = editor.schema.nodeFromJSON(next.content), current = editor.state.doc
    let prefix = 0, suffix = 0, from = 0, end = current.content.size
    while (prefix < current.childCount && prefix < target.childCount && equivalent(current.child(prefix).toJSON(), target.child(prefix).toJSON())) { from += current.child(prefix++).nodeSize }
    while (suffix < current.childCount - prefix && suffix < target.childCount - prefix && equivalent(current.child(current.childCount - suffix - 1).toJSON(), target.child(target.childCount - suffix - 1).toJSON())) { end -= current.child(current.childCount - ++suffix).nodeSize }
    let targetFrom = 0, targetEnd = target.content.size
    for (let index = 0; index < prefix; index++) targetFrom += target.child(index).nodeSize
    for (let index = 0; index < suffix; index++) targetEnd -= target.child(target.childCount - index - 1).nodeSize
    editor.view.dispatch(editor.state.tr.replaceWith(from, end, target.content.cut(targetFrom, targetEnd)).setMeta('noteRemoteSnapshot', true).setMeta('noteSharedReceiptEcho', true).setMeta('preventUpdate', true).setMeta('addToHistory', false))
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


/** Pending source boundaries are a projection of the original tickets, never another draft. */
type PendingSourceTarget = {
  shares: Readonly<Record<string, PendingNoteShare>>
  present: ReadonlySet<string>
  editors: Map<Editor, () => void>
}
const pendingSourceTargets = new Map<string, PendingSourceTarget>()
const pendingSourceObservers = new Map<string, Set<() => void>>()
const pendingSourceCopies = new Map<string, NoteShareCopy[]>()
let stopPendingSourceObservation: (() => void) | undefined
function pendingSourceKey(copy: NoteShareCopy): string { return `${copy.source.workspaceId}\0${copy.source.path}\0${copy.source.noteId}` }
function pendingSourceKeys(target: PendingSourceTarget): Set<string> {
  return new Set(Object.entries(target.shares).flatMap(([reference, ticket]) => target.present.has(reference) ? [pendingSourceKey(ticket.copy)] : []))
}
function presentPendingReferences(key: string, shares: Readonly<Record<string, PendingNoteShare>>): Set<string> {
  const declarations = new Map<string, string[]>()
  const add = (reference: unknown, noteId: unknown) => { if (typeof reference === 'string' && typeof noteId === 'string') declarations.set(reference, [...(declarations.get(reference) ?? []), noteId]) }
  const live = [...(editors.get(key) ?? [])].filter(editor => !editor.isDestroyed)
  // The live editor owns a local Undo before its serialized File echo arrives.
  // Multiple projections of one draft count an identical declaration only once.
  if (live.length) for (const editor of live) {
    const current = new Map<string, string[]>()
    editor.state.doc.descendants(node => { if (node.type.name === 'noteInclude') { const reference = node.attrs.referenceId; if (typeof reference === 'string') current.set(reference, [...(current.get(reference) ?? []), node.attrs.noteId]) } })
    for (const [reference, values] of current) if (values.length === 1 && !declarations.has(reference)) add(reference, values[0])
  }
  else {
    const document = useAppStore.getState().documents[key], parsed = document ? readNoteDocument(document.content) : null
    const visit = (node: JSONContent) => { if (node.type === 'noteInclude') add(node.attrs?.referenceId, node.attrs?.noteId); node.content?.forEach(visit) }
    if (parsed?.status === 'valid') visit(parsed.note.content)
  }
  return new Set(Object.entries(shares).flatMap(([reference, ticket]) => declarations.get(reference)?.length === 1 && declarations.get(reference)![0] === ticket.include.noteId ? [reference] : []))
}
function attachPendingTargetEditor(key: string, target: PendingSourceTarget, editor: Editor): void {
  if (target.editors.has(editor) || editor.isDestroyed) return
  const changed = ({ transaction }: { transaction: { docChanged: boolean } }) => { if (transaction.docChanged) rememberPendingSourceTarget(key) }
  editor.on('transaction', changed)
  target.editors.set(editor, () => { editor.off('transaction', changed) })
}
function rememberPendingSourceTarget(key: string): void {
  if (!pendingSourceObservers.size) return
  const held = pendingSourceTargets.get(key), before = held ? pendingSourceKeys(held) : new Set<string>()
  const shares = useAppStore.getState().documents[key]?.noteEditing?.shares ?? {}
  if (!Object.keys(shares).length) {
    held?.editors.forEach(stop => stop()); pendingSourceTargets.delete(key)
  } else {
    const next = { shares, present: presentPendingReferences(key, shares), editors: held?.editors ?? new Map<Editor, () => void>() }
    pendingSourceTargets.set(key, next)
    for (const editor of editors.get(key) ?? []) attachPendingTargetEditor(key, next, editor)
  }
  const next = pendingSourceTargets.get(key), after = next ? pendingSourceKeys(next) : new Set<string>()
  if (held?.shares === next?.shares && held?.present.size === next?.present.size && [...(held?.present ?? [])].every(value => next?.present.has(value))) return
  for (const source of new Set([...before, ...after])) {
    const copies = [...pendingSourceTargets.values()].flatMap(target => Object.entries(target.shares).flatMap(([reference, ticket]) => target.present.has(reference) && pendingSourceKey(ticket.copy) === source ? [ticket.copy] : []))
    if (copies.length) pendingSourceCopies.set(source, copies); else pendingSourceCopies.delete(source)
    pendingSourceObservers.get(source)?.forEach(changed => changed())
  }
}
/** Observe only known ticket destinations after one mount-time recovery scan. */
export function observeNotePendingSource(sourceKey: string, sourceNoteId: string, editor: Editor, changed: () => void): () => void {
  const key = `${sourceKey}\0${sourceNoteId}`, observers = pendingSourceObservers.get(key) ?? new Set<() => void>()
  observers.add(changed); pendingSourceObservers.set(key, observers)
  if (!stopPendingSourceObservation) {
    stopPendingSourceObservation = useAppStore.subscribe((state, previous) => {
      if (state.config?.workspaces !== previous.config?.workspaces) pendingSourceObservers.forEach(observers => observers.forEach(changed => changed()))
      if (state.documents === previous.documents) return
      for (const [target, held] of pendingSourceTargets) {
        const document = state.documents[target], before = previous.documents[target]
        if (document?.noteEditing?.shares !== held.shares || document?.content !== before?.content && !editors.get(target)?.size) rememberPendingSourceTarget(target)
      }
    })
    for (const [target, document] of Object.entries(useAppStore.getState().documents)) if (Object.keys(document.noteEditing?.shares ?? {}).length) rememberPendingSourceTarget(target)
  }
  const onDestroy = () => cleanup()
  const cleanup = () => {
    editor.off('destroy', onDestroy)
    observers.delete(changed); if (!observers.size && pendingSourceObservers.get(key) === observers) pendingSourceObservers.delete(key)
    if (!pendingSourceObservers.size) {
      stopPendingSourceObservation?.(); stopPendingSourceObservation = undefined
      pendingSourceTargets.forEach(target => target.editors.forEach(stop => stop())); pendingSourceTargets.clear(); pendingSourceCopies.clear()
    }
  }
  editor.on('destroy', onDestroy)
  changed()
  return cleanup
}
/** Original sibling decorations preserve ordinary Markdown structure and the heading's full extent. */
export function notePendingSourceDecorations(sourceKey: string, sourceNoteId: string, doc: ProseMirrorNode): Decoration[] {
  const copies = pendingSourceCopies.get(`${sourceKey}\0${sourceNoteId}`) ?? []
  const ranges = new Map<string, { from: number; to: number; edge: string }>()
  for (const copy of copies) {
    const workspace = useAppStore.getState().config?.workspaces.find(value => value.id === copy.source.workspaceId)
    if (workspace?.hostId !== copy.source.hostId || workspace.path !== copy.source.workspacePath) continue
    const found: Array<{ node: ProseMirrorNode; parent: ProseMirrorNode; index: number; position: number }> = []
    if (copy.block.blockId) doc.descendants((node, position, parent, index) => { if (node.attrs.blockId === copy.block.blockId && parent) found.push({ node, parent, index, position }) })
    else {
      let parent = doc, position = 0
      for (let depth = 0; depth < copy.block.path.length; depth++) {
        const index = copy.block.path[depth]!
        if (index >= parent.childCount) break
        for (let before = 0; before < index; before++) position += parent.child(before).nodeSize
        const node = parent.child(index)
        if (depth === copy.block.path.length - 1) { if (noteBlockFingerprint(node.toJSON()) === copy.block.fingerprint) found.push({ node, parent, index, position }) }
        else { parent = node; position++ }
      }
    }
    if (found.length !== 1 || found[0]!.node.type.name === 'noteInclude') continue
    const target = found[0]!, length = target.node.type.name === 'heading' ? noteShareSiblingRange(target.parent.toJSON(), target.index).length : 1
    let from = target.position
    for (let offset = 0; offset < length; offset++) {
      const to = from + target.parent.child(target.index + offset).nodeSize
      ranges.set(`${from}:${to}`, { from, to, edge: length === 1 ? 'single' : offset === 0 ? 'first' : offset === length - 1 ? 'last' : 'inside' }); from = to
    }
  }
  return [...ranges.values()].map(range => Decoration.Node(range.from, range.to, { class: 'note-pending-shared-source', 'data-note-shared-source': 'pending', 'data-note-shared-edge': range.edge, ...(['first', 'single'].includes(range.edge) ? { title: 'Pending shared source · save its use to share' } : {}) }))
}
