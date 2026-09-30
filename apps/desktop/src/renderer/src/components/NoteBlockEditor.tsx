import { createContext, useContext, useEffect, useMemo, useRef, useState, type Ref } from 'react'
import { Decoration, Extension, type Editor, type JSONContent } from '@tiptap/core'
import UniqueID from '@tiptap/extension-unique-id'
import { EditorContent, NodeViewWrapper, ReactNodeViewRenderer, useEditor, type NodeViewProps } from '@tiptap/react'
import { ChevronDown, CornerDownRight, Link2, List, IndentDecrease, IndentIncrease, Quote } from 'lucide-react'
import { NOTE_BLOCK_TYPES, NoteBlockReferenceNode, noteContentExtensions } from '../../../shared/note-content-schema'
import { readNoteDocument, type NoteBlockReference, type NoteBlockTarget, type NoteDocument } from '../../../shared/note-document'
import { noteBacklinks, resolveNoteBlock, type NoteKnowledge, type NoteSource } from '../lib/note-knowledge'

type ReferenceContextValue = { knowledge: NoteKnowledge; trail: readonly string[]; onOpen: (source: NoteSource, blockId: string) => void }
const ReferenceContext = createContext<ReferenceContextValue | null>(null)
const targetKey = (target: NoteBlockTarget) => JSON.stringify([target.noteId, target.blockId])

function referenceExtension() {
  return NoteBlockReferenceNode.extend({ addNodeView() { return ReactNodeViewRenderer(NoteReferenceView) } })
}

