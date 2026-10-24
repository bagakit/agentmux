import { NoteLinkActions } from './NoteLinkActions.js'
import type { NoteResource } from '@agentmux/core/notebook-catalog'
import { NoteFileContext, useNoteFileResource, resolveNoteSourceResource } from './NoteFileContext.js'
import { NoteTableTools } from './NoteTableTools.js'
import { createContext, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { EditorContent, NodeViewContent, NodeViewWrapper, ReactNodeViewRenderer, useEditor, type NodeViewProps, useEditorState } from '@tiptap/react'
import type { NoteProvenanceSnapshot } from '@agentmux/core/note-provenance'
import type { FileWriteReceipt, FileReadResult } from '@agentmux/core/files'
import type { NotebookGraph } from '@agentmux/core/notebook-observation'
import { Node as TiptapNode, type JSONContent } from '@tiptap/core'
import { NoteBlockReferenceNode, NoteIncludeNode, NoteInlineLinkNode, noteIdentityExtensions } from '../note/note-content-schema.js'
import { NoteInlineLinkView, type NoteLinkOpenRequest } from './NoteInlineLink.js'
import { noteWikiLiteralExtension } from '../note/note-wiki-view.js'
import { noteReadingSelectionExtension } from '../note/note-reading-selection.js'
import { noteWikiInputExtension } from '../note/note-wiki-input.js'
import { NoteSnapshotSync } from '../note/note-snapshot-sync.js'
import { readNoteDocument, serializeNoteDocument, type NoteBlockReference, type NoteInclude, type NoteBlockTarget, type NoteDocument } from '../note/note-document.js'
import { noteKnowledge, parseNoteFile, projectNoteBlocks, resolveNoteBlock, resolveNoteInclude, type NoteKnowledge, type NoteFileDocument } from '../note/note-knowledge.js'
import { acknowledgeNoteWrite, acknowledgeNoteCanonicalRead, noteWriteCanonicalContent, type NoteEditState } from '../note/note-edit-state.js'
import { mergeLiveNote } from '../note/note-live-merge.js'
import { noteRichContentExtensions } from './NoteRichContent.js'
import { NoteInsertMenu } from './NoteInsertMenu.js'
import { NoteBlockAuthors } from './NoteBlockAuthors.js'
import { semanticIconComponent } from '../theme/icons.js'
import { matchingNoteDraftInclude, type NoteReaderDraftInclude, type NoteReaderDraftSource } from '../note/note-draft-includes.js'
export type { NoteEditState } from '../note/note-edit-state.js'
export type { NoteLinkOpenRequest } from './NoteInlineLink.js'
export type { NoteReaderDraftInclude, NoteReaderDraftSource } from '../note/note-draft-includes.js'

const SourceIcon = semanticIconComponent('object.link'), SharedIcon = semanticIconComponent('object.shared-block'), UnknownIcon = semanticIconComponent('status.unknown')
const Scope = createContext<{ knowledge: NoteKnowledge; workspaceId: string; noteId: string; agentNames?: Readonly<Record<string, string>> | undefined; graph?: NotebookGraph | undefined; trail: string[]; draftIncludes?: readonly NoteReaderDraftInclude[] | undefined; onOpenDraftSource?: ((source: NoteReaderDraftSource) => void) | undefined; compactIncludes?: boolean | undefined; readInclude?: ((target: Pick<NoteInclude, 'noteId' | 'path' | 'workspaceId'>) => void) | undefined; readReference?: ((target: NoteBlockTarget) => void) | undefined; onOpenLink?: ((link: NoteLinkOpenRequest) => void) | undefined } | null>(null)
function InlineLink({ node, editor }: NodeViewProps) {
  const scope = useContext(Scope)
  return <NoteInlineLinkView node={node} editor={editor} onOpen={scope?.onOpenLink} />
}
function Reference({ node }: NodeViewProps) {
  const scope = useContext(Scope), parentResource = useNoteFileResource()
  const reference = node.attrs as NoteBlockReference
  if (!scope || !reference.target) return <NodeViewWrapper className="mobile-note-reference" role="status">引用目标尚未确认；当前输入保留，可撤销这次粘贴后继续编辑。</NodeViewWrapper>
  const result = resolveNoteBlock(scope.knowledge, reference.target)
  const key = JSON.stringify(reference.target)
  const kind = reference.mode === 'embed' ? 'Embedded block' : 'Block reference'
  return <NodeViewWrapper className="mobile-note-reference" data-block-id={node.attrs.blockId} aria-label={reference.mode === 'embed' ? 'Embedded block reference' : 'Block reference'}>
    {scope.trail.includes(key) ? <p role="status">循环引用，原引用保留。</p>
      : result.status === 'resolved' ? <Scope.Provider value={{ ...scope, noteId: result.source.note.noteId, workspaceId: result.source.location.workspaceId, trail: [...scope.trail, key] }}><NoteFileContext.Provider value={resolveNoteSourceResource(parentResource, result.source.location, scope.graph)}><RichContent content={projectNoteBlocks(result.source, [result.block.blockId]).content} /></NoteFileContext.Provider></Scope.Provider>
        : <><p role="status">引用正文尚未读取，原引用保留。</p>{scope.readReference && <button type="button" onClick={() => scope.readReference!(reference.target)}>读取引用原文</button>}</>}
    <details className="note-reader-source"><summary aria-label={`${kind} source`} title={`${kind} source`}><SourceIcon size={12} aria-hidden="true" /></summary><strong>{kind}</strong><code>{reference.target.noteId} / {reference.target.blockId}</code></details>
  </NodeViewWrapper>
}

/** Pure reading of already observed original bytes; the host owns every File read. */
function Include({ node }: NodeViewProps) {
  const scope = useContext(Scope), parentResource = useNoteFileResource(), include = node.attrs as NoteInclude
  if (!scope) return <NodeViewWrapper className="mobile-note-reference" role="status">共享内容的原文件范围尚未确认。</NodeViewWrapper>
  const draft = matchingNoteDraftInclude(scope.draftIncludes, parentResource, scope.noteId, include)
  if (draft) {
    const key = JSON.stringify(['draft-file', draft.source.resource, draft.source.noteId]), cycle = scope.trail.includes(key)
    return <NodeViewWrapper className="mobile-note-reference note-include note-include--pending" contentEditable={false} data-block-id={node.attrs.blockId} data-shared-note-id={include.noteId} data-pending-reference-id={include.referenceId}>
      <strong>Pending shared content</strong>
      {cycle ? <p role="status">Circular pending source. The original draft and reference are kept.</p>
        : draft.status === 'read' ? <Scope.Provider value={{ ...scope, noteId: draft.source.noteId, workspaceId: draft.source.resource.workspaceId, trail: [...scope.trail, key] }}><NoteFileContext.Provider value={draft.source.resource}><RichContent content={draft.content} /></NoteFileContext.Provider></Scope.Provider>
          : <p role="status">{draft.message}</p>}
      {scope.onOpenDraftSource && <button type="button" onClick={() => scope.onOpenDraftSource!(draft.source)}>Open original source</button>}
    </NodeViewWrapper>
  }
  const candidates = scope.graph?.observations.filter(item => item.noteId === include.noteId) ?? []
  const observed = candidates.length === 1 && !scope.graph?.duplicateNoteIds.includes(include.noteId) ? candidates[0] : undefined
  const confirmed = observed?.status === 'read' && observed.kind === 'shared-block' && observed.fileIdentity === 'confirmed'
    ? { workspaceId: observed.resource.workspaceId, path: observed.resource.path, revision: observed.revision } : undefined
  const resolved = resolveNoteInclude(scope.knowledge, include, scope.workspaceId, confirmed)
  const key = JSON.stringify(['file', include.noteId]), cycle = scope.trail.includes(key)
  if (scope.compactIncludes && confirmed) return <NodeViewWrapper className="note-include-link" contentEditable={false} data-block-id={node.attrs.blockId} data-shared-note-id={include.noteId}>
    <SharedIcon size={13} aria-hidden={false} role="img" aria-label="Shared content" /><button type="button" onClick={() => scope.onOpenLink?.({ text: resolved.status === 'resolved' ? resolved.source.note.title ?? 'Shared block' : 'Shared block', target: { noteId: include.noteId } })}>{resolved.status === 'resolved' ? resolved.source.note.title ?? 'Open shared original' : 'Open shared original'}</button>
  </NodeViewWrapper>
  return <NodeViewWrapper className="mobile-note-reference note-include" contentEditable={false} data-block-id={node.attrs.blockId} data-shared-note-id={include.noteId} aria-label="Shared content">
    {cycle ? <p role="status">循环引用，原共享内容与引用保留。</p> : resolved.status === 'resolved'
      ? <Scope.Provider value={{ ...scope, noteId: resolved.source.note.noteId, workspaceId: resolved.source.location.workspaceId, trail: [...scope.trail, key] }}><NoteFileContext.Provider value={resolveNoteSourceResource(parentResource, resolved.source.location, scope.graph)}><RichContent content={resolved.source.note.content} /></NoteFileContext.Provider></Scope.Provider>
      : <><p role="status">共享原文尚未确认，原引用保留。{resolved.message}</p>{scope.readInclude && <button type="button" onClick={() => scope.readInclude!({ noteId: include.noteId, path: include.path, ...(typeof include.workspaceId === 'string' ? { workspaceId: include.workspaceId } : {}) })}>读取共享原文</button>}</>}
    <details className="note-reader-source"><summary aria-label="Shared content source" title="Shared content source"><SharedIcon size={12} aria-hidden="true" /></summary>{resolved.status === 'resolved' && resolved.source.note.title ? <strong>{resolved.source.note.title}</strong> : null}<code>{include.noteId} · {resolved.status === 'resolved' ? resolved.source.location.path : include.path}</code></details>
  </NodeViewWrapper>
}

// Presentation-only wrapper, never part of a Note file or its identity index.
function BlockExcerpt({ node }: NodeViewProps) {
  const selected: readonly string[] = node.attrs.selectedBlockIds ?? EMPTY_IDS
  const clip = useRef<HTMLDivElement>(null), [long, setLong] = useState(false), [expanded, expand] = useState(false)
  useLayoutEffect(() => {
    const element = clip.current
    if (!element) return
    const measure = () => setLong(element.scrollHeight > 112)
    const observer = new ResizeObserver(measure)
    observer.observe(element); if (element.firstElementChild) observer.observe(element.firstElementChild)
    measure()
    return () => observer.disconnect()
  }, [])
  useLayoutEffect(() => {
    if (!selected.length) return
    const frame = requestAnimationFrame(() => {
      const element = clip.current
      if (!element) return
      const rows = [...element.querySelectorAll<HTMLElement>('[data-block-id]')].filter(row => selected.includes(row.dataset.blockId!) && row.closest('.mobile-note-body') === element.closest('.mobile-note-body'))
      const row = rows.find(row => !rows.some(other => other !== row && row.contains(other)))
      if (!row) return
      const viewport = element.getBoundingClientRect(), box = row.getBoundingClientRect()
      if (box.top < viewport.top || box.bottom > viewport.bottom) { const scale = viewport.width / element.offsetWidth; if (Number.isFinite(scale) && scale > 0) element.scrollTop += (box.top - viewport.top) / scale }
    })
    return () => cancelAnimationFrame(frame)
  }, [JSON.stringify(selected)])
  return <NodeViewWrapper className="note-reader-excerpt" data-excerpt-expanded={expanded}>
    <div ref={clip} className="note-reader-excerpt-clip" style={{ maxHeight: expanded ? undefined : 112, overflow: expanded ? undefined : selected.length ? 'auto' : 'hidden' }}><NodeViewContent /></div>
    {long && <button type="button" contentEditable={false} className="note-reader-excerpt-continue" onClick={() => expand(value => !value)}>{expanded ? 'Show shorter block' : 'Continue block'}</button>}
  </NodeViewWrapper>
}
const ExcerptNode = TiptapNode.create({ name: 'noteReadingExcerpt', group: 'block', content: 'block+', atom: false,
  addAttributes: () => ({ selectedBlockIds: { default: [] } }),
  parseHTML: () => [], renderHTML: () => ['div', { class: 'note-reader-excerpt' }, 0],
  addNodeView() { return ReactNodeViewRenderer(BlockExcerpt) },
})


function readingExcerpt(content: JSONContent, selected: readonly string[]): JSONContent {
  const ids: string[] = []
  const collect = (node: JSONContent) => { const id: unknown = node.attrs?.blockId; if (typeof id === 'string' && selected.includes(id)) ids.push(id); node.content?.forEach(collect) }
  collect(content)
  return { type: 'noteReadingExcerpt', attrs: { selectedBlockIds: ids }, content: [content] }
}

function RichContent({ content, onChange, onCompositionChange, onSnapshotIssue, onKeepDisplayedDraft, highlightBlockIds = EMPTY_IDS }: { content: JSONContent; highlightBlockIds?: readonly string[] | undefined; onChange?: ((value: JSONContent, editorBefore?: JSONContent) => void) | undefined; onCompositionChange?: ((composing: boolean) => void) | undefined; onSnapshotIssue?: ((displayed: JSONContent, incoming: JSONContent, reason: string) => void) | undefined; onKeepDisplayedDraft?: ((displayed: JSONContent, incoming: JSONContent) => void) | undefined }) {
  const selected = useRef(highlightBlockIds); selected.current = highlightBlockIds
  const scope = useContext(Scope), open = useRef(scope?.onOpenLink); open.current = scope?.onOpenLink
  const extensions = useMemo(() => noteRichContentExtensions().map(extension => extension.name === NoteBlockReferenceNode.name
    ? NoteBlockReferenceNode.extend({ addNodeView() { return ReactNodeViewRenderer(Reference) } }) : extension.name === NoteInlineLinkNode.name
    ? NoteInlineLinkNode.extend({ addNodeView() { return ReactNodeViewRenderer(InlineLink) } }) : extension.name === NoteIncludeNode.name
    ? NoteIncludeNode.extend({ addNodeView() { return ReactNodeViewRenderer(Include) } }) : extension).concat(onChange ? [...noteIdentityExtensions(), noteWikiInputExtension()] : []).concat([noteWikiLiteralExtension(link => open.current?.(link)), ...onChange ? [] : [ExcerptNode, noteReadingSelectionExtension(() => selected.current)]]), [Boolean(onChange)])
  const update = useRef({ content, onChange, onCompositionChange, onSnapshotIssue, onKeepDisplayedDraft }); update.current = { content, onChange, onCompositionChange, onSnapshotIssue, onKeepDisplayedDraft }
  const compositionBefore = useRef<JSONContent | null>(null)
  const composing = useRef(false), snapshot = useRef<NoteSnapshotSync | null>(null), [issue, setIssue] = useState<string | null>(null)
  const [mappingDrafts, setMappingDrafts] = useState<{ displayed: JSONContent; incoming: JSONContent } | null>(null), [compareIncoming, setCompareIncoming] = useState(false)
  const editor = useEditor({ extensions, content, editable: Boolean(onChange),
    onUpdate: ({ editor, transaction }) => { if (!composing.current && !editor.view.composing && !transaction.getMeta('noteWikiCompositionEnd')) update.current.onChange?.(editor.getJSON(), transaction.before.toJSON()) },
    onTransaction: ({ editor, transaction }) => {
      if (transaction.getMeta('noteWikiCompositionEnd') && !editor.view.composing) {
        update.current.onChange?.(editor.getJSON(), compositionBefore.current ?? transaction.before.toJSON())
        compositionBefore.current = null
        if (composing.current) { composing.current = false; update.current.onCompositionChange?.(false) }
      }
    },
    editorProps: { attributes: { class: 'mobile-note-body', 'aria-label': '原 Note 正文' },
      handleDOMEvents: { compositionstart(view) { if (!composing.current) { compositionBefore.current = view.state.doc.toJSON(); composing.current = true; snapshot.current?.pause(); update.current.onCompositionChange?.(true) }; return false } }
    } }, [])
  useEffect(() => {
    if (!editor) return
    const sync = new NoteSnapshotSync(editor, () => composing.current, (message, pair) => {
      setIssue(message)
      if (!message) { setMappingDrafts(null); setCompareIncoming(false) }
      else if (pair && JSON.stringify(pair.incoming) === JSON.stringify(update.current.content)) {
        setMappingDrafts(pair); update.current.onSnapshotIssue?.(pair.displayed, pair.incoming, message)
      }
    })
    snapshot.current = sync
    return () => { sync.destroy(); if (snapshot.current === sync) snapshot.current = null }
  }, [editor])
  useEffect(() => {
    if (!editor) return
    snapshot.current?.update(content)
  }, [editor, content])
  useEffect(() => {
    const clear = () => { compositionBefore.current = null; if (composing.current) { composing.current = false; update.current.onCompositionChange?.(false) } }
    editor?.on('unmount', clear)
    return () => { editor?.off('unmount', clear); clear() }
  }, [editor])
  useEffect(() => {
    if (!editor || onChange) return
    const highlight = () => { if (!editor.isDestroyed) editor.view.dispatch(editor.state.tr.setMeta('noteReadingSelection', true)) }
    highlight(); editor.on('mount', highlight)
    return () => { editor.off('mount', highlight) }
  }, [editor, Boolean(onChange), highlightBlockIds])
  const state = useEditorState({ editor, selector: ({ editor }) => editor.isDestroyed ? null : ({ bold: editor.isActive('bold'), italic: editor.isActive('italic'), heading: editor.isActive('heading'), list: editor.isActive('bulletList'), code: editor.isActive('codeBlock') }) })
  return <>{onChange && editor && <div role="toolbar" aria-label="笔记格式">
    <button type="button" aria-pressed={state?.bold} onClick={() => editor.chain().focus().toggleBold().run()}>粗体</button>
    <button type="button" aria-pressed={state?.italic} onClick={() => editor.chain().focus().toggleItalic().run()}>斜体</button>
    <button type="button" aria-pressed={state?.heading} onClick={() => editor.chain().focus().toggleHeading({ level: 2 }).run()}>标题</button>
    <button type="button" aria-pressed={state?.list} onClick={() => editor.chain().focus().toggleBulletList().run()}>列表</button>
    <button type="button" aria-pressed={state?.code} onClick={() => editor.chain().focus().toggleCodeBlock().run()}>代码</button>
    <NoteInsertMenu editor={editor} /><NoteTableTools editor={editor} />
    <button type="button" onClick={() => editor.chain().focus().undo().run()}>撤销</button>
    <button type="button" onClick={() => editor.chain().focus().redo().run()}>重做</button>
  </div>}{issue && <section role="status" aria-label="Incoming update recovery"><p>{issue}</p>
    <p>Both drafts are kept. Compare them if their blocks cannot be matched reliably.</p>
    <button type="button" onClick={() => snapshot.current?.retry()}>Retry incoming update</button>
    {mappingDrafts && <>
      <button type="button" aria-expanded={compareIncoming} onClick={() => setCompareIncoming(value => !value)}>Compare incoming update</button>
      {onKeepDisplayedDraft && <button type="button" onClick={() => {
        if (!editor || editor.isDestroyed || composing.current || editor.view.composing || JSON.stringify(mappingDrafts.incoming) !== JSON.stringify(update.current.content)) return
        update.current.onKeepDisplayedDraft?.(editor.getJSON(), mappingDrafts.incoming)
      }}>Keep editing displayed draft</button>}
      {compareIncoming && <div aria-label="Draft comparison, read only"><h4>Displayed draft</h4><RichContent content={mappingDrafts.displayed} /><h4>Incoming draft</h4><RichContent content={mappingDrafts.incoming} /></div>}
    </>}
  </section>}<NoteLinkActions editor={editor} /><EditorContent editor={editor} /><NoteBlockAuthors editor={editor} agentNames={scope?.agentNames} /></>
}
export type NoteEditing = {
  initial?: NoteEditState | undefined
  onDraft(state: NoteEditState): void
  subscribe?: ((listener: (state: NoteEditState, issue?: string) => void) => () => void) | undefined
  readDeviceDraft?: (() => NoteEditState | undefined) | undefined
  adoptDeviceDraft?: ((state: NoteEditState) => void) | undefined
  save(content: string, expectedRevision: string): Promise<FileWriteReceipt>
  readCurrent(): Promise<FileReadResult>
}
export type NoteReaderProps = { resource?: NoteResource | undefined; agentNames?: Readonly<Record<string, string>> | undefined; noteProvenance?: NoteProvenanceSnapshot | undefined; content: string; path: string; workspaceId: string; revision: string | null;
  documents?: Parameters<typeof noteKnowledge>[0] | undefined
  graph?: NotebookGraph | undefined
  /** Exact host-bound pending uses. The Reader consumes data only; the host owns source reads. */
  draftIncludes?: readonly NoteReaderDraftInclude[] | undefined
  onOpenDraftSource?: ((source: NoteReaderDraftSource) => void) | undefined
  readInclude?: ((target: Pick<NoteInclude, 'noteId' | 'path' | 'workspaceId'>) => void) | undefined
  readReference?: ((target: NoteBlockTarget) => void) | undefined
  /** Only the reading projection changes; content remains the complete original Note. */
  blockIds?: readonly string[] | undefined
  /** Project a single top-level block by index when an unsaved draft block has no persisted blockId yet. */
  topBlockIndex?: number | undefined
  highlightBlockIds?: readonly string[] | undefined
  clipBlocks?: boolean | undefined
  /** Read-only opening summary. Knowledge and original bytes remain complete. */
  previewBlockCount?: number | undefined
  /** Summarize includes when the original content already has its own reading surface. */
  compactIncludes?: boolean | undefined
  /** A host with several excerpts can disclose this document's metadata once beside them. */
  showDocumentMetadata?: boolean | undefined
  editing?: NoteEditing | undefined
  target?: NoteBlockTarget | undefined
  onOpenLink?: ((link: NoteLinkOpenRequest) => void) | undefined
}
const EMPTY_IDS: readonly string[] = []
const EMPTY_DOCUMENTS: NonNullable<NoteReaderProps['documents']> = []
export function NoteReaderMetadata({ noteProvenance }: { noteProvenance?: NoteProvenanceSnapshot | undefined }) {
  return noteProvenance?.status === 'unconfirmed' ? <details className="note-reader-metadata"><summary aria-label="Authorship details: unconfirmed" title="Authorship details: unconfirmed"><UnknownIcon size={12} aria-hidden="true" /></summary><p>Authorship is unconfirmed: {noteProvenance.reason} Read the same original file again to check its metadata. The Note remains readable and editable.</p></details> : null
}
export function NoteReader({ resource, agentNames, content, path, workspaceId, revision, noteProvenance, documents = EMPTY_DOCUMENTS, graph, draftIncludes, onOpenDraftSource, readInclude, blockIds, topBlockIndex, highlightBlockIds = EMPTY_IDS, clipBlocks = true, previewBlockCount, compactIncludes, showDocumentMetadata = true, readReference, editing, target, onOpenLink }: NoteReaderProps) {
  const parentResource = useNoteFileResource()
  const originalResource = resource ?? resolveNoteSourceResource(parentResource, { workspaceId, path }, graph)
  const observed = useMemo(() => ({ path, content, revision: revision ?? '', ...noteProvenance ? { noteProvenance } : {} }), [path, content, revision, noteProvenance])
  const [written, setWritten] = useState<{ source: NoteFileDocument; document: NoteFileDocument } | null>(null)
  // Consume this original write receipt while its input observation is still current.
  // A later authoritative read wins; newer draft bytes are hydrated by their own actual hash.
  const original = written?.source === observed ? written.document : observed
  const parsed = useMemo(() => parseNoteFile(original), [original])
  const body = useRef<HTMLDivElement>(null)
  const [working, setWorking] = useState<{ noteId: string; content: string } | null>(null)
  const workingContent = parsed.status === 'valid' && working?.noteId === parsed.note.noteId ? working.content
    : parsed.status === 'valid' && editing?.initial?.noteId === parsed.note.noteId ? editing.initial.draft : original.content
  const knowledge = useMemo(() => noteKnowledge([{ location: { workspaceId, path }, document: { ...original, content: workingContent } }, ...documents], 'partial', graph?.observations.flatMap(item => item.status === 'read' && item.kind === 'shared-block' && item.fileIdentity === 'confirmed' && !graph.duplicateNoteIds.includes(item.noteId) ? [{ noteId: item.noteId, workspaceId: item.resource.workspaceId, path: item.resource.path, revision: item.revision }] : []) ?? []), [workingContent, path, workspaceId, original, documents, graph])
  const excerpt = useMemo(() => {
    const source = knowledge.sources.find(source => source.location.workspaceId === workspaceId && source.location.path === path)
    return topBlockIndex === undefined && blockIds && source ? projectNoteBlocks(source, blockIds, highlightBlockIds) : null
  }, [knowledge, blockIds, topBlockIndex, highlightBlockIds, workspaceId, path])
  const block = target ? resolveNoteBlock(knowledge, target) : null
  // A different read-only projection is not a revision of the same editing draft.
  const readingScope = JSON.stringify([workspaceId, path, parsed.status === 'valid' ? parsed.note.noteId : null,
    blockIds ? [...new Set(blockIds)].sort() : null, topBlockIndex ?? null, blockIds || topBlockIndex !== undefined ? clipBlocks : null, previewBlockCount ?? null, Boolean(compactIncludes)])
  useEffect(() => {
    if (!target || block?.status !== 'resolved') return
    const element = [...body.current?.querySelectorAll<HTMLElement>('[data-block-id]') ?? []].find(element => element.dataset.blockId === target.blockId)
    element?.scrollIntoView?.({ block: 'center' })
  }, [target?.noteId, target?.blockId, block?.status])
  return parsed.status === 'valid' ? <NoteFileContext.Provider value={originalResource}><Scope.Provider value={{ knowledge, workspaceId, noteId: parsed.note.noteId, agentNames, graph, draftIncludes: editing ? undefined : draftIncludes, onOpenDraftSource, trail: [], compactIncludes, readInclude, readReference, onOpenLink }}><div ref={body} data-note-id={parsed.note.noteId} data-target-block={block?.status === 'resolved' ? target?.blockId : undefined}>
    {target && <section aria-label="原块定位" data-block-target-status={block?.status}>
      {block?.status === 'resolved' ? <><strong>引用的原块</strong><p>{block.block.text}</p></> : <p role="status">原块未确认：{block?.message} 原引用保留，仍可阅读完整笔记。</p>}
    </section>}
    {editing && original.revision ? <EditableNote key={parsed.note.noteId} note={parsed.note} content={original.content} revision={original.revision} original={original} onWritten={document => setWritten({ source: observed, document })} editing={{ ...editing, subscribe: editing.subscribe ? listener => editing.subscribe!((state, issue) => { setWorking({ noteId: state.noteId, content: state.draft }); listener(state, issue) }) : undefined, onDraft: state => { setWorking({ noteId: state.noteId, content: state.draft }); editing.onDraft(state) } }} /> : <RichContent key={readingScope} highlightBlockIds={highlightBlockIds} content={topBlockIndex !== undefined ? { type: 'doc', content: parsed.note.content.content?.[topBlockIndex] ? [clipBlocks ? readingExcerpt(parsed.note.content.content[topBlockIndex]!, highlightBlockIds) : parsed.note.content.content[topBlockIndex]!] : [] } : excerpt ? { type: 'doc', content: clipBlocks ? excerpt.content.content?.map(node => readingExcerpt(node, highlightBlockIds)) ?? [] : (excerpt.content.content ?? []) } : previewBlockCount === undefined ? parsed.note.content : { ...parsed.note.content, content: parsed.note.content.content?.slice(0, previewBlockCount).map(node => readingExcerpt(node, highlightBlockIds)) ?? [] }} />}
    {showDocumentMetadata && <NoteReaderMetadata noteProvenance={original.noteProvenance} />}
  </div></Scope.Provider></NoteFileContext.Provider> : <><p role="status">原笔记读取问题：{parsed.message}</p><pre>{content}</pre></>
}
function EditableNote({ note, content, revision, editing, original, onWritten }: { note: NoteDocument; content: string; revision: string; editing: NoteEditing; original: NoteFileDocument; onWritten(document: NoteFileDocument): void }) {
  const alive = useRef(true)
  const inspectionEpoch = useRef(0), inputDrain = useRef<Promise<void> | null>(null)
  const composing = useRef(false), deferredWrite = useRef<(() => void) | null>(null), deferredRead = useRef<(() => void) | null>(null)
  useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])
  const initial = editing.initial?.noteId === note.noteId ? editing.initial : undefined
  const [state, setState] = useState<NoteEditState>(initial ?? { noteId: note.noteId, draft: content, expectedRevision: revision })
  const current = useRef(state); current.current = state
  const savedNotice = (receipt: NonNullable<NoteEditState['receipt']>) => '原文件保存已确认。' +
    (receipt.noteTitleProjection?.status === 'unconfirmed' ? `目录标题投影未确认：${receipt.noteTitleProjection.message}；可核对当前原文。` : '') +
    (receipt.noteAttribution?.status === 'unconfirmed' ? `块作者未确认：${receipt.noteAttribution.reason}` : '')
  const [opened, open] = useState(Boolean(initial)), [notice, setNotice] = useState(initial?.attempt?.phase === 'written'
    ? initial.attempt.canonicalContent === undefined ? '原文件已保存，正文待核对；原保存记录与后来的草稿保留。' : '原文件已保存，正在对齐后来的输入；原提交基线与草稿保留。'
    : initial?.attempt ? '原保存回执未确认，草稿保留；请核对原文件，不会重复写入。' : initial?.receipt ? savedNotice(initial.receipt) : '')
  const [formatIssue, setFormatIssue] = useState('')
  const [remote, setRemote] = useState<{ document: NoteFileDocument; note: NoteDocument } | null>(null)
  const [externalDraft, setExternalDraft] = useState<string | null>(null)
  const [device, setDevice] = useState<NoteEditState | null>(null)
  const unretained = useRef(false)
  const draftWriter = useRef(editing.onDraft); draftWriter.current = editing.onDraft
  const subscribe = useRef(editing.subscribe); subscribe.current = editing.subscribe
  useEffect(() => subscribe.current?.((value, durabilityIssue) => {
    if (value.noteId !== note.noteId) return
    const previous = current.current
    let retained = value
    if (unretained.current) {
      // An unpersisted workface still owns its original CAS base and pending input.
      // Another view's newer draft/revision cannot turn that old full body into a safe save.
      let acknowledged = previous
      const attempt = previous.attempt, incoming = value.attempt
      const receipt = incoming?.phase === 'written' ? incoming.written : value.receipt
      const eventId = attempt?.noteHistory?.eventId ?? attempt?.written?.noteHistory?.eventId
      const exactAttempt = !incoming || incoming.content === attempt?.content && incoming.expectedRevision === attempt.expectedRevision
      if (attempt && eventId && receipt?.noteHistory?.eventId === eventId && exactAttempt) {
        const canonical = incoming?.canonicalContent ?? noteWriteCanonicalContent(value.draft, receipt)
        acknowledged = acknowledgeNoteWrite(previous, attempt.content, attempt.expectedRevision, { ...receipt, ...(canonical === undefined ? {} : { content: canonical }) })
      }
      retained = preserveWorkfaceFacts(acknowledged, value)
    }
    current.current = retained; setState(retained); if (!composing.current) setExternalDraft(retained.draft); open(true)
    if (!retained.input?.issue && (retained.input || retained.attempt?.phase === 'written' && retained.attempt.canonicalContent !== undefined)) void drainInput()
    if (retained.attempt) setNotice(retained.attempt.phase === 'written' ? retained.attempt.canonicalContent === undefined ? '原文件已保存，正文待核对；原保存记录与后来的草稿保留。' : '原文件已保存，正在对齐后来的输入；原提交基线与草稿保留。' : '原保存回执未确认，草稿保留；请核对原文件，不会重复写入。')
    else if (retained.receipt) setNotice(savedNotice(retained.receipt))
    if (unretained.current) {
      unretained.current = false
      try { draftWriter.current(retained); setNotice('本机存储已恢复，两份原编辑均已保全。') }
      catch (error) { unretained.current = true; setNotice(`两份编辑在当前工作面保留，本机保存仍未确认：${String(error)}`) }
    }
    if (durabilityIssue) { unretained.current = true; setNotice(durabilityIssue) }
  }), [note.noteId])
  const baseline = useMemo(() => { const read = parseNoteFile({ ...original, content: state.input?.proposedContent ?? state.draft }); return read.status === 'valid' ? read.note.content : note.content }, [opened, externalDraft, original, state.input])
  const persist = (value: NoteEditState) => {
    current.current = value; setState(value)
    try { editing.onDraft(value); unretained.current = false; return true }
    catch (error) { unretained.current = true; setNotice(`本机草稿与保存意图未持久保存：${error instanceof Error ? error.message : String(error)}。当前编辑保留；恢复本机存储后可明确保存。`); return false }
  }
  async function drainInput(): Promise<void> {
    if (composing.current) return
    if (inputDrain.current) return inputDrain.current
    const pending = (async () => {
      while (alive.current && !composing.current) {
        const before = current.current, input = before.input, attempt = before.attempt
        if (input) {
          const merged = await mergeLiveNote(input.baseContent, before.draft, input.proposedContent)
          if (!alive.current) return
          if (current.current.input !== input || current.current.draft !== before.draft) continue
          if (merged.status !== 'merged') {
            persist({ ...current.current, input: { ...input, issue: merged.status === 'unavailable' ? merged.message : '这次输入与已确认的当前稿发生重叠。' } })
            setNotice('这次输入尚未合入当前稿；基线、已确认当前稿和输入稿均保留，请比较后选择。')
            return
          }
          persist({ ...current.current, draft: merged.content, input: undefined }); setExternalDraft(merged.content)
          continue
        }
        if (attempt?.phase !== 'written' || attempt.canonicalContent === undefined) return
        const canonical = attempt.canonicalContent
        const merged = await mergeLiveNote(attempt.content, canonical, before.draft)
        if (!alive.current) return
        if (current.current.attempt !== attempt || current.current.input || current.current.draft !== before.draft) continue
        if (merged.status !== 'merged') {
          persist({ ...current.current, draft: canonical, attempt: undefined,
            input: { baseContent: attempt.content, observedContent: canonical, proposedContent: before.draft,
              issue: merged.status === 'unavailable' ? merged.message : '后来的输入与已保存正文发生重叠。' } })
          setNotice('原文件已保存；后来的输入与保存正文尚未对齐，三份原文均保留，请比较后选择。')
          return
        }
        persist({ ...current.current, draft: merged.content, attempt: undefined }); setExternalDraft(merged.content)
        setNotice((current.current.receipt ? savedNotice(current.current.receipt) : '原文件保存已确认。') + '后来的输入已对齐该保存正文。')
      }
    })()
    inputDrain.current = pending
    try { await pending } finally { if (inputDrain.current === pending) inputDrain.current = null }
  }
  useEffect(() => { if (initial?.attempt?.phase === 'written') { if (initial.attempt.canonicalContent !== undefined) void drainInput(); else void inspect() }; if (initial?.input) void drainInput() }, [note.noteId])
  async function save() {
    if (current.current.attempt) return
    if (composing.current) { setNotice('当前输入尚在组合，完成输入后可保存；原编辑保留。'); return }
    await drainInput()
    if (current.current.input) { setNotice('这次输入尚未合入当前稿；三份原文保留，请比较后再保存。'); return }
    const epoch = ++inspectionEpoch.current
    const sent = current.current, parsed = readNoteDocument(sent.draft)
    if (parsed.status !== 'valid' || parsed.note.noteId !== note.noteId) { setNotice('原 Note 身份或块内容未确认，草稿保留。'); return }
    const attempt = { content: sent.draft, expectedRevision: sent.expectedRevision, phase: 'sending' as const }
    if (!persist({ ...sent, attempt })) { current.current = sent; setState(sent); return }
    setNotice('正在保存原笔记…')
    let result: FileWriteReceipt
    try { result = await editing.save(attempt.content, attempt.expectedRevision) }
    catch (error) { result = { status: 'unknown', code: 'NOTE_SAVE_UNKNOWN', message: error instanceof Error ? error.message : String(error) } }
    if (!alive.current || epoch !== inspectionEpoch.current) return
    const ownsAttempt = () => current.current.attempt?.content === attempt.content && current.current.attempt.expectedRevision === attempt.expectedRevision
    if (result.status === 'written') {
      const canonical = noteWriteCanonicalContent(attempt.content, result)
      const written = result
      const complete = () => {
        if (!alive.current) return
        const before = current.current, accepted = acknowledgeNoteWrite(before, attempt.content, attempt.expectedRevision, written)
        if (accepted === before && (before.attempt || before.receipt?.revision !== written.revision || before.receipt.noteHistory?.eventId !== written.noteHistory?.eventId || before.receipt.noteHistory?.batchId !== written.noteHistory?.batchId)) return
        if (persist(accepted)) {
          if (canonical !== undefined) {
            onWritten({ path: original.path, content: canonical, revision: written.revision, ...(written.noteProvenance ? { noteProvenance: written.noteProvenance } : {}) })
            setExternalDraft(accepted.draft)
          }
          setNotice(canonical === undefined ? '原文件已保存，正文待核对；原保存记录与后来的草稿保留。' : savedNotice(written))
          if (accepted.attempt?.phase === 'written') { if (accepted.attempt.canonicalContent !== undefined) void drainInput(); else void inspect() }
        }
      }
      if (composing.current) {
        if (!ownsAttempt()) return
        persist(acknowledgeNoteWrite(current.current, attempt.content, attempt.expectedRevision, written, true))
        deferredWrite.current = complete; setNotice('原文件保存已确认；完成当前输入后对账正文，原保存记录与后来的草稿保留。')
      } else complete()
    }
    else if (result.status === 'unknown') { const latest = current.current as NoteEditState; if (!ownsAttempt() || latest.attempt?.phase === 'written') return; persist({ ...latest, attempt: { ...attempt, phase: 'unknown', ...(result.noteHistory ? { noteHistory: result.noteHistory } : {}) } }); setNotice(`保存回执未知：${result.message}。草稿保留，请核对原文件；不会重复写入。`) }
    else {
      const latest = current.current as NoteEditState
      // The device owner may already have published this exact non-write result
      // and cleared its pending intent. The original live call still owns its
      // notice; a different pending request or adopted revision does not.
      const clearedOriginal = !latest.attempt && latest.expectedRevision === attempt.expectedRevision
      if ((!ownsAttempt() && !clearedOriginal) || latest.attempt?.phase === 'written') return
      const { attempt: pending, ...kept } = latest; persist(kept); setNotice(result.status === 'conflict' ? '原文件已改变，草稿保留；请核对当前原文后明确处理冲突。' : `保存失败：${result.message}。草稿保留。`) }
  }
  async function inspect() {
    const epoch = inspectionEpoch.current
    try {
      const result = await editing.readCurrent()
      if (!alive.current || epoch !== inspectionEpoch.current) return
      if (result.result.status !== 'read') { setNotice(result.result.status === 'unknown' || result.result.status === 'error' ? result.result.message : `原文件状态：${result.result.status}；草稿保留。`); return }
      if (result.result.document.path !== original.path) { setNotice('读取不是待核对保存的原文件；草稿与原保存记录保留。'); return }
      const parsed = readNoteDocument(result.result.document.content)
      if (parsed.status !== 'valid' || parsed.note.noteId !== note.noteId) { setNotice('读取未确认同一原 Note，草稿与保存意图保留。'); return }
      const document = result.result.document
      const complete = () => {
        if (!alive.current || epoch !== inspectionEpoch.current) return
        setRemote({ document, note: parsed.note })
        // Retrying device retention saves the already observed receipt and draft;
        // reading equal remote bytes never settles an unknown write.
        if (unretained.current && !persist(current.current)) return
        const accepted = acknowledgeNoteCanonicalRead(current.current, document)
        if (accepted !== current.current) {
          if (persist(accepted)) {
            onWritten(document); setExternalDraft(accepted.draft); setRemote(null)
            setNotice((accepted.receipt ? savedNotice(accepted.receipt) : '原文件保存已确认。') + '已核对该保存修订的正文；后来的草稿保留。')
            if (accepted.attempt?.canonicalContent !== undefined) void drainInput()
          }
        } else setNotice(current.current.attempt?.phase === 'written' ? '原文件保存已确认；本次读取是另一修订，尚未核对原保存正文。原保存记录与当前草稿保留。'
          : current.current.attempt?.phase === 'sending' ? '原保存请求仍在等待回执，本次读取不能代签；草稿与原请求保留，不会发起第二次保存。'
          : current.current.attempt ? '本次读取不能确认原保存请求的结果，即使字节相同，原回执仍未知。草稿与原保存记录保留，不会重复写入。' : '已读当前原文；原草稿保留，可明确以当前修订继续保存。')
      }
      if (composing.current) deferredRead.current = complete
      else complete()
    } catch (error) { setNotice(`核对原文件失败：${error instanceof Error ? error.message : String(error)}。草稿与原意图保留。`) }
  }
  function snapshotDrafts(displayed: JSONContent, incoming: JSONContent): { displayed: string; incoming: string } | null {
    if (!alive.current || JSON.stringify(incoming) !== JSON.stringify(baseline)) return null
    try {
      const pair = { displayed: serializeNoteDocument({ ...note, content: displayed }), incoming: serializeNoteDocument({ ...note, content: incoming }) }
      for (const content of Object.values(pair)) { const read = readNoteDocument(content); if (read.status !== 'valid' || read.note.noteId !== current.current.noteId) return null }
      return pair
    } catch (error) { setFormatIssue(`画面中的原编辑仍保留，暂未保存为本机稿：${error instanceof Error ? error.message : String(error)}。`); return null }
  }
  function keepAlternates(latest: NoteEditState, drafts: readonly string[]): NonNullable<NoteEditState['alternates']> {
    const alternates = [...latest.alternates ?? []], known = new Set([latest.draft, ...alternates.map(value => value.draft)])
    for (const draft of drafts) if (!known.has(draft)) { alternates.push({ draft, expectedRevision: latest.expectedRevision }); known.add(draft) }
    return alternates
  }
  function preserveWorkfaceFacts(chosen: NoteEditState, previous: NoteEditState): NoteEditState {
    const input = previous.input, attempt = previous.attempt
    const unconfirmed = [...chosen.unconfirmed ?? [], ...previous.unconfirmed ?? []]
    if (attempt && JSON.stringify(attempt) !== JSON.stringify(chosen.attempt)) unconfirmed.push({ content: attempt.content, expectedRevision: attempt.expectedRevision,
      ...(attempt.noteHistory ? { noteHistory: attempt.noteHistory } : {}), ...(attempt.written ? { written: attempt.written } : {}) })
    const seen = new Set<string>()
    return { ...chosen, unconfirmed: unconfirmed.filter(record => { const key = JSON.stringify(record); if (seen.has(key)) return false; seen.add(key); return true }),
      alternates: keepAlternates({ ...chosen, alternates: [...chosen.alternates ?? [], ...previous.alternates ?? []] },
        [previous.draft, ...input ? [input.baseContent, input.observedContent, input.proposedContent] : [], ...attempt?.canonicalContent === undefined ? [] : [attempt.canonicalContent]]) }
  }
  function adoptInspectedDevice() {
    if (!device || !editing.adoptDeviceDraft) return
    const value = preserveWorkfaceFacts(device, current.current)
    try {
      editing.adoptDeviceDraft(value); inspectionEpoch.current++; current.current = value; setState(value); setExternalDraft(value.draft); editing.onDraft(value); setDevice(null)
      setNotice('已采用本机草稿，原编辑、输入三稿与保存记录另存保留；原请求不会重新写入。')
      if (!value.input?.issue && (value.input || value.attempt?.phase === 'written' && value.attempt.canonicalContent !== undefined)) void drainInput()
    } catch (error) { setNotice(`采用本机草稿未确认：${error instanceof Error ? error.message : String(error)}；两份内容与原保存记录保留。`) }
  }
  return <>{!opened ? <><RichContent key="saved" content={note.content} /><button type="button" onClick={() => { persist({ noteId: note.noteId, draft: content, expectedRevision: revision }); open(true) }}>编辑原笔记</button></> : <>
    <RichContent key="draft" content={baseline} onSnapshotIssue={(displayed, incoming, reason) => {
      const pair = snapshotDrafts(displayed, incoming)
      if (!pair) return
      const latest = current.current, alternates = keepAlternates(latest, [pair.displayed])
      if (alternates.length !== (latest.alternates?.length ?? 0)) persist({ ...latest, alternates })
      setNotice(`画面原稿与传入稿均保留，尚未自动对齐：${reason}。可比较后明确选择继续编辑的稿件。`)
    }} onKeepDisplayedDraft={(displayed, incoming) => {
      if (composing.current) return
      const pair = snapshotDrafts(displayed, incoming)
      if (!pair) return
      const latest = current.current, input = latest.input
      const alternates = keepAlternates({ ...latest, draft: pair.displayed }, [latest.draft, pair.incoming, ...input ? [input.baseContent, input.observedContent, input.proposedContent] : []])
      persist({ ...latest, draft: pair.displayed, input: undefined, alternates }); setExternalDraft(pair.displayed)
      setNotice('已明确继续编辑画面原稿；传入稿、原输入与保存记录均保留。')
      if (current.current.attempt?.phase === 'written' && current.current.attempt.canonicalContent !== undefined) void drainInput()
    }} onCompositionChange={active => {
      composing.current = active
      if (!active && alive.current) {
        const written = deferredWrite.current, read = deferredRead.current
        deferredWrite.current = null; deferredRead.current = null
        written?.(); read?.(); if (current.current.input) void drainInput(); else setExternalDraft(current.current.draft)
      }
    }} onChange={(value, editorBefore) => {
      let proposed: string, before: string
      try { proposed = serializeNoteDocument({ ...note, content: value }); before = editorBefore ? serializeNoteDocument({ ...note, content: editorBefore }) : current.current.draft }
      catch (error) { setFormatIssue(`本次输入尚未保存：${error instanceof Error ? error.message : String(error)}。输入与撤销记录保留，可撤销这次输入后继续编辑。`); return }
      setFormatIssue('')
      const latest = current.current, pending = latest.input
      if (!pending && before === latest.draft) { persist({ ...latest, draft: proposed }); return }
      const input = pending?.proposedContent === before ? { baseContent: pending.baseContent, observedContent: pending.observedContent, proposedContent: proposed }
        : { baseContent: before, observedContent: latest.draft, proposedContent: proposed }
      persist({ ...latest, input, ...(pending && pending.proposedContent !== before ? { alternates: keepAlternates(latest, [pending.baseContent, pending.observedContent, pending.proposedContent]) } : {}) })
      void drainInput()
    }} />
    {state.input?.issue && <details open><summary>输入与当前稿尚未对齐</summary><p>{state.input.issue}</p><details><summary>输入基线</summary><pre>{state.input.baseContent}</pre></details><details><summary>已确认当前稿</summary><pre>{state.draft}</pre></details><details><summary>这次输入稿</summary><pre>{state.input.proposedContent}</pre></details>{[false, true].map(adopt => <button type="button" key={String(adopt)} onClick={() => {
      const latest = current.current, input = latest.input
      if (!input) return
      const draft = adopt ? input.proposedContent : latest.draft
      persist({ ...latest, draft, input: undefined, alternates: keepAlternates({ ...latest, draft }, [latest.draft, input.baseContent, input.observedContent, input.proposedContent]) })
      setExternalDraft(draft); setNotice('两份编辑与原基线均保留，已采用明确选择的稿件。')
    }}>{adopt ? '保留两份，采用这次输入' : '保留两份，采用当前草稿'}</button>)}</details>}
    <button type="button" disabled={Boolean(state.attempt)} onClick={() => { void save() }}>保存原笔记</button>
    <button type="button" onClick={() => { void inspect() }}>核对当前原文</button>
    {editing.readDeviceDraft && <button type="button" onClick={() => { try { const value = editing.readDeviceDraft!(); if (!value || value.noteId !== note.noteId) { setNotice('未读到同一原 Note 的本机草稿；当前编辑保留。'); return }; setDevice(value) } catch (error) { setNotice(`本机草稿读取失败：${error instanceof Error ? error.message : String(error)}；原编辑保留。`) } }}>核对本机笔记草稿</button>}
    {device && editing.adoptDeviceDraft && <details open><summary>较新的本机草稿（当前编辑保留）</summary><pre>{device.draft}</pre><button type="button" onClick={adoptInspectedDevice}>保留当前编辑，采用本机草稿</button></details>}
    {remote && <details open><summary>当前原文件（草稿保留）</summary><RichContent content={remote.note.content} />{state.attempt?.phase !== 'sending' && <button type="button" onClick={() => {
      inspectionEpoch.current++
      const value = current.current, attempt = value.attempt
      persist({ ...value, attempt: undefined, ...(attempt ? { unconfirmed: [...value.unconfirmed ?? [], { content: attempt.content, expectedRevision: attempt.expectedRevision,
        ...(attempt.noteHistory ? { noteHistory: attempt.noteHistory } : {}), ...(attempt.written ? { written: attempt.written } : {}) }] } : {}), expectedRevision: remote.document.revision })
      setNotice('已选择当前修订；原保存记录与当前草稿保留，下次保存将以本草稿替换刚核对的原文。')
    }}>{state.attempt ? '保留原保存记录，以当前修订继续编辑' : '以当前修订继续保存本草稿'}</button>}</details>}
  </>}{formatIssue && <p role="status">{formatIssue}</p>}{notice && <p role="status">{notice}</p>}
    {state.attempt?.phase === 'written' && state.attempt.written && <details><summary>{state.attempt.canonicalContent === undefined ? '已保存，正文待核对' : '已保存，正在对齐后来的输入'}</summary><p>{state.attempt.canonicalContent === undefined ? state.attempt.written.contentUnavailable ?? '尚未读取该保存修订的准确正文。' : '保存正文已确认，后来的输入会按原提交基线合并；对齐前不会再次保存。'}</p><code>{state.attempt.written.revision}</code>{state.attempt.written.noteHistory?.eventId && <p>原保存事件：<code>{state.attempt.written.noteHistory.eventId}</code></p>}</details>}
    {!!state.unconfirmed?.length && <details><summary>原保存记录</summary>{state.unconfirmed.map((value, index) => <div key={index}><p>{value.written ? '此保存已确认，原提交与回执保留；后续保存不改写这次结果。' : '此保存的原回执仍未确认，后续保存不代签该结果。'}</p><code>{value.written?.revision ?? value.expectedRevision}</code>{(value.written?.noteHistory ?? value.noteHistory)?.eventId && <p>原事件：<code>{(value.written?.noteHistory ?? value.noteHistory)!.eventId}</code></p>}<pre>{value.content}</pre></div>)}</details>}{!!state.alternates?.length && <details><summary>另一个工作面的原编辑</summary>{state.alternates.map((value, index) => <pre key={index}>{value.draft}</pre>)}</details>}</>
}
