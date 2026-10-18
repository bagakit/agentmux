import { NoteLinkActions } from '@agentmux/client-ui/components/NoteLinkActions'
import { useNoteAttachments } from '../lib/use-note-attachments'
import { NoteFileContext, useNoteFileResource, resolveNoteSourceResource } from '@agentmux/client-ui/components/NoteFileContext'
import { retainNoteDraftEditor, retainNoteDraftNavigation, observeNoteDraftNavigation, notePendingSourceDecorations, observeNotePendingSource } from '../lib/note-share-staging'
import { NoteSharedContext } from '../lib/note-shared-context'
import { RovingToolbar, RovingToolbarButton } from './RovingToolbar'
import { createContext, lazy, Suspense, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type Ref } from 'react'
import { Decoration, Extension, isTextSelection, type Editor, type JSONContent } from '@tiptap/core'
import { EditorContent, NodeViewWrapper, ReactNodeViewRenderer, useEditor, useEditorState, type NodeViewProps } from '@tiptap/react'
import { useWorkbenchDocument } from '../lib/workbench-document'
import { desktopElementVisible } from '../lib/desktop-presentation'
import { semanticIconComponent } from '@agentmux/client-ui/icons'
import { NOTE_BLOCK_TYPES, NoteIncludeNode, NoteBlockReferenceNode, NoteInlineLinkNode, noteIdentityExtensions } from '../../../shared/note-content-schema'
import { NoteInlineLinkView, type NoteLinkOpenRequest } from '@agentmux/client-ui/components/NoteInlineLink'
import { noteWikiInputExtension } from '@agentmux/client-ui/note/note-wiki-input'
import { noteWikiLiteralExtension } from '@agentmux/client-ui/note/note-wiki-view'
import { NoteSnapshotSync } from '@agentmux/client-ui/note/note-snapshot-sync'
import type { NoteInlineLinkAttributes, NoteLinkTarget } from '@agentmux/core/note-links'
import { bindNoteWikiLink, noteInlineLinkContent, noteWikiTextTokens } from '@agentmux/client-ui/note/note-wikilinks'
import { useNoteWikiCompletion } from './NoteWikiCompletion'
import { serializeNoteDocument, type NoteInclude, type NoteBlockReference, type NoteBlockTarget, type NoteDocument } from '../../../shared/note-document'
import { noteRichContentExtensions } from '@agentmux/client-ui/components/NoteRichContent'
import { NoteInsertMenu } from '@agentmux/client-ui/components/NoteInsertMenu'
import { NoteTableTools } from '@agentmux/client-ui/components/NoteTableTools'
import { NoteBlockAuthors } from '@agentmux/client-ui/components/NoteBlockAuthors'
import { useAppStore } from '../store'
import { noteBacklinks, resolveNoteBlock, type NoteKnowledge, type NoteSource } from '../lib/note-knowledge'
import { useNoteSourceTitle } from '../lib/note-source-name'
import { MONACO_THEME_ID } from '../lib/monaco-theme'

const ReadonlyDiffEditor = lazy(() => import('./ReadonlyDiffEditor').then(module => ({ default: module.ReadonlyDiffEditor })))

const ThemeStatusCopiedIcon = semanticIconComponent('status.copied')
const ThemeObjectLinkIcon = semanticIconComponent('object.link')
const ThemeObjectHeadingIcon = semanticIconComponent('object.heading')
const ThemeObjectListIcon = semanticIconComponent('object.list')
const ThemeActionQuoteIcon = semanticIconComponent('action.quote')
const ThemeActionIndentIcon = semanticIconComponent('action.indent')
const ThemeActionOutdentIcon = semanticIconComponent('action.outdent')
const ThemeNavigationDownIcon = semanticIconComponent('navigation.down')


type ReferenceContextValue = { knowledge: NoteKnowledge; trail: readonly string[]; sourceName: (source: NoteSource) => string | undefined; onOpen: (source: NoteSource, blockId: string) => void; onOpenLink?: ((link: NoteLinkOpenRequest) => void) | undefined }
const ReferenceContext = createContext<ReferenceContextValue | null>(null)
const targetKey = (target: NoteBlockTarget) => JSON.stringify([target.noteId, target.blockId])
function referenceExtension() {
  return NoteBlockReferenceNode.extend({ addNodeView() { return ReactNodeViewRenderer(NoteReferenceView) } })
}
function includeExtension(readOnly = false) { return NoteIncludeNode.extend({ addNodeView() { return ReactNodeViewRenderer(readOnly ? ReadOnlyIncludeView : NoteIncludeView) } }) }
function ReadOnlyIncludeView({ node }: NodeViewProps) {
  const context = useContext(NoteSharedContext)
  return <NodeViewWrapper className="note-shared-block" contentEditable={false}>{context?.renderInclude(node.attrs as NoteInclude, () => {}, true) ?? <p role="status">The original shared content has not been read.</p>}</NodeViewWrapper>
}
function NoteIncludeView({ node, deleteNode }: NodeViewProps) {
  const context = useContext(NoteSharedContext)
  return <NodeViewWrapper className="note-shared-block" contentEditable={false} data-note-shared-id={node.attrs.noteId}>{context ? context.renderInclude(node.attrs as NoteInclude, deleteNode) : <p className="note-knowledge-notice" role="status">The original shared file is unavailable in this presentation. Its reference is kept.</p>}</NodeViewWrapper>
}
function inlineLinkExtension() { return NoteInlineLinkNode.extend({ addNodeView() { return ReactNodeViewRenderer(InlineLinkView) } }) }
function InlineLinkView({ node, editor }: NodeViewProps) {
  const context = useContext(ReferenceContext)
  return <NoteInlineLinkView node={node} editor={editor} onOpen={context?.onOpenLink} />
}

