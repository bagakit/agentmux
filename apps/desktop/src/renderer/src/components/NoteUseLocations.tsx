import { createContext, useCallback, useContext, useEffect, useId, useMemo, useState, type ReactNode } from 'react'
import { useVisibleWork } from '@agentmux/client-ui/use-visible-work'
import { noteContentMatchesGraph, type NotebookGraphSnapshot } from '../../../shared/notebook-observation'
import { useNoteCanvasContent } from '../lib/use-note-canvas-content'
import { noteGraphReferenceKey } from '../lib/note-graph-references'
import { noteUseContext, type NoteSharedUse } from '../lib/note-shared-relations'
import { sameNoteResource } from '../lib/notebook-library'

type Reader = { snapshot: NotebookGraphSnapshot | null; bodies: ReturnType<typeof useNoteCanvasContent>; visible(key: string, noteId: string, value: boolean): void }
const Context = createContext<Reader | null>(null), NO_PRIORITY: readonly string[] = []

/** One temporary content window serves the visible use rows on this reading surface. */
export function NoteUseContextReader({ snapshot, active, children }: { snapshot: NotebookGraphSnapshot | null; active: boolean; children: ReactNode }) {
  const inherited = useContext(Context)
  return inherited?.snapshot === snapshot ? children : <UseContextReader snapshot={snapshot} active={active}>{children}</UseContextReader>
}
function UseContextReader({ snapshot, active, children }: { snapshot: NotebookGraphSnapshot | null; active: boolean; children: ReactNode }) {
  const [rows, setRows] = useState<Record<string, string>>({})
  const visible = useCallback((key: string, noteId: string, value: boolean) => setRows(held => {
    if (value && held[key] === noteId || !value && !(key in held)) return held
    return value ? { ...held, [key]: noteId } : Object.fromEntries(Object.entries(held).filter(([id]) => id !== key))
  }), [])
  const ids = useMemo(() => [...new Set(Object.values(rows))], [rows])
  const bodies = useNoteCanvasContent(snapshot, active, ids, NO_PRIORITY)
  return <Context.Provider value={{ snapshot, bodies, visible }}>{children}</Context.Provider>
}

export function NoteUseLocations({ uses, active, onOpen, className, itemClassName, buttonClassName, marker }: {
  uses: readonly NoteSharedUse[]; active: boolean; onOpen(use: NoteSharedUse): void
  className?: string; itemClassName?: string; buttonClassName?: string; marker?: (use: NoteSharedUse) => ReactNode
}) {
  return <ol className={className}>{uses.map(use => <UseLocation key={noteGraphReferenceKey(use.reference)} use={use} active={active} onOpen={onOpen}
    {...(itemClassName ? { className: itemClassName } : {})} {...(buttonClassName ? { buttonClassName } : {})} marker={marker?.(use)} />)}</ol>
}
function UseLocation({ use, active, onOpen, className, buttonClassName, marker }: {
  use: NoteSharedUse; active: boolean; onOpen(use: NoteSharedUse): void; className?: string; buttonClassName?: string; marker?: ReactNode
}) {
  const reader = useContext(Context), work = useVisibleWork<HTMLLIElement>(active)
  const rowId = useId(), key = rowId + noteGraphReferenceKey(use.reference), id = use.reference.source.noteId
  const visible = reader?.visible
  useEffect(() => { visible?.(key, id, work.visible); return () => visible?.(key, id, false) }, [visible, key, id, work.visible])
  const result = reader?.bodies.results[id], held = result?.snapshot === reader?.snapshot ? result : undefined, value = held?.value
  const confirmed = reader?.snapshot && value?.status === 'read' && noteContentMatchesGraph(reader.snapshot, value) && sameNoteResource(value.resource, use.reference.sourceResource) ? value : null
  const source = confirmed ? reader!.bodies.knowledge.sources.find(item => item.note.noteId === id && item.location.workspaceId === confirmed.resource.workspaceId && item.location.path === confirmed.resource.path) : undefined
  const context = useMemo(() => source ? noteUseContext(source, use.reference) : null, [source, use.reference])
  const title = reader?.snapshot?.catalog.pages[id]?.title ?? source?.note.title ?? use.title
  const message = context?.status === 'read' ? null : context?.message ?? (held?.pending ? 'Reading this saved position…' : value?.status === 'read' ? 'Position context changed. Open this original to read its current context.' : held?.issue ?? (value && 'message' in value ? value.message : 'Position context has not been read.'))
  return <li ref={work.ref} className={className} data-use-position={use.reference.source.blockId}>
    {marker}<button type="button" className={buttonClassName} onClick={() => onOpen(use)}>
      <span>{title}</span>
      {context?.status === 'read' ? <span className="note-use-context">{context.heading && <strong>{context.heading}</strong>}{context.excerpt && <span>{context.excerpt}</span>}{!context.heading && !context.excerpt && <span>No nearby text in this saved position.</span>}</span> : <span className="note-use-context" role="status">{message}</span>}
      <small>{use.source ? 'Source' : 'Use'}{use.current ? ' · Current position' : ''}</small>
    </button>
  </li>
}
