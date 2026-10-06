import { useCallback, useEffect, useRef, useState } from 'react'
import type { Editor } from '@tiptap/core'
import { closeNoteWikiHistory } from '@agentmux/client-ui/note/note-wiki-input'
import { parseNoteWikiPrefix, type NoteInlineLinkAttributes, type NoteLinkTarget, type NotePageCandidate, type NotebookResolveResult, type NoteWikiQuery } from '@agentmux/core/note-links'
import { api } from '../lib/api'
import { presentError } from '@agentmux/client-ui/error-presentation'

type Trigger = { from: number; to: number; text: string; query: NoteWikiQuery }
type Search = Extract<NotebookResolveResult, { mode: 'search' }>
type Lookup = Extract<NotebookResolveResult, { mode: 'resolve' }>
const escapeQuery = (text: string) => text.replace(/[\\#\[\]]/gu, '\\$&')

/** A prefix is local to this caret/textblock. It never searches documents or reads a file. */
export function noteWikiTrigger(editor: Editor): Trigger | null {
  const selection = editor.state.selection
  if (!selection.empty || !selection.$from.parent.isTextblock || selection.$from.parent.type.name === 'codeBlock' || selection.$from.marks().some(mark => mark.type.name === 'code' || mark.type.name === 'link')) return null
  const before = selection.$from.parent.textBetween(0, selection.$from.parentOffset, '\ufffc', '\ufffc')
  const at = before.lastIndexOf('[[')
  if (at < 0) return null
  let slash = 0; for (let i = at - 1; i >= 0 && before[i] === '\\'; i--) slash++
  if (slash % 2 || before.slice(at + 2).includes(']]')) return null
  const text = before.slice(at + 2), query = parseNoteWikiPrefix(text)
  return query ? { from: selection.from - (before.length - at), to: selection.from, text, query } : null
}

export function useNoteWikiCompletion(editor: Editor | null, active: boolean, sourceIdentity: string) {
  const [trigger, setTrigger] = useState<Trigger | null>(null), [dismissed, dismiss] = useState<string | null>(null)
  const [search, setSearch] = useState<Search | null>(null), [lookup, setLookup] = useState<Lookup | null>(null)
  const [chosen, choose] = useState<NotePageCandidate | null>(null), [issue, setIssue] = useState<string | null>(null), [busy, setBusy] = useState(false), [index, setIndex] = useState(0), [retry, setRetry] = useState(0)
  const [anchor, setAnchor] = useState({ left: 0, top: 0 })
  const current = useRef({ editor, active, trigger, sourceIdentity }); current.current = { editor, active, trigger, sourceIdentity }
  const pending = useRef(new Set<AbortController>())
  const key = trigger ? `${trigger.from}:${trigger.text}` : null
  const visible = active && Boolean(trigger) && dismissed !== key
  useEffect(() => {
    if (!editor) return
    const update = () => {
      if (editor.isDestroyed || editor.view.composing) return
      const next = noteWikiTrigger(editor)
      setTrigger(previous => JSON.stringify(previous) === JSON.stringify(next) ? previous : next)
      if (next) {
        try { const coords = editor.view.coordsAtPos(next.to), host = editor.view.dom.closest('.note-editor')?.getBoundingClientRect(); setAnchor({ left: Math.max(8, Math.min(coords.left - (host?.left ?? 0), host ? host.width - Math.min(360, host.width - 24) - 12 : coords.left)), top: coords.bottom - (host?.top ?? 0) + 8 }) } catch { /* Keep typing available while this view has no measurable caret. */ }
      }
    }
    editor.on('transaction', update).on('selectionUpdate', update); update()
    return () => { editor.off('transaction', update).off('selectionUpdate', update) }
  }, [editor])
  useEffect(() => { if (!active) { for (const cancel of pending.current) cancel.abort(); pending.current.clear(); setTrigger(null) } return () => { for (const cancel of pending.current) cancel.abort(); pending.current.clear() } }, [active, sourceIdentity])
  useEffect(() => { choose(null); setLookup(null) }, [trigger?.query.page])
  useEffect(() => {
    if (!visible || !trigger) return
    const cancel = new AbortController(); setIssue(null); setBusy(true); setIndex(0); setSearch(null); setLookup(null)
    const timer = setTimeout(() => {
      if (trigger.query.fragment) {
        void api.notebooks.resolve({ mode: 'resolve', text: escapeQuery(trigger.query.page), ...(chosen ? { select: { noteId: chosen.noteId } } : {}) }, { signal: cancel.signal }).then(result => {
          if (!cancel.signal.aborted && result.mode === 'resolve') { setLookup(result); setSearch(null); setBusy(false) }
        }).catch(error => { if (!cancel.signal.aborted) { setIssue(presentError(error)); setBusy(false) } })
      } else {
        void api.notebooks.resolve({ mode: 'search', query: trigger.query.page, limit: 20 }, { signal: cancel.signal }).then(result => {
          if (!cancel.signal.aborted && result.mode === 'search') { setSearch(result); setLookup(null); setBusy(false) }
        }).catch(error => { if (!cancel.signal.aborted) { setIssue(presentError(error)); setBusy(false) } })
      }
    }, 100)
    return () => { clearTimeout(timer); cancel.abort() }
    // Fragment keystrokes filter the one observed body locally; they do not reread it.
  }, [visible, trigger?.query.page, Boolean(trigger?.query.fragment), chosen?.noteId, retry, sourceIdentity])

  const created = useCallback((link: NoteInlineLinkAttributes) => {
    if (!current.current.active || !current.current.editor) return
    const cancel = new AbortController(), originalSource = current.current.sourceIdentity; pending.current.add(cancel)
    void api.notebooks.resolve({ mode: 'resolve', text: link.text }, { signal: cancel.signal }).then(result => {
      const editor = current.current.editor
      if (cancel.signal.aborted || !current.current.active || originalSource !== current.current.sourceIdentity || !editor || editor.isDestroyed || result.mode !== 'resolve' || result.result.status !== 'resolved') return
      let at: number | null = null
      editor.state.doc.descendants((node, pos) => { if (node.type.name === 'noteLink' && node.attrs.referenceId === link.referenceId && node.attrs.text === link.text && node.attrs.target === null) { at = pos; return false } })
      if (at !== null) editor.view.dispatch(editor.state.tr.setNodeMarkup(at, undefined, { ...link, target: result.result.target }).setMeta('addToHistory', false))
    }).catch(() => { /* The canonical unbound node remains editable and can be retried by opening it. */ }).finally(() => pending.current.delete(cancel))
  }, [])
  const sameTrigger = (held: Trigger, editor: Editor) => {
    const fresh = noteWikiTrigger(editor)
    return fresh?.from === held.from && fresh.to === held.to && fresh.text === held.text
  }
  async function insert(page: NotePageCandidate, blockId?: string) {
    if (!editor || !trigger) return
    const held = trigger, originalSource = sourceIdentity, block = lookup?.blocks.find(block => block.blockId === blockId)
    const text = escapeQuery(page.title) + (block ? ` #${block.type === 'heading' && block.text ? escapeQuery(block.text) : '^' + escapeQuery(block.blockId)}` : '')
    const cancel = new AbortController(); pending.current.add(cancel); setBusy(true); setIssue(null)
    try {
      const result = await api.notebooks.resolve({ mode: 'resolve', text, select: { noteId: page.noteId, ...(blockId ? { blockId } : {}) } }, { signal: cancel.signal })
      if (cancel.signal.aborted || !current.current.active || originalSource !== current.current.sourceIdentity || editor.isDestroyed || !sameTrigger(held, editor)) return
      if (result.mode !== 'resolve' || result.result.status !== 'resolved') { if (result.mode === 'resolve') { setLookup(result); setIssue(result.result.status === 'resolved' ? null : result.result.message) } return }
      closeNoteWikiHistory(editor)
      editor.chain().focus().insertContentAt({ from: held.from, to: held.to }, { type: 'noteLink', attrs: { referenceId: crypto.randomUUID(), text, target: result.result.target } }).run()
      dismiss(`${held.from}:${held.text}`); setTrigger(null)
    } catch (error) { if (!cancel.signal.aborted) setIssue(presentError(error)) }
    finally { pending.current.delete(cancel); if (!cancel.signal.aborted) setBusy(false) }
  }
  const pageOptions = trigger?.query.fragment ? lookup?.observation?.status === 'read' ? [] : lookup?.candidates ?? [] : search?.candidates ?? []
  const filter = trigger?.query.fragment?.value.toLocaleLowerCase() ?? ''
  const blocks = trigger?.query.fragment && lookup?.observation?.status === 'read' ? lookup.blocks.filter(block => trigger.query.fragment?.kind === 'block' ? block.blockId.includes(filter) : `${block.text} ${block.blockId}`.toLocaleLowerCase().includes(filter)) : []
  const options: { key: string; title: string; detail: string; select(): void }[] = [
    ...pageOptions.map(page => ({ key: page.noteId, title: page.title, detail: `${page.notebookId} · ${page.resource.path}`, select: () => { if (trigger?.query.fragment) choose(page); else void insert(page) } })),
    ...blocks.map(block => ({ key: block.blockId, title: block.text || 'Empty block', detail: `${block.type} · ${block.blockId}`, select: () => { const page = lookup?.candidates.find(page => page.noteId === lookup.observation?.noteId); if (page) void insert(page, block.blockId) } }))
  ]
  const keyDown = (event: KeyboardEvent) => {
    if (!visible || event.isComposing || event.metaKey || event.ctrlKey || event.altKey) return false
    if (event.key === 'Escape') { event.preventDefault(); dismiss(key); return true }
    if (!options.length || busy) return false
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); setIndex(value => (value + (event.key === 'ArrowDown' ? 1 : -1) + options.length) % options.length); return true }
    if (event.key === 'Enter' || event.key === 'Tab') { event.preventDefault(); options[Math.min(index, options.length - 1)]?.select(); return true }
    return false
  }
  const popup = visible ? <section className="note-wiki-completion" aria-label="Note link suggestions" style={{ left: anchor.left, top: anchor.top }}>
    <div className="note-wiki-completion__heading"><strong>{trigger?.query.fragment ? 'Heading or block' : 'Link a page'}</strong><span>{busy ? 'Checking…' : `${options.length} shown`}</span></div>
    <div role="listbox" aria-label="Original Note targets">{options.map((option, at) => <button type="button" role="option" aria-selected={index === at} className="note-link-option" key={option.key}
      onMouseDown={event => event.preventDefault()} onClick={option.select}><strong>{option.title}</strong><small>{option.detail}</small></button>)}</div>
    {!busy && !options.length ? <p className="note-scope">{issue ?? (lookup?.result.status !== 'resolved' ? lookup?.result.message : null) ?? 'No target is confirmed for this query. Keep typing or close the suggestions.'}</p> : null}
    {search?.truncated ? <p className="note-scope">{search.total} pages match. Refine this query to see more.</p> : null}
    {issue ? <button type="button" className="note-text-button" onMouseDown={event => event.preventDefault()} onClick={() => setRetry(value => value + 1)}>Retry lookup</button> : null}
    <p className="note-wiki-completion__help">↑↓ choose · Enter insert · Esc keep text</p>
  </section> : null
  return { popup, keyDown, created }
}