/** The canonical content schema plus two maintained identity allocators; read-only views use neither. */
export function noteEditorExtensions(folded: () => ReadonlySet<string> = () => new Set()) {
  return [
    ...noteContentExtensions().map(extension => extension.name === NoteBlockReferenceNode.name ? referenceExtension() : extension),
    UniqueID.extend({ name: 'noteBlockUniqueId' }).configure({ attributeName: 'blockId', types: [...NOTE_BLOCK_TYPES] }),
    UniqueID.extend({ name: 'noteReferenceUniqueId' }).configure({ attributeName: 'referenceId', types: [NoteBlockReferenceNode.name] }),
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
  const reference = node.attrs as NoteBlockReference
  if (!context) return <NodeViewWrapper className="note-reference" contentEditable={false}>Reference scope is not available.</NodeViewWrapper>
  if (!reference.target) return <NodeViewWrapper className="note-reference" contentEditable={false}><p className="note-knowledge-notice" role="status">
    The pasted reference target is unconfirmed. The canonical Note is preserved. Undo or remove this block to continue saving valid content.
  </p></NodeViewWrapper>
  const resolution = resolveNoteBlock(context.knowledge, reference.target), key = targetKey(reference.target)
  const cycle = context.trail.includes(key)
  return <NodeViewWrapper className={`note-reference note-reference--${reference.mode}`} contentEditable={false}>
    <div className="note-reference__source"><Link2 size={13} /><span>{reference.mode === 'embed' ? 'Embedded block' : 'Block reference'}</span>
      {resolution.status === 'resolved' ? <button type="button" className="note-text-button" title={`${resolution.source.location.workspaceId} · ${resolution.source.location.path} · ${reference.target.blockId}`} aria-label={`Open original block in ${resolution.source.location.workspaceId} · ${resolution.source.location.path} · ${reference.target.blockId}`}
        onClick={() => context.onOpen(resolution.source, reference.target.blockId)}>{resolution.source.location.path}<CornerDownRight size={12} /></button> : null}
    </div>
    {cycle ? <p className="note-knowledge-notice" role="status">This reference is circular. The original reference is preserved.</p>
      : resolution.status !== 'resolved' ? <p className="note-knowledge-notice" role="status">{resolution.message}</p>
      : reference.mode === 'embed' ? <ReferenceContext.Provider value={{ ...context, trail: [...context.trail, key] }}>
        <ReadOnlyBlock content={resolution.block.content} />
      </ReferenceContext.Provider> : <p className="note-reference__excerpt">{resolution.block.text || 'Empty block'}</p>}
  </NodeViewWrapper>
}

function ReadOnlyBlock({ content }: { content: JSONContent }) {
  // A list item requires its schema container even when its subtree is the requested projection.
  const doc = useMemo(() => ({ type: 'doc', content: [content.type === 'listItem' ? { type: 'bulletList', content: [content] } : content] }), [content])
  const editor = useEditor({ extensions: noteContentExtensions().map(extension => extension.name === NoteBlockReferenceNode.name ? referenceExtension() : extension), content: doc, editable: false,
    editorProps: { attributes: { class: 'note-embedded-content', 'aria-label': 'Original block, read only' } } }, [])
  useEffect(() => { if (editor && JSON.stringify(editor.getJSON()) !== JSON.stringify(doc)) editor.commands.setContent(doc, { emitUpdate: false }) }, [editor, doc])
  return <EditorContent editor={editor} />
}

export type NoteEditorHandle = { editor: Editor; focusBlock: (blockId: string, focus?: boolean) => boolean }
export function NoteBlockEditor({ note, knowledge, onChange, onOpen, onSave, onIssue, handleRef, onSelectedBlock }: {
  note: NoteDocument; knowledge: NoteKnowledge; onChange: (raw: string) => void; onOpen: (source: NoteSource, blockId: string) => void
  onSave: () => void; onIssue: (message: string | null) => void; handleRef?: Ref<NoteEditorHandle | null>; onSelectedBlock?: (target: NoteBlockTarget) => void
}) {
  const props = useRef({ note, onChange, onSave, onIssue, onSelectedBlock })
  props.current = { note, onChange, onSave, onIssue, onSelectedBlock }
  const [selected, setSelected] = useState<string | null>(null), [picker, setPicker] = useState(false), [query, setQuery] = useState('')
  const [, setFoldRevision] = useState(0)
  const folded = useRef(new Set<string>())
  const extensions = useMemo(() => noteEditorExtensions(() => folded.current), [])
  const editor = useEditor({ extensions, content: note.content, editorProps: {
    attributes: { class: 'note-block-content', role: 'textbox', 'aria-label': 'Note blocks', 'aria-multiline': 'true' },
    handleKeyDown(view, event) {
      if (event.isComposing || view.composing) return false
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') { event.preventDefault(); props.current.onSave(); return true }
      return false
    }
  }, onSelectionUpdate({ editor, transaction }) {
    const { $from } = editor.state.selection
    let id: string | null = null
    for (let depth = $from.depth; depth > 0; depth--) { if ($from.node(depth).attrs.blockId) { id = $from.node(depth).attrs.blockId; break } }
    if (!id) id = editor.state.doc.nodeAt(editor.state.selection.from)?.attrs.blockId ?? null
    setSelected(id)
    if (id && !transaction.getMeta('noteSelectionRestore') && editor.view.hasFocus()) props.current.onSelectedBlock?.({ noteId: props.current.note.noteId, blockId: id })
  }, onUpdate({ editor }) {
    const current = props.current, raw = JSON.stringify({ ...current.note, content: editor.getJSON() }, null, 2) + '\n'
    const read = readNoteDocument(raw)
    if (read.status === 'invalid') { current.onIssue(read.message); return }
    current.onIssue(null)
    current.onChange(raw)
    if (editor.view.hasFocus()) {
      const selection = editor.state.selection, blockId = selection.$from.parent.attrs.blockId ?? editor.state.doc.nodeAt(selection.from)?.attrs.blockId
      if (typeof blockId === 'string') current.onSelectedBlock?.({ noteId: current.note.noteId, blockId })
    }
  } }, [note.noteId])

  useEffect(() => {
    if (!editor || JSON.stringify(editor.getJSON()) === JSON.stringify(note.content)) return
    const selection = editor.state.selection, blockId = selection.$from.parent.attrs.blockId, offset = selection.$from.parentOffset
    editor.chain().setMeta('noteSelectionRestore', true).setContent(note.content, { emitUpdate: false }).run()
    if (typeof blockId === 'string') editor.state.doc.descendants((node, pos) => {
      if (node.attrs.blockId === blockId && node.isTextblock) { editor.chain().setMeta('noteSelectionRestore', true).setTextSelection(pos + 1 + Math.min(offset, node.content.size)).run(); return false }
    })
  }, [editor, note.content])
  useEffect(() => {
    const handle: NoteEditorHandle | null = editor ? { editor, focusBlock(blockId, focus = true) {
      let position: number | null = null, textblock = false
      editor.state.doc.descendants((node, pos) => { if (node.attrs.blockId === blockId) { position = node.isTextblock ? pos + 1 : pos; textblock = node.isTextblock; return false } })
      if (position === null) return false
      const selection = editor.chain().setMeta('noteSelectionRestore', true)
      if (textblock) selection.setTextSelection(position); else selection.setNodeSelection(position)
      selection.run()
      if (!focus) return true
      editor.view.focus()
      return editor.view.dom === document.activeElement || editor.view.dom.contains(document.activeElement)
    } } : null
    if (typeof handleRef === 'function') { handleRef(handle); return () => { handleRef(null) } }
    if (handleRef) { handleRef.current = handle; return () => { handleRef.current = null } }
  }, [editor, handleRef])
  const backlinks = selected ? noteBacklinks(knowledge, { noteId: note.noteId, blockId: selected }) : []
  const candidates = useMemo(() => {
    if (!picker) return []
    const identityCounts = new Map<string, number>(), match = query.toLowerCase()
    for (const source of knowledge.sources) identityCounts.set(source.note.noteId, (identityCounts.get(source.note.noteId) ?? 0) + 1)
    return knowledge.sources.flatMap(source => identityCounts.get(source.note.noteId) !== 1 ? [] : [...source.blocks.values()].flatMap(block =>
      `${source.location.path} ${block.text}`.toLowerCase().includes(match) ? [{ source, block, target: { noteId: source.note.noteId, blockId: block.blockId } }] : []))
  }, [picker, knowledge, query])
  const foldTarget = () => {
    if (!editor) return null
    const { $from } = editor.state.selection
    for (let depth = $from.depth; depth > 0; depth--) { const node = $from.node(depth); if (node.attrs.blockId && node.childCount > 1 && !node.isTextblock) return String(node.attrs.blockId) }
    return null
  }
  const foldId = foldTarget()
  const insertReference = (target: NoteBlockTarget, mode: NoteBlockReference['mode']) => {
    if (!editor) return
    editor.chain().focus().insertContent({ type: 'blockReference', attrs: { target, mode } }).run()
    setPicker(false); setQuery('')
  }
  return <ReferenceContext.Provider value={{ knowledge, trail: [], onOpen }}><div className="note-editor">
    <div className="note-editor__tools" role="toolbar" aria-label="Note block tools">
      <button type="button" className="note-tool" title="Bullet list" aria-label="Bullet list" onClick={() => editor?.chain().focus().toggleBulletList().run()}><List size={15} /></button>
      <button type="button" className="note-tool" title="Indent block" aria-label="Indent block" disabled={!editor?.can().sinkListItem('listItem')} onClick={() => editor?.chain().focus().sinkListItem('listItem').run()}><IndentIncrease size={15} /></button>
      <button type="button" className="note-tool" title="Outdent block" aria-label="Outdent block" disabled={!editor?.can().liftListItem('listItem')} onClick={() => editor?.chain().focus().liftListItem('listItem').run()}><IndentDecrease size={15} /></button>
      <button type="button" className="note-tool" title="Quote" aria-label="Quote" onClick={() => editor?.chain().focus().toggleBlockquote().run()}><Quote size={15} /></button>
      <button type="button" className="note-tool" title="Fold or unfold nested blocks" aria-label="Fold or unfold nested blocks" disabled={!foldId} aria-pressed={foldId ? folded.current.has(foldId) : false} onClick={() => {
        if (!editor || !foldId) return
        if (folded.current.has(foldId)) folded.current.delete(foldId); else folded.current.add(foldId)
        editor.view.dispatch(editor.state.tr.setMeta('noteFold', true)); setFoldRevision(value => value + 1)
      }}><ChevronDown size={15} /></button>
      <button type="button" className="note-tool note-tool--label" aria-expanded={picker} onClick={() => setPicker(value => !value)}><Link2 size={14} /> Reference block</button>
    </div>
    {picker ? <section className="note-reference-picker" aria-label="Choose an original block">
      <input aria-label="Find a Note block" placeholder="Find in loaded Notes…" value={query} onChange={event => setQuery(event.target.value)} />
      <p className="note-scope">{knowledge.scope === 'complete' ? 'Confirmed Note scope' : 'Loaded Notes only · more sources may exist'}</p>
      <div className="note-reference-picker__results">{candidates.map(({ source, block, target }) => <div className="note-reference-picker__row" key={JSON.stringify([source.location.workspaceId, source.location.path, block.blockId])} title={`${source.location.workspaceId} · ${source.location.path} · ${block.blockId}`}>
        <span><strong title={block.text}>{block.text || 'Empty block'}</strong><small>{source.location.path}</small></span>
        <button type="button" className="note-text-button" aria-label={`Reference ${source.location.workspaceId} · ${source.location.path} · ${block.blockId}`} onClick={() => insertReference(target, 'reference')}>Reference</button>
        <button type="button" className="note-text-button" aria-label={`Embed ${source.location.workspaceId} · ${source.location.path} · ${block.blockId}`} onClick={() => insertReference(target, 'embed')}>Embed</button>
      </div>)}{!candidates.length ? <p className="note-scope">No matching block is confirmed in this scope.</p> : null}</div>
    </section> : null}
    <EditorContent editor={editor} />
    <details className="note-backlinks"><summary>Backlinks{selected && backlinks.length ? ` · ${backlinks.length}` : ''}<span>{knowledge.scope === 'complete' ? 'Confirmed scope' : 'Partial scope'}</span></summary>
      {selected ? backlinks.length ? backlinks.map(link => <button type="button" className="note-backlink" key={JSON.stringify([link.source.location.workspaceId, link.source.location.path, link.referenceId])}
        title={`${link.source.location.workspaceId} · ${link.source.location.path} · ${link.blockId}`} aria-label={`Open ${link.source.location.workspaceId} · ${link.source.location.path} · ${link.blockId}`}
        onClick={() => onOpen(link.source, link.blockId)}><span>{link.source.location.path}</span><small>{link.mode === 'embed' ? 'Embedded block' : 'Block reference'}</small></button>)
        : <p className="note-scope">{knowledge.scope === 'complete' ? 'No references in the confirmed scope.' : 'No references found among loaded Notes. Unread sources are not counted.'}</p>
        : <p className="note-scope">Select a block to see its exact incoming references.</p>}
      {knowledge.invalid.length ? <p className="note-knowledge-notice" role="status">{knowledge.invalid.length} Note file could not be indexed. Its original source is preserved.</p> : null}
    </details>
  </div></ReferenceContext.Provider>
}