/** The canonical content schema plus two maintained identity allocators; read-only views use neither. */
export function noteEditorExtensions(folded: () => ReadonlySet<string> = () => new Set()) {
  return [
    ...noteRichContentExtensions().map(extension => extension.name === NoteIncludeNode.name ? includeExtension() : extension.name === NoteBlockReferenceNode.name ? referenceExtension() : extension.name === NoteInlineLinkNode.name ? inlineLinkExtension() : extension),
    ...noteIdentityExtensions(),
    Extension.create({
      name: 'noteBlockFold',
      addDecorations() { return { shouldUpdate: ({ tr }) => tr.docChanged || Boolean(tr.getMeta('noteFold')), create: ({ state }) => {
        const decorations: Decoration[] = [], current = folded()
        if (!current.size) return decorations
        state.doc.descendants((node, pos) => {
          if (current.has(node.attrs.blockId)) decorations.push(Decoration.Node(pos, pos + node.nodeSize, { class: 'note-block--folded' }))
        })
        return decorations
      } } }
    })
  ]
}

function NoteReferenceView({ node }: NodeViewProps) {
  const context = useContext(ReferenceContext)
  const parentResource = useNoteFileResource()
  const reference = node.attrs as NoteBlockReference
  if (!context) return <NodeViewWrapper className="note-reference" contentEditable={false}>Reference scope is not available.</NodeViewWrapper>
  if (!reference.target) return <NodeViewWrapper className="note-reference" contentEditable={false}><p className="note-knowledge-notice" role="status">
    The pasted reference target is unconfirmed. The canonical Note is preserved. Undo or remove this block to continue saving valid content.
  </p></NodeViewWrapper>
  const resolution = resolveNoteBlock(context.knowledge, reference.target), key = targetKey(reference.target)
  const cycle = context.trail.includes(key)
  const writtenSources = context.knowledge.sources.filter(source => source.note.noteId === reference.target.noteId)
  const navigationSource = writtenSources.length === 1 ? writtenSources[0]! : resolution.status === 'resolved' ? resolution.source : undefined
  return <NodeViewWrapper className={`note-reference note-reference--${reference.mode}`} contentEditable={false}>
    <div className="note-reference__source"><ThemeObjectLinkIcon size={13} /><span>{reference.mode === 'embed' ? 'Embedded block' : 'Block reference'}</span>
      {resolution.status === 'resolved' ? <button type="button" className="note-text-button" title={`${(navigationSource ?? resolution.source).location.workspaceId} · ${(navigationSource ?? resolution.source).location.path} · ${reference.target.blockId}`} aria-label={`Open original block in ${(navigationSource ?? resolution.source).location.workspaceId} · ${(navigationSource ?? resolution.source).location.path} · ${reference.target.blockId}`}
        onClick={() => context.onOpen(navigationSource ?? resolution.source, reference.target.blockId)}>{context.sourceName(navigationSource ?? resolution.source) ?? (navigationSource ?? resolution.source).location.path}<ThemeObjectLinkIcon size={12} /></button> : null}
    </div>
    {cycle ? <p className="note-knowledge-notice" role="status">This reference is circular. The original reference is preserved.</p>
      : resolution.status !== 'resolved' ? <p className="note-knowledge-notice" role="status">{resolution.message}</p>
      : reference.mode === 'embed' || resolution.block.content.type === 'noteInclude' ? <ReferenceContext.Provider value={{ ...context, trail: [...context.trail, key] }}>
        <NoteFileContext.Provider value={resolveNoteSourceResource(parentResource, resolution.source.location)}><ReadOnlyBlock content={resolution.block.content} /></NoteFileContext.Provider>
      </ReferenceContext.Provider> : <p className="note-reference__excerpt">{resolution.block.text || 'Empty block'}</p>}
  </NodeViewWrapper>
}

