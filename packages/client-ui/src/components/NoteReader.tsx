import { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { EditorContent, NodeViewWrapper, ReactNodeViewRenderer, useEditor, type NodeViewProps, useEditorState } from '@tiptap/react'
import type { FileWriteReceipt, FileReadResult } from '@agentmux/core/files'
import type { JSONContent } from '@tiptap/core'
import { noteContentExtensions, NoteBlockReferenceNode, noteIdentityExtensions } from '../note/note-content-schema.js'
import { readNoteDocument, type NoteBlockReference, type NoteBlockTarget, type NoteDocument } from '../note/note-document.js'
import { noteKnowledge, resolveNoteBlock, type NoteKnowledge } from '../note/note-knowledge.js'

const Scope = createContext<{ knowledge: NoteKnowledge; trail: string[]; readReference?: ((target: NoteBlockTarget) => void) | undefined } | null>(null)
function Reference({ node }: NodeViewProps) {
  const scope = useContext(Scope)
  const reference = node.attrs as NoteBlockReference
  if (!scope) return <NodeViewWrapper>引用内容尚未确认。</NodeViewWrapper>
  const result = resolveNoteBlock(scope.knowledge, reference.target)
  const key = JSON.stringify(reference.target)
  return <NodeViewWrapper className="mobile-note-reference">
    <strong>{reference.mode === 'embed' ? '引用原块' : '块引用'}</strong>
    {scope.trail.includes(key) ? <p role="status">循环引用，原引用保留。</p>
      : result.status === 'resolved' ? reference.mode === 'embed'
        ? <Scope.Provider value={{ ...scope, trail: [...scope.trail, key] }}><RichContent content={{ type: 'doc', content: [result.block.content.type === 'listItem' ? { type: 'bulletList', content: [result.block.content] } : result.block.content] }} /></Scope.Provider>
        : <p>{result.block.text}</p>
        : <><p role="status">引用正文尚未读取，原引用保留。</p>{scope.readReference && <button type="button" onClick={() => scope.readReference!(reference.target)}>读取引用原文</button>}</>}
    <details><summary>引用来源</summary><code>{reference.target.noteId} / {reference.target.blockId}</code></details>
  </NodeViewWrapper>
}
function RichContent({ content, onChange }: { content: JSONContent; onChange?: ((value: JSONContent) => void) | undefined }) {
  const extensions = useMemo(() => noteContentExtensions().map(extension => extension.name === NoteBlockReferenceNode.name
    ? NoteBlockReferenceNode.extend({ addNodeView() { return ReactNodeViewRenderer(Reference) } }) : extension).concat(onChange ? noteIdentityExtensions() : []), [Boolean(onChange)])
  const update = useRef(onChange); update.current = onChange
  const editor = useEditor({ extensions, content, editable: Boolean(onChange), onUpdate: ({ editor }) => update.current?.(editor.getJSON()), editorProps: { attributes: { class: 'mobile-note-body', 'aria-label': '原 Note 正文' } } }, [])
  useEffect(() => { if (editor) editor.commands.setContent(content, { emitUpdate: false }) }, [editor, content])
  const state = useEditorState({ editor, selector: ({ editor }) => ({ bold: editor.isActive('bold'), italic: editor.isActive('italic'), heading: editor.isActive('heading'), list: editor.isActive('bulletList'), code: editor.isActive('codeBlock') }) })
  return <>{onChange && editor && <div role="toolbar" aria-label="笔记格式">
    <button type="button" aria-pressed={state?.bold} onClick={() => editor.chain().focus().toggleBold().run()}>粗体</button>
    <button type="button" aria-pressed={state?.italic} onClick={() => editor.chain().focus().toggleItalic().run()}>斜体</button>
    <button type="button" aria-pressed={state?.heading} onClick={() => editor.chain().focus().toggleHeading({ level: 2 }).run()}>标题</button>
    <button type="button" aria-pressed={state?.list} onClick={() => editor.chain().focus().toggleBulletList().run()}>列表</button>
    <button type="button" aria-pressed={state?.code} onClick={() => editor.chain().focus().toggleCodeBlock().run()}>代码</button>
    <button type="button" onClick={() => editor.chain().focus().undo().run()}>撤销</button>
    <button type="button" onClick={() => editor.chain().focus().redo().run()}>重做</button>
  </div>}<EditorContent editor={editor} /></>
}
export type NoteEditState = {
  noteId: string; draft: string; expectedRevision: string
  attempt?: { content: string; expectedRevision: string; phase: 'sending' | 'unknown' } | undefined
  unconfirmed?: { content: string; expectedRevision: string }[]
  alternates?: { draft: string; expectedRevision: string }[]
}
export type NoteEditing = {
  initial?: NoteEditState | undefined
  onDraft(state: NoteEditState): void
  subscribe?: ((listener: (state: NoteEditState) => void) => () => void) | undefined
  readDeviceDraft?: (() => NoteEditState | undefined) | undefined
  adoptDeviceDraft?: ((state: NoteEditState) => void) | undefined
  save(content: string, expectedRevision: string): Promise<FileWriteReceipt>
  readCurrent(): Promise<FileReadResult>
}
export type NoteReaderProps = { content: string; path: string; workspaceId: string; revision: string | null;
  documents?: Parameters<typeof noteKnowledge>[0] | undefined
  readReference?: ((target: NoteBlockTarget) => void) | undefined
  editing?: NoteEditing | undefined
  target?: NoteBlockTarget | undefined
}
const EMPTY_DOCUMENTS: NonNullable<NoteReaderProps['documents']> = []
export function NoteReader({ content, path, workspaceId, revision, documents = EMPTY_DOCUMENTS, readReference, editing, target }: NoteReaderProps) {
  const parsed = useMemo(() => readNoteDocument(content), [content])
  const body = useRef<HTMLDivElement>(null)
  const [working, setWorking] = useState<{ noteId: string; content: string } | null>(null)
  const workingContent = parsed.status === 'valid' && working?.noteId === parsed.note.noteId ? working.content
    : parsed.status === 'valid' && editing?.initial?.noteId === parsed.note.noteId ? editing.initial.draft : content
  const knowledge = useMemo(() => noteKnowledge([{ location: { workspaceId, path }, document: { path, content: workingContent, revision: revision ?? '' } }, ...documents]), [workingContent, path, workspaceId, revision, documents])
  const block = target ? resolveNoteBlock(knowledge, target) : null
  useEffect(() => {
    if (!target || block?.status !== 'resolved') return
    const element = [...body.current?.querySelectorAll<HTMLElement>('[data-block-id]') ?? []].find(element => element.dataset.blockId === target.blockId)
    element?.scrollIntoView?.({ block: 'center' })
  }, [target?.noteId, target?.blockId, block?.status])
  return parsed.status === 'valid' ? <Scope.Provider value={{ knowledge, trail: [], readReference }}><div ref={body} data-note-id={parsed.note.noteId} data-target-block={block?.status === 'resolved' ? target?.blockId : undefined}>
    {target && <section aria-label="原块定位" data-block-target-status={block?.status}>
      {block?.status === 'resolved' ? <><strong>引用的原块</strong><p>{block.block.text}</p></> : <p role="status">原块未确认：{block?.message} 原引用保留，仍可阅读完整笔记。</p>}
    </section>}
    {editing && revision ? <EditableNote key={parsed.note.noteId} note={parsed.note} content={content} revision={revision} editing={{ ...editing, subscribe: editing.subscribe ? listener => editing.subscribe!(state => { setWorking({ noteId: state.noteId, content: state.draft }); listener(state) }) : undefined, onDraft: state => { setWorking({ noteId: state.noteId, content: state.draft }); editing.onDraft(state) } }} /> : <RichContent content={parsed.note.content} />}
  </div></Scope.Provider> : <><p role="status">原笔记读取问题：{parsed.message}</p><pre>{content}</pre></>
}
function EditableNote({ note, content, revision, editing }: { note: NoteDocument; content: string; revision: string; editing: NoteEditing }) {
  const alive = useRef(true)
  useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])
  const initial = editing.initial?.noteId === note.noteId ? editing.initial : undefined
  const [state, setState] = useState<NoteEditState>(initial ?? { noteId: note.noteId, draft: content, expectedRevision: revision })
  const current = useRef(state); current.current = state
  const [opened, open] = useState(Boolean(initial)), [notice, setNotice] = useState(initial?.attempt ? '原保存回执未确认，草稿保留；请核对原文件，不会重复写入。' : '')
  const [remote, setRemote] = useState<{ document: { content: string; revision: string }; note: NoteDocument } | null>(null)
  const [externalDraft, setExternalDraft] = useState<string | null>(null)
  const [device, setDevice] = useState<NoteEditState | null>(null)
  const unretained = useRef(false)
  const draftWriter = useRef(editing.onDraft); draftWriter.current = editing.onDraft
  const subscribe = useRef(editing.subscribe); subscribe.current = editing.subscribe
  useEffect(() => subscribe.current?.(value => {
    if (value.noteId !== note.noteId) return
    const retained = unretained.current ? { ...value, draft: current.current.draft,
      alternates: [...value.alternates ?? [], { draft: value.draft, expectedRevision: value.expectedRevision }] } : value
    current.current = retained; setState(retained); setExternalDraft(retained.draft); open(true)
    if (unretained.current) {
      unretained.current = false
      try { draftWriter.current(retained); setNotice('本机存储已恢复，两份原编辑均已保全。') }
      catch (error) { unretained.current = true; setNotice(`两份编辑在当前工作面保留，本机保存仍未确认：${String(error)}`) }
    }
  }), [note.noteId])
  const baseline = useMemo(() => { const read = readNoteDocument(state.draft); return read.status === 'valid' ? read.note.content : note.content }, [opened, externalDraft])
  const persist = (value: NoteEditState) => {
    current.current = value; setState(value)
    try { editing.onDraft(value); unretained.current = false; return true }
    catch (error) { unretained.current = true; setNotice(`本机草稿与保存意图未持久保存：${error instanceof Error ? error.message : String(error)}。当前编辑保留；恢复本机存储后可明确保存。`); return false }
  }
  async function save() {
    if (current.current.attempt) return
    const sent = current.current, parsed = readNoteDocument(sent.draft)
    if (parsed.status !== 'valid' || parsed.note.noteId !== note.noteId) { setNotice('原 Note 身份或块内容未确认，草稿保留。'); return }
    const attempt = { content: sent.draft, expectedRevision: sent.expectedRevision, phase: 'sending' as const }
    if (!persist({ ...sent, attempt })) { current.current = sent; setState(sent); return }
    setNotice('正在保存原笔记…')
    let result: FileWriteReceipt
    try { result = await editing.save(attempt.content, attempt.expectedRevision) }
    catch (error) { result = { status: 'unknown', code: 'NOTE_SAVE_UNKNOWN', message: error instanceof Error ? error.message : String(error) } }
    if (!alive.current) return
    if (result.status === 'written') { persist({ ...current.current, attempt: undefined, expectedRevision: result.revision }); setNotice('原文件保存已确认。') }
    else if (result.status === 'unknown') { persist({ ...current.current, attempt: { ...attempt, phase: 'unknown' } }); setNotice(`保存回执未知：${result.message}。草稿保留，请核对原文件；不会重复写入。`) }
    else { const { attempt: pending, ...kept } = current.current; persist(kept); setNotice(result.status === 'conflict' ? '原文件已改变，草稿保留；请核对当前原文后明确处理冲突。' : `保存失败：${result.message}。草稿保留。`) }
  }
  async function inspect() {
    try {
      const result = await editing.readCurrent()
      if (!alive.current) return
      if (result.result.status !== 'read') { setNotice(result.result.status === 'unknown' || result.result.status === 'error' ? result.result.message : `原文件状态：${result.result.status}；草稿保留。`); return }
      const parsed = readNoteDocument(result.result.document.content)
      if (parsed.status !== 'valid' || parsed.note.noteId !== note.noteId) { setNotice('读取未确认同一原 Note，草稿与保存意图保留。'); return }
      setRemote({ document: result.result.document, note: parsed.note })
      if (current.current.attempt?.phase === 'unknown' && result.result.document.content === current.current.attempt.content) {
        persist({ ...current.current, attempt: undefined, expectedRevision: result.result.document.revision }); setNotice('当前原文件已确认包含本次保存内容。')
      } else setNotice(current.current.attempt?.phase === 'sending' ? '原保存请求仍在等待回执，本次读取不能代签；草稿与原请求保留，不会发起第二次保存。' : current.current.attempt ? '当前原文与待确认保存不同；保存结果仍未知，不会重复写入。' : '已读当前原文；原草稿保留，可明确以当前修订继续保存。')
    } catch (error) { setNotice(`核对原文件失败：${error instanceof Error ? error.message : String(error)}。草稿与原意图保留。`) }
  }
  return <>{!opened ? <><RichContent key="saved" content={note.content} /><button type="button" onClick={() => { persist({ noteId: note.noteId, draft: content, expectedRevision: revision }); open(true) }}>编辑原笔记</button></> : <>
    <RichContent key="draft" content={baseline} onChange={value => persist({ ...current.current, draft: JSON.stringify({ schema: note.schema, noteId: note.noteId, content: value }) })} />
    <button type="button" disabled={Boolean(state.attempt)} onClick={() => { void save() }}>保存原笔记</button>
    <button type="button" onClick={() => { void inspect() }}>核对当前原文</button>
    {editing.readDeviceDraft && <button type="button" onClick={() => { try { const value = editing.readDeviceDraft!(); if (!value || value.noteId !== note.noteId) { setNotice('未读到同一原 Note 的本机草稿；当前编辑保留。'); return }; setDevice(value) } catch (error) { setNotice(`本机草稿读取失败：${error instanceof Error ? error.message : String(error)}；原编辑保留。`) } }}>核对本机笔记草稿</button>}
    {device && editing.adoptDeviceDraft && <details open><summary>较新的本机草稿（当前编辑保留）</summary><pre>{device.draft}</pre><button type="button" onClick={() => { const value = { ...device, alternates: [...device.alternates ?? [], { draft: current.current.draft, expectedRevision: current.current.expectedRevision }] }; try { editing.adoptDeviceDraft!(value); current.current = value; setState(value); setExternalDraft(value.draft); editing.onDraft(value); setDevice(null); setNotice('已采用本机草稿，原编辑另存保留；仍可核对原文件并继续。') } catch (error) { setNotice(`采用本机草稿未确认：${error instanceof Error ? error.message : String(error)}；两份内容保留。`) } }}>保留当前编辑，采用本机草稿</button></details>}
    {remote && <details open><summary>当前原文件（草稿保留）</summary><RichContent content={remote.note.content} />{state.attempt?.phase !== 'sending' && <button type="button" onClick={() => { persist({ ...current.current, attempt: undefined, ...(current.current.attempt ? { unconfirmed: [...current.current.unconfirmed ?? [], { content: current.current.attempt.content, expectedRevision: current.current.attempt.expectedRevision }] } : {}), expectedRevision: remote.document.revision }); setNotice('已选择当前修订；下次保存将以本草稿替换刚核对的原文。') }}>{state.attempt ? '保留未知保存记录，以当前修订继续编辑' : '以当前修订继续保存本草稿'}</button>}</details>}
  </>}{notice && <p role="status">{notice}</p>}{!!state.unconfirmed?.length && <details><summary>原未知保存记录</summary>{state.unconfirmed.map((value, index) => <div key={index}><p>此保存的历史回执仍未确认。后续保存不代签该结果。</p><code>{value.expectedRevision}</code><pre>{value.content}</pre></div>)}</details>}{!!state.alternates?.length && <details><summary>另一个工作面的原编辑</summary>{state.alternates.map((value, index) => <pre key={index}>{value.draft}</pre>)}</details>}</>
}