export function ReadOnlyBlock({ content }: { content: JSONContent }) {
  const ownerDocument = useWorkbenchDocument()
  const agentNames = useAppStore(state => state.agentNames)
  // A list item requires its schema container even when its subtree is the requested projection.
  const doc = useMemo(() => content.type === 'doc' ? content : ({ type: 'doc', content: [content.type === 'listItem' ? { type: 'bulletList', content: [content] } : content.type === 'taskItem' ? { type: 'taskList', content: [content] } : content] }), [content])
  const context = useContext(ReferenceContext), openLink = useRef(context?.onOpenLink); openLink.current = context?.onOpenLink
  const editor = useEditor({ extensions: [...noteRichContentExtensions().map(extension => extension.name === NoteIncludeNode.name ? includeExtension(true) : extension.name === NoteBlockReferenceNode.name ? referenceExtension() : extension.name === NoteInlineLinkNode.name ? inlineLinkExtension() : extension), noteWikiLiteralExtension(link => openLink.current?.(link))], content: doc, editable: false,
    editorProps: { attributes: { class: 'note-embedded-content', 'aria-label': 'Original block, read only' } } }, [])
  useLayoutEffect(() => { if (editor && !editor.isDestroyed) editor.view.updateRoot() }, [editor, ownerDocument])
  const [issue, setIssue] = useState<string | null>(null), snapshot = useRef<NoteSnapshotSync | null>(null)
  useEffect(() => {
    if (!editor) return
    const sync = new NoteSnapshotSync(editor, () => false, setIssue); snapshot.current = sync
    return () => { sync.destroy(); if (snapshot.current === sync) snapshot.current = null }
  }, [editor])
  useEffect(() => { snapshot.current?.update(doc) }, [editor, doc])
  return <>{issue && <p role="status">{issue} <button type="button" onClick={() => snapshot.current?.retry()}>Retry incoming update</button></p>}<NoteLinkActions editor={editor} /><EditorContent editor={editor} /><NoteBlockAuthors editor={editor} agentNames={agentNames} /></>
}

export type NoteEditorHandle = { onNavigationReady?: (listener: () => void) => () => void; editor: Editor; focusBlock: (blockId: string, focus?: boolean, reveal?: boolean) => boolean; bindLink: (link: NoteLinkOpenRequest, target: NoteLinkTarget) => boolean }
export function NoteBlockEditor({ note, knowledge, onChange, onOpen, onSave, onIssue, handleRef, onSelectedBlock, onOpenLink, onCompositionChange, onSnapshotIssue, onKeepDisplayedDraft, active = true, showBacklinks = true, sourceIdentity = note.noteId }: {
  note: NoteDocument; knowledge: NoteKnowledge; onChange: (raw: string, editorBefore?: string) => void; onOpen: (source: NoteSource, blockId: string) => void
  onSave: () => void; onIssue: (message: string | null) => void; handleRef?: Ref<NoteEditorHandle | null>; onSelectedBlock?: (target: NoteBlockTarget) => void
  onOpenLink?: ((link: NoteLinkOpenRequest) => void) | undefined; onCompositionChange?: ((composing: boolean) => void) | undefined; active?: boolean; showBacklinks?: boolean; sourceIdentity?: string
  onSnapshotIssue?: ((displayedRaw: string, incomingRaw: string, reason: string) => void) | undefined
  onKeepDisplayedDraft?: ((displayedRaw: string, incomingRaw: string) => void) | undefined
}) {
  const resource = useNoteFileResource()
  const attachments = useNoteAttachments(resource ?? undefined)
  const attachmentRef = useRef(attachments); attachmentRef.current = attachments
  const ownerDocument = useWorkbenchDocument()
  const agentNames = useAppStore(state => state.agentNames)
  const shared = useContext(NoteSharedContext), sharedRef = useRef(shared); sharedRef.current = shared
  const [beside, setBeside] = useState<{ position: number; top: number } | null>(null)
  const [copyFeedback, setCopyFeedback] = useState<{ position: number; message: string; accepted: boolean } | null>(null)
  useEffect(() => { if (!copyFeedback) return; const timeout = setTimeout(() => setCopyFeedback(null), 2500); return () => clearTimeout(timeout) }, [copyFeedback])
  const sourceName = useNoteSourceTitle()
  const props = useRef({ note, onChange, onSave, onIssue, onSelectedBlock, onCompositionChange, onSnapshotIssue, onKeepDisplayedDraft })
  props.current = { note, onChange, onSave, onIssue, onSelectedBlock, onCompositionChange, onSnapshotIssue, onKeepDisplayedDraft }
  const compositionBefore = useRef<JSONContent | null>(null)
  const composing = useRef(false), snapshot = useRef<NoteSnapshotSync | null>(null)
  const [mappingIssue, setMappingIssue] = useState<string | null>(null)
  const [mappingDrafts, setMappingDrafts] = useState<{ displayed: string; incoming: string } | null>(null), [compareIncoming, setCompareIncoming] = useState(false)
  const [selected, setSelected] = useState<string | null>(null)
  const [, setFoldRevision] = useState(0)
  const folded = useRef(new Set<string>())
  const wikiHandlers = useRef<{ created(link: NoteInlineLinkAttributes, previousReferenceId?: string): void; keyDown(event: KeyboardEvent): boolean; open(link: NoteLinkOpenRequest): void }>({ created() {}, keyDown: () => false, open() {} })
  const extensions = useMemo(() => [...noteEditorExtensions(() => folded.current), noteWikiInputExtension((link, previous) => wikiHandlers.current.created(link, previous)), noteWikiLiteralExtension(link => wikiHandlers.current.open(link))], [])
  const publishContent = (editor: Editor, before: JSONContent) => {
    // The IME owns its intermediate text. Wiki attributes are canonicalized only
    // after composition ends, before this original onChange publishes a draft.
    if (editor.view.composing) return
    const current = props.current
    let raw: string, editorBefore: string
    // Serialization validates the original schema and identities. Re-parsing the
    // emitted Markdown here would run the full reading pipeline on every key.
    try {
      raw = serializeNoteDocument({ ...current.note, content: editor.getJSON() })
      editorBefore = serializeNoteDocument({ ...current.note, content: before })
    }
    catch (error) { current.onIssue(error instanceof Error ? error.message : String(error)); return }
    current.onIssue(null)
    current.onChange(raw, editorBefore)
    if (!editor.isDestroyed && editor.view.hasFocus()) {
      const selection = editor.state.selection, blockId = selection.$from.parent.attrs.blockId ?? editor.state.doc.nodeAt(selection.from)?.attrs.blockId
      if (typeof blockId === 'string') current.onSelectedBlock?.({ noteId: current.note.noteId, blockId })
    }
  }
  const editorRef = useRef<Editor | null>(null)
  const pendingSourceKey = useRef({ fileKey: shared?.fileKey, noteId: note.noteId }); pendingSourceKey.current = { fileKey: shared?.fileKey, noteId: note.noteId }
  const pendingSource = useMemo(() => Extension.create({ name: 'notePendingSource', addDecorations() { return { shouldUpdate: ({ tr }) => tr.docChanged || Boolean(tr.getMeta('notePendingSource')), create: ({ state }) => { const source = pendingSourceKey.current; return source.fileKey ? notePendingSourceDecorations(source.fileKey, source.noteId, state.doc) : [] } } } }), [])
  const editor = useEditor({ extensions: [...extensions, pendingSource], content: note.content, editorProps: {
    attributes: { class: 'note-block-content', role: 'textbox', 'aria-label': 'Note blocks', 'aria-multiline': 'true' },
    handlePaste(_view, event) {
      const current = editorRef.current
      if (!current) return false
      if (sharedRef.current?.paste(current, event)) return true
      const files = Array.from(event.clipboardData?.files ?? [])
      if (!files.length) return false
      event.preventDefault(); attachmentRef.current.importFiles(files, current); return true
    },
    handleDOMEvents: { compositionstart(view) { if (!composing.current) { compositionBefore.current = view.state.doc.toJSON(); composing.current = true; snapshot.current?.pause(); props.current.onCompositionChange?.(true) }; return false } },
    handleKeyDown(view, event) {
      if (event.isComposing || view.composing) return false
      if (wikiHandlers.current.keyDown(event)) return true
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') { event.preventDefault(); props.current.onSave(); return true }
      if (event.key === 'Backspace' && !event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey) {
        const { selection, doc } = view.state
        if (isTextSelection(selection) && selection.empty && selection.$from.depth === 1 && selection.$from.index(0) === 0
          && selection.$from.parent.type.name === 'paragraph' && selection.$from.parent.content.size === 0 && doc.childCount > 1) {
          // Backward join has no preceding block here. Remove only this empty
          // paragraph so the next block keeps its own identity and attribution.
          view.dispatch(view.state.tr.delete(0, selection.$from.parent.nodeSize).scrollIntoView())
          return true
        }
      }
      return false
    }
  }, onSelectionUpdate({ editor, transaction }) {
    const { $from } = editor.state.selection
    let id: string | null = null
    for (let depth = $from.depth; depth > 0; depth--) { if ($from.node(depth).attrs.blockId) { id = $from.node(depth).attrs.blockId; break } }
    if (!id) id = editor.state.doc.nodeAt(editor.state.selection.from)?.attrs.blockId ?? null
    setSelected(id)
    if (id && !transaction.getMeta('noteSelectionRestore') && !editor.isDestroyed && editor.view.hasFocus()) props.current.onSelectedBlock?.({ noteId: props.current.note.noteId, blockId: id })
  }, onTransaction({ editor, transaction }) {
    if (transaction.getMeta('noteSharedReceiptEcho')) snapshot.current?.pause()
    // The original wiki plugin completes normalization before this event. Publish
    // final local input before the owner recomputes a queued incoming snapshot.
    if (transaction.getMeta('noteWikiCompositionEnd') && !editor.view.composing) {
      publishContent(editor, compositionBefore.current ?? transaction.before.toJSON())
      compositionBefore.current = null
      if (composing.current) { composing.current = false; props.current.onCompositionChange?.(false) }
    }
  }, onUpdate({ editor, transaction }) {
    if (!composing.current && !transaction.getMeta('noteWikiCompositionEnd')) publishContent(editor, transaction.before.toJSON())
  } }, [note.noteId])
  editorRef.current = editor
  useEffect(() => {
    if (editor && shared?.focusedEditor === editor) shared.focusEditor(editor, attachments)
  }, [editor, shared?.focusedEditor, shared?.focusEditor, attachments.importFiles, attachments.pending])
  useEffect(() => editor && shared?.fileKey ? retainNoteDraftEditor(shared.fileKey, editor) : undefined, [editor, shared?.fileKey])
  useEffect(() => editor && shared?.fileKey ? observeNotePendingSource(shared.fileKey, note.noteId, editor, () => { if (!editor.isDestroyed) editor.view.dispatch(editor.state.tr.setMeta('notePendingSource', true)) }) : undefined, [editor, shared?.fileKey, note.noteId])
  useLayoutEffect(() => {
    if (!editor || editor.isDestroyed) return
    const updateRoot = () => { if (!editor.isDestroyed) editor.view.updateRoot() }
    updateRoot()
    editor.on('mount', updateRoot)
    return () => { editor.off('mount', updateRoot) }
  }, [editor, ownerDocument])
  const wiki = useNoteWikiCompletion(editor, active, sourceIdentity)
  wikiHandlers.current = { created: wiki.created, keyDown: wiki.keyDown, open: link => {
    if (!editor || editor.isDestroyed || !active) return
    if (!link.referenceId && link.rawRange) {
      const { from, to } = link.rawRange
      if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || to > editor.state.doc.content.size || from >= to) return
      const at = editor.state.doc.resolve(from), block = at.parent
      const token = block.type.name !== 'codeBlock' && noteWikiTextTokens(block.toJSON().content ?? []).find(token => at.start() + token.from === from && at.start() + token.to === to && token.text === link.text)
      if (!token) { props.current.onIssue('The original link text changed. Your draft is kept; choose the current link again.'); return }
      const stored = { referenceId: crypto.randomUUID(), text: link.text, target: null }
      editor.view.dispatch(editor.state.tr.replaceWith(from, to, editor.schema.nodeFromJSON({ ...noteInlineLinkContent(stored), marks: at.marks().map(mark => mark.toJSON()) })))
      onOpenLink?.(stored); return
    }
    onOpenLink?.(link)
  } }

  useEffect(() => {
    if (!editor) return
    const noteId = note.noteId
    const sync = new NoteSnapshotSync(editor, () => composing.current, (message, pair) => {
      if (props.current.note.noteId !== noteId) return
      setMappingIssue(message); props.current.onIssue(message)
      if (!message) { setMappingDrafts(null); setCompareIncoming(false) }
      else if (pair) {
        try {
          const current = props.current
          const incoming = serializeNoteDocument({ ...current.note, content: pair.incoming })
          if (incoming !== serializeNoteDocument(current.note)) return
          const displayed = serializeNoteDocument({ ...current.note, content: pair.displayed })
          setMappingDrafts({ displayed, incoming }); current.onSnapshotIssue?.(displayed, incoming, message)
        } catch (error) { props.current.onIssue(error instanceof Error ? error.message : String(error)) }
      }
    })
    snapshot.current = sync
    return () => { sync.destroy(); if (snapshot.current === sync) snapshot.current = null }
  }, [editor])
  useEffect(() => {
    if (!editor) return
    snapshot.current?.update(note.content)
  }, [editor, note.content])
  useEffect(() => {
    const clear = () => { compositionBefore.current = null; if (composing.current) { composing.current = false; props.current.onCompositionChange?.(false) } }
    editor?.on('unmount', clear)
    return () => { editor?.off('unmount', clear); clear() }
  }, [editor])
  useEffect(() => {
    const publish = (handle: NoteEditorHandle | null) => {
      if (typeof handleRef === 'function') handleRef(handle)
      else if (handleRef) handleRef.current = handle
    }
    let releaseNavigation: (() => void) | undefined
    const detach = () => { releaseNavigation?.(); releaseNavigation = undefined; publish(null) }
    if (!editor) { detach(); return }
    const attach = () => {
      // An Editor identity may survive without its view. Re-publish on every
      // real mount so retained restore/reveal/focus requests can resume.
      if (editor.isDestroyed) { detach(); return }
      const handle: NoteEditorHandle = { editor, onNavigationReady(listener) { return sharedRef.current ? observeNoteDraftNavigation(sharedRef.current.occurrence, listener) : () => {} }, bindLink(link, target) {
        if (editor.isDestroyed || !link.referenceId) return false
        const original = { ...props.current.note, content: editor.getJSON() }
        const bound = bindNoteWikiLink(original, { referenceId: link.referenceId, text: link.text, target })
        if (bound === original) return false
        let position: number | null = null
        editor.state.doc.descendants((node, pos) => { if (node.type.name === 'noteLink' && node.attrs.referenceId === link.referenceId) { position = pos; return false } })
        if (position === null) return false
        editor.view.dispatch(editor.state.tr.setNodeMarkup(position, undefined, { referenceId: link.referenceId, text: link.text, target }).setMeta('addToHistory', false))
        return true
      }, focusBlock(blockId, focus = true, reveal = false) {
        if (editor.isDestroyed) return false
        let position: number | null = null, blockPosition: number | null = null, textblock = false, include: NoteInclude | null = null
        let declarations = 0
        editor.state.doc.descendants(node => {
          if (node.attrs.blockId === blockId) declarations++
          if (node.type.name === 'noteInclude') for (const forwarded of node.attrs.forwardedBlockIds ?? []) if (forwarded === blockId) { declarations++; include = node.attrs as NoteInclude }
        })
        if (declarations !== 1) return false
        if (include) return sharedRef.current?.focusIncludedBlock(include, blockId, focus, reveal) ?? false
        editor.state.doc.descendants((node, pos) => { if (node.attrs.blockId === blockId) { blockPosition = pos; position = node.isTextblock ? pos + 1 : pos; textblock = node.isTextblock; return false } })
        if (position === null) return false
        if (reveal && !desktopElementVisible(editor.view.dom)) return false
        let unfolded = false
        if (reveal) {
          const at = editor.state.doc.resolve(position)
          for (let depth = at.depth; depth > 0; depth--) {
            const id: unknown = at.node(depth).attrs.blockId
            if (typeof id === 'string' && folded.current.delete(id)) unfolded = true
          }
          const id: unknown = editor.state.doc.nodeAt(blockPosition!)?.attrs.blockId
          if (typeof id === 'string' && folded.current.delete(id)) unfolded = true
        }
        const selection = editor.chain().setMeta('noteSelectionRestore', true)
        if (unfolded) { selection.setMeta('noteFold', true); setFoldRevision(value => value + 1) }
        if (textblock) selection.setTextSelection(position); else selection.setNodeSelection(position)
        selection.run()
        // ProseMirror intentionally ignores scrollToSelection while DOM focus is elsewhere.
        // Explicit navigation reveals the DOM for the exact confirmed model position without taking caret focus.
        if (reveal && blockPosition !== null) {
          const element = editor.view.nodeDOM(blockPosition)
          if (!element || element.nodeType !== 1 || !desktopElementVisible(element as HTMLElement)) return false
          const blockElement = element as HTMLElement
          blockElement.scrollIntoView({ block: 'center', inline: 'nearest' })
        }
        if (!focus) return true
        editor.view.focus()
        return editor.view.dom === editor.view.dom.ownerDocument.activeElement || editor.view.dom.contains(editor.view.dom.ownerDocument.activeElement)
      } }
      publish(handle)
      releaseNavigation?.()
      const scope = sharedRef.current
      if (scope) releaseNavigation = retainNoteDraftNavigation(scope.occurrence, scope.fileKey, handle)
    }
    editor.on('mount', attach).on('unmount', detach).on('destroy', detach)
    attach()
    return () => { editor.off('mount', attach).off('unmount', detach).off('destroy', detach); detach() }
  }, [editor, handleRef])
  const actionEditor = shared?.focusedEditor && !shared.focusedEditor.isDestroyed ? shared.focusedEditor : editor
  const actionAttachments = actionEditor === editor ? attachments : shared?.focusedAttachments
  const formatting = useEditorState({ editor: actionEditor, selector: () => {
    // The focused original is already authoritative when this render switches
    // editors, before the new editor's next subscribed transaction.
    const editor = actionEditor
    let listItem: 'listItem' | 'taskItem' = 'listItem'
    if (editor && !editor.isDestroyed) {
      const { $from } = editor.state.selection
      for (let depth = $from.depth; depth > 0; depth--) {
        const type = $from.node(depth).type.name
        if (type === 'listItem' || type === 'taskItem') { listItem = type; break }
      }
    }
    return {
      heading: editor && !editor.isDestroyed ? editor.isActive('heading', { level: 1 }) : false,
      list: editor && !editor.isDestroyed ? editor.isActive('bulletList') : false,
      quote: editor && !editor.isDestroyed ? editor.isActive('blockquote') : false,
      listItem,
      indent: editor && !editor.isDestroyed ? editor.can().sinkListItem(listItem) : false,
      outdent: editor && !editor.isDestroyed ? editor.can().liftListItem(listItem) : false,
      from: editor?.state.selection.from, to: editor?.state.selection.to
    }
  } })
  const backlinks = selected ? noteBacklinks(knowledge, { noteId: note.noteId, blockId: selected }) : []
  const foldTarget = () => {
    if (!editor || editor.isDestroyed) return null
    const { $from } = editor.state.selection
    for (let depth = $from.depth; depth > 0; depth--) { const node = $from.node(depth); if (node.attrs.blockId && node.childCount > 1 && !node.isTextblock) return String(node.attrs.blockId) }
    return null
  }
  const foldId = actionEditor === editor ? foldTarget() : null
  const showBlockAction = (position: number) => {
    if (!editor || editor.isDestroyed) return
    const node = editor.state.doc.nodeAt(position)
    if (!node || !NOTE_BLOCK_TYPES.includes(node.type.name as typeof NOTE_BLOCK_TYPES[number])) return
    const element = editor.view.nodeDOM(position)
    if (!(element instanceof ownerDocument.defaultView!.HTMLElement)) return
    const top = element.getBoundingClientRect().top - editor.view.dom.parentElement!.getBoundingClientRect().top
    setCopyFeedback(value => value?.position === position ? value : null)
    setBeside(value => value?.position === position && value.top === top ? value : { position, top })
  }
  const showSelectedAction = () => {
    if (!editor || editor.isDestroyed) return
    const at = editor.state.selection.$from
    if (at.depth) showBlockAction(at.before(at.depth))
    else showBlockAction(editor.state.selection.from)
  }
  useEffect(() => { if (editor && !editor.isDestroyed && editor.view.hasFocus()) showSelectedAction() }, [editor, formatting?.from, formatting?.to])
  return <ReferenceContext.Provider value={{ knowledge: shared?.knowledge ?? knowledge, trail: [], sourceName, onOpen, onOpenLink }}><div className="note-editor" data-note-empty={note.content.content?.length === 1 && note.content.content[0]?.type === 'paragraph' && !note.content.content[0].content?.length}>
    {mappingIssue && <section className="note-knowledge-notice" aria-label="Incoming update recovery">
      <p>Both drafts are kept. If blocks moved or cannot be matched reliably, compare the drafts and choose which one to continue editing.</p>
      <button type="button" className="small-button" onClick={() => snapshot.current?.retry()}>Retry incoming update</button>
      {mappingDrafts && <>
        <button type="button" className="small-button" aria-expanded={compareIncoming} onClick={() => setCompareIncoming(value => !value)}>Compare incoming update</button>
        {onKeepDisplayedDraft && <button type="button" className="small-button" onClick={() => {
          if (!editor || editor.isDestroyed || composing.current || editor.view.composing) return
          const current = props.current
          if (mappingDrafts.incoming !== serializeNoteDocument(current.note)) return
          current.onKeepDisplayedDraft?.(serializeNoteDocument({ ...current.note, content: editor.getJSON() }), mappingDrafts.incoming)
        }}>Keep editing displayed draft</button>}
        {compareIncoming && <><p>Displayed draft → incoming draft · read only. Source shows the incoming draft; retained drafts remain available.</p><div className="note-version-history__diff"><Suspense fallback={<p role="status">Opening draft comparison…</p>}><ReadonlyDiffEditor original={mappingDrafts.displayed} modified={mappingDrafts.incoming} wordWrap language="markdown" theme={MONACO_THEME_ID} /></Suspense></div></>}
      </>}
    </section>}
    <RovingToolbar className="note-editor__tools" aria-label="Note block tools">
      <div className="note-editor__tool-group" role="group" aria-label="Block style">
        <RovingToolbarButton type="button" className="note-tool" title="Heading" aria-label="Heading" aria-pressed={formatting?.heading ?? false} onClick={() => actionEditor?.chain().focus().toggleHeading({ level: 1 }).run()}><ThemeObjectHeadingIcon size={15} /></RovingToolbarButton>
        <RovingToolbarButton type="button" className="note-tool" title="Bullet list" aria-label="Bullet list" aria-pressed={formatting?.list ?? false} onClick={() => actionEditor?.chain().focus().toggleBulletList().run()}><ThemeObjectListIcon size={15} /></RovingToolbarButton>
        <RovingToolbarButton type="button" className="note-tool" title="Quote" aria-label="Quote" aria-pressed={formatting?.quote ?? false} onClick={() => actionEditor?.chain().focus().toggleBlockquote().run()}><ThemeActionQuoteIcon size={15} /></RovingToolbarButton>
      </div>
      <div className="note-editor__tool-group" role="group" aria-label="Block structure">
        <RovingToolbarButton type="button" className="note-tool" title="Indent block" aria-label="Indent block" disabled={!formatting?.indent} onClick={() => actionEditor?.chain().focus().sinkListItem(formatting?.listItem ?? 'listItem').run()}><ThemeActionIndentIcon size={15} /></RovingToolbarButton>
        <RovingToolbarButton type="button" className="note-tool" title="Outdent block" aria-label="Outdent block" disabled={!formatting?.outdent} onClick={() => actionEditor?.chain().focus().liftListItem(formatting?.listItem ?? 'listItem').run()}><ThemeActionOutdentIcon size={15} /></RovingToolbarButton>
        <RovingToolbarButton type="button" className="note-tool" title="Fold or unfold nested blocks" aria-label="Fold or unfold nested blocks" disabled={!foldId} aria-pressed={foldId ? folded.current.has(foldId) : false} onClick={() => {
          if (!editor || !foldId) return
          if (folded.current.has(foldId)) folded.current.delete(foldId); else folded.current.add(foldId)
          editor.view.dispatch(editor.state.tr.setMeta('noteFold', true)); setFoldRevision(value => value + 1)
        }}><ThemeNavigationDownIcon size={15} /></RovingToolbarButton>
      </div>
      <NoteInsertMenu editor={actionEditor} {...(actionAttachments ? { onImportFiles: actionAttachments.importFiles, importing: actionAttachments.pending } : {})} />
      {actionEditor && <NoteTableTools editor={actionEditor} />}
    </RovingToolbar>
    {attachments.pending && <p className="note-knowledge-notice" role="status">Copying attachments to this Note’s folder…</p>}
    {attachments.issue && <p className="note-knowledge-notice" role="status">{attachments.issue} <button type="button" className="note-text-button" onClick={attachments.dismiss}>Dismiss</button></p>}
    <div className="note-editor__body" onFocus={event => { if (editor && (event.target as HTMLElement).closest('.note-block-content') === editor.view.dom) { shared?.focusEditor(editor, attachments); showSelectedAction() } }} onPointerMove={event => {
      if (!editor || editor.isDestroyed || !(event.target instanceof ownerDocument.defaultView!.Element)) return
      const element = event.target.closest('p,h1,h2,h3,h4,h5,h6,li,blockquote,pre,hr,[data-note-include]')
      if (!element || element.closest('.note-block-content') !== editor.view.dom) return
      const at = editor.state.doc.resolve(editor.view.posAtDOM(element, 0))
      showBlockAction(at.depth ? at.before(at.depth) : Math.max(0, editor.view.posAtDOM(element, 0)))
    }}>
      {shared && <button type="button" className="note-block-action" aria-label={copyFeedback?.accepted ? 'Reference copied' : 'Copy shared block reference'} title={copyFeedback?.message ?? 'Copy shared block reference'} data-copy-feedback={copyFeedback ? copyFeedback.accepted ? 'copied' : 'failed' : undefined} style={{ top: beside?.top ?? 0 }} onMouseDown={event => event.preventDefault()} onFocus={() => { if (!beside) showSelectedAction() }} onClick={() => {
        if (!editor || editor.isDestroyed) return
        const at = editor.state.selection.$from, position = beside?.position ?? (at.depth ? at.before(at.depth) : editor.state.selection.from)
        void shared.copyBlock(editor, position).then(() => setCopyFeedback({ position, accepted: true, message: 'Copied · paste to share' })).catch(error => { const message = error instanceof Error ? error.message : String(error); setCopyFeedback({ position, accepted: false, message }); props.current.onIssue(message) })
      }}>{copyFeedback?.accepted ? <ThemeStatusCopiedIcon size={13} /> : <ThemeObjectLinkIcon size={13} />}</button>}
      {copyFeedback && <span className="note-block-copy-feedback" role="status" data-failed={!copyFeedback.accepted || undefined} style={{ top: beside?.top ?? 0 }}>{copyFeedback.message}</span>}
      <NoteLinkActions editor={editor} /><EditorContent editor={editor} /><NoteBlockAuthors editor={editor} agentNames={agentNames} />
    </div>
    {wiki.popup}
    {showBacklinks ? <details className="note-backlinks"><summary>Backlinks{selected && backlinks.length ? ` · ${backlinks.length}` : ''}<span>{knowledge.scope === 'complete' ? 'Confirmed scope' : 'Partial scope'}</span></summary>
      {selected ? backlinks.length ? backlinks.map(link => <button type="button" className="note-backlink" key={JSON.stringify([link.source.location.workspaceId, link.source.location.path, link.occurrence])}
        title={`${link.source.location.workspaceId} · ${link.source.location.path} · ${link.blockId}`} aria-label={`Open ${link.source.location.workspaceId} · ${link.source.location.path} · ${link.blockId}`}
        onClick={() => onOpen(link.source, link.blockId)}><span>{sourceName(link.source) ?? link.source.location.path}</span><small>{link.mode === 'embed' ? 'Embedded block' : 'Block reference'}</small></button>)
        : <p className="note-scope">{knowledge.scope === 'complete' ? 'No references in the confirmed scope.' : 'No references found among loaded Notes. Unread sources are not counted.'}</p>
        : <p className="note-scope">Select a block to see its exact incoming references.</p>}
      {knowledge.invalid.length ? <p className="note-knowledge-notice" role="status">{knowledge.invalid.length} Note file could not be indexed. Its original source is preserved.</p> : null}
    </details> : null}
  </div></ReferenceContext.Provider>
}
