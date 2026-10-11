import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react'
import { parseFileHistoryResult } from '@agentmux/core/files'
import type { NoteHistoryEntry, NoteHistorySnapshot } from '@agentmux/core/note-history'
import type { NotebookActor } from '@agentmux/core/notebook-catalog'
import { presentError } from '@agentmux/client-ui/error-presentation'
import { semanticIconComponent } from '@agentmux/client-ui/icons'
import { useAppStore } from '../store'
import { api } from '../lib/api'
import { MONACO_THEME_ID } from '../lib/monaco-theme'
import type { NoteHistoryTarget } from '../lib/note-history-target'
import type { NoteHistorySelection } from '../../../shared/note-file-editing'

const ReadonlyDiffEditor = lazy(() => import('./ReadonlyDiffEditor').then(module => ({ default: module.ReadonlyDiffEditor })))
const DisclosureIcon = semanticIconComponent('navigation.disclosure')
const HistoryIcon = semanticIconComponent('object.history')
const RefreshIcon = semanticIconComponent('action.refresh')
type Timeline = { target: NoteHistoryTarget; entries: NoteHistoryEntry[]; hasMore: boolean; reason?: string }
type Preview = { target: NoteHistoryTarget; entry: NoteHistoryEntry & { content: string; beforeContent: string | null } }
const statusLabel = { committed: 'Saved', prepared: 'Awaiting confirmation', unconfirmed: 'Unconfirmed', 'not-applied': 'Not applied' }
const operationLabel = { edit: 'Edit', restore: 'Full restore', undo: 'Activity undo' }
function EventTime({ at, timeOnly = false }: { at: number; timeOnly?: boolean }) {
  const date = new Date(at)
  return Number.isFinite(date.getTime()) ? <time dateTime={date.toISOString()}>{timeOnly ? date.toLocaleTimeString() : date.toLocaleString()}</time>
    : <span>Time unavailable</span>
}

function positionKey(state: ReturnType<typeof useAppStore.getState>, tabId: string, regionId: string): string {
  const tab = state.tabs[tabId], file = tab?.regions[regionId]
  const workspace = file?.kind === 'file' ? state.config?.workspaces.find(item => item.id === file.workspaceId) : undefined
  return JSON.stringify([tab?.space, file?.kind, file?.kind === 'file' ? [file.workspaceId, file.path] : null, workspace?.hostId, workspace?.path])
}

/** A readonly history window. All writes remain in the original document/save owner. */
export function NoteVersionHistory({ tabId, regionId, noteId, active }: { tabId: string; regionId: string; noteId: string; active: boolean }) {
  const position = useAppStore(state => positionKey(state, tabId, regionId)), agentNames = useAppStore(state => state.agentNames)
  const [refresh, setRefresh] = useState(0)
  const [timeline, setTimeline] = useState<Timeline | null>(null), [preview, setPreview] = useState<Preview | null>(null)
  const [selected, setSelected] = useState<NoteHistoryEntry | null>(null)
  const [loading, setLoading] = useState(false), [previewing, setPreviewing] = useState<string | null>(null)
  const [issue, setIssue] = useState<string | null>(null), [previewIssue, setPreviewIssue] = useState<string | null>(null)
  const [action, setAction] = useState<NoteHistorySelection | null>(null), [working, setWorking] = useState(false)
  const epoch = useRef(0), readRequest = useRef(0), previewRequest = useRef(0), running = useRef<number | null>(null)
  const activityOpener = useRef<HTMLButtonElement | null>(null), backButton = useRef<HTMLButtonElement | null>(null), restoreActivityFocus = useRef(false)
  const confirmationPanel = useRef<HTMLElement | null>(null)
  const shown = useRef(false); shown.current = active
  const current = (ticket: number) => epoch.current === ticket && shown.current && positionKey(useAppStore.getState(), tabId, regionId) === position
  function checkedHistory(target: NoteHistoryTarget, value: Awaited<ReturnType<typeof api.files.historyPublic>>, params: { before?: number; eventId?: string; includeContent?: boolean } = {}): NoteHistorySnapshot {
    const read = parseFileHistoryResult(value, { ...target, ...params, limit: 50 }).result
    if (read.status === 'unknown') throw Error(read.message)
    return read
  }
  useEffect(() => {
    const ticket = ++epoch.current
    ++readRequest.current; ++previewRequest.current
    running.current = null; setWorking(false)
    restoreActivityFocus.current = false; activityOpener.current = null
    setLoading(false); setPreviewing(null); setPreview(null); setSelected(null); setAction(null); setIssue(null); setPreviewIssue(null); setTimeline(null)
    if (active) {
      setLoading(true)
      void (async () => {
        try {
          const original = await useAppStore.getState().inspectNoteHistory(tabId, regionId, noteId)
          if (!current(ticket)) return
          const value = await api.files.historyPublic({ ...original.target, limit: 50 })
          if (!current(ticket)) return
          const result = checkedHistory(original.target, value)
          setTimeline({ target: original.target, entries: result.entries, hasMore: result.hasMore, ...(result.status === 'unconfirmed' ? { reason: result.reason } : {}) })
        } catch (error) { if (current(ticket)) setIssue(presentError(error)) }
        finally { if (current(ticket)) setLoading(false) }
      })()
    }
    return () => { ++epoch.current; ++previewRequest.current }
  }, [tabId, regionId, noteId, position, active, refresh])
  useEffect(() => {
    if (!active) { restoreActivityFocus.current = false; return }
    if (selected) backButton.current?.focus()
    else if (restoreActivityFocus.current) {
      restoreActivityFocus.current = false
      if (activityOpener.current?.isConnected) activityOpener.current.focus()
    }
  }, [selected, active])
  useEffect(() => { if (active && action) confirmationPanel.current?.focus() }, [action, active])
  const activities = useMemo(() => {
    const groups = new Map<string, NoteHistoryEntry[]>()
    for (const entry of timeline?.entries ?? []) {
      const group = groups.get(entry.batchId) ?? []; group.push(entry); groups.set(entry.batchId, group)
    }
    return [...groups.entries()]
  }, [timeline])
  function author(actor: NotebookActor | null) {
    if (!actor) return <span className="note-version-history__author">Unknown author</span>
    return <span className="note-version-history__author" title={`${actor.kind} · ${actor.id}`}>{actor.kind === 'agent' ? agentNames[actor.id] ? `Agent · ${agentNames[actor.id]}` : 'Agent' : actor.kind === 'device' ? 'Person on device' : 'Person'}</span>
  }
  async function older() {
    if (!timeline || loading || !active) return
    const ticket = epoch.current, request = ++readRequest.current, held = timeline
    const before = held.entries.at(-1)?.sequence
    if (before === undefined) return
    setLoading(true); setIssue(null)
    try {
      const value = await api.files.historyPublic({ ...held.target, before, limit: 50 })
      if (!current(ticket) || readRequest.current !== request) return
      const result = checkedHistory(held.target, value, { before })
      const existing = new Set(held.entries.map(entry => entry.eventId))
      setTimeline({ target: held.target, entries: [...held.entries, ...result.entries.filter(entry => !existing.has(entry.eventId))], hasMore: result.hasMore,
        ...(result.status === 'unconfirmed' ? { reason: result.reason } : held.reason ? { reason: held.reason } : {}) })
    } catch (error) { if (current(ticket) && readRequest.current === request) setIssue(presentError(error)) }
    finally { if (current(ticket) && readRequest.current === request) setLoading(false) }
  }
  async function showVersion(entry: NoteHistoryEntry, opener: HTMLButtonElement) {
    if (!timeline || !active || working || running.current !== null) return
    const ticket = epoch.current, request = ++previewRequest.current, target = timeline.target
    activityOpener.current = opener; restoreActivityFocus.current = false
    setSelected(entry); setPreview(null); setPreviewIssue(null); setPreviewing(entry.eventId); setAction(null)
    try {
      const params = { eventId: entry.eventId, includeContent: true }
      const value = await api.files.historyPublic({ ...target, ...params, limit: 50 })
      if (!current(ticket) || previewRequest.current !== request) return
      const result = checkedHistory(target, value, params), original = result.entries.find(item => item.eventId === entry.eventId)
      if (result.status !== 'read' || !original || original.content === undefined || original.beforeContent === undefined) throw Error(result.status === 'unconfirmed' ? result.reason : 'This original saved version is unavailable. Its history and your current draft are kept.')
      setPreview({ target, entry: { ...original, content: original.content, beforeContent: original.beforeContent } })
    } catch (error) { if (current(ticket) && previewRequest.current === request) setPreviewIssue(presentError(error)) }
    finally { if (current(ticket) && previewRequest.current === request) setPreviewing(null) }
  }
  function backToActivities() {
    if (!active || working || running.current !== null) return
    ++previewRequest.current
    restoreActivityFocus.current = true
    setSelected(null); setPreview(null); setPreviewIssue(null); setPreviewing(null); setAction(null)
  }
  async function applySelection() {
    if (!action || !active || running.current !== null) return
    const ticket = epoch.current, selected = action
    running.current = ticket; setWorking(true); setIssue(null)
    try {
      await useAppStore.getState().applyNoteHistory(tabId, regionId, selected)
      if (current(ticket)) { setAction(null); setRefresh(value => value + 1) }
    } catch (error) { if (current(ticket)) setIssue(presentError(error)) }
    finally { if (running.current === ticket) { running.current = null; setWorking(false) } }
  }
  if (!active) return null
  const detailEntry = preview?.entry ?? selected
  const confirmation = action ? <section ref={confirmationPanel} tabIndex={-1} className="note-version-history__confirm" aria-label="Confirm history change">
    <p>{'eventId' in action ? 'Replace the saved document with this entire version? Your current local draft will be kept.' : 'Undo all edits in this saved activity while keeping later nonconflicting changes. Overlapping edits are kept for review.'}</p>
    <button type="button" className="note-text-button" disabled={!active || working} onClick={() => void applySelection()}>{working ? 'Applying…' : 'eventId' in action ? 'Replace saved document' : 'Undo selected activity'}</button>
    <button type="button" className="note-text-button" disabled={working} onClick={() => setAction(null)}>Cancel</button>
  </section> : null
  return <section className="note-version-history" aria-label="Saved versions">
    <div className="note-version-history__body">
      {issue ? <p className="note-version-history__issue" role="status">{issue}</p> : null}
      <div hidden={selected !== null} inert={selected !== null}>
      <div className="note-version-history__tools"><span>Editing activities</span>
        <button type="button" className="note-text-button" aria-label="Refresh history" disabled={!active || loading || working} onClick={() => setRefresh(value => value + 1)}><RefreshIcon size={13} />Refresh</button></div>
      {timeline?.reason ? <p className="note-version-history__issue" role="status">History is partly unconfirmed. {timeline.reason}</p> : null}
      {loading && !timeline ? <p role="status">Reading saved history…</p> : null}
      {timeline && !timeline.entries.length && !timeline.reason ? <div className="note-version-history__empty"><HistoryIcon size={24} /><h3>No saved versions yet</h3><p>Recorded edits will appear here.</p></div> : null}
      {timeline ? <>
        <div className="note-version-history__activities">{activities.map(([batchId, entries]) => {
          const latest = entries[0]!, canUndo = entries.every(entry => entry.status === 'committed' && entry.operation === 'edit')
          return <details className="note-version-history__activity" key={batchId}>
            <summary><DisclosureIcon size={12} /><span className="note-version-history__activity-label"><EventTime at={latest.at} />
              <span className="note-version-history__activity-meta">{author(latest.actor)}<span>{entries.length} loaded {entries.length === 1 ? 'revision' : 'revisions'}</span></span>
              {latest.status !== 'committed' ? <small>{statusLabel[latest.status]}</small> : null}</span></summary>
            <div className="note-version-history__revisions">{entries.map(entry => <div className="note-version-history__revision" key={entry.eventId}>
              <span title={entry.eventId}>{operationLabel[entry.operation]} · {statusLabel[entry.status]}<small><EventTime at={entry.at} timeOnly /></small></span>
              <button type="button" className="note-text-button" disabled={!active || working || previewing === entry.eventId} aria-label={`Preview version ${entry.eventId}`} onClick={event => void showVersion(entry, event.currentTarget)}>{previewing === entry.eventId ? 'Reading…' : 'Preview changes'}</button>
            </div>)}</div>
            <details className="note-version-history__identity">
              <summary>Activity details</summary>
              <dl><div><dt>Activity ID</dt><dd><code>{batchId}</code></dd></div>
                {entries.map(entry => <div key={entry.eventId}><dt>Version ID</dt><dd><code>{entry.eventId}</code></dd><dt>Author identity</dt><dd>{entry.actor ? <code>{entry.actor.kind} · {entry.actor.id}</code> : 'Unknown author'}</dd></div>)}
              </dl>
            </details>
            {canUndo ? <button type="button" className="note-text-button" disabled={!active || working} onClick={() => setAction({ target: timeline.target, batchId, batchLastEventId: latest.eventId })}>Undo this activity…</button> : null}
            {action && 'batchId' in action && action.batchId === batchId ? confirmation : null}
          </details>
        })}</div>
        {timeline.hasMore ? <button type="button" className="note-text-button" disabled={!active || loading || working} onClick={() => void older()}>{loading ? 'Reading…' : 'Load older changes'}</button> : null}
        {timeline.entries.length ? <details className="note-version-history__scope"><summary>About this history</summary><p>Versions are grouped by editing activity. Only loaded revisions are shown. An activity may continue beyond this window. Previewing does not change your Note.</p></details> : null}
      </> : null}
      </div>
      {selected && detailEntry ? <section className="note-version-history__preview" aria-label="Version preview">
        <button ref={backButton} type="button" className="note-text-button" disabled={working} onClick={backToActivities}>Back to activities</button>
        <div className="note-version-history__heading"><h3>{operationLabel[detailEntry.operation]} · {statusLabel[detailEntry.status]}</h3><div className="note-version-history__activity-meta">{author(detailEntry.actor)}<EventTime at={detailEntry.at} /></div></div>
        {previewing ? <p role="status">Reading saved version…</p> : null}
        {previewIssue ? <p className="note-version-history__issue" role="status">{previewIssue}</p> : null}
        {preview ? <>
          {preview.entry.status === 'committed' ? <button type="button" className="note-text-button" disabled={!active || working} onClick={() => setAction({ target: preview.target, eventId: preview.entry.eventId })}>Restore this entire version…</button> : null}
          <p>{preview.entry.beforeContent === null ? 'Before: file did not exist' : 'Before this change'} → After this change</p>
          <div className="note-version-history__diff"><Suspense fallback={<p role="status">Opening version comparison…</p>}><ReadonlyDiffEditor original={preview.entry.beforeContent ?? ''} modified={preview.entry.content} wordWrap language="markdown" theme={MONACO_THEME_ID} /></Suspense></div>
        </> : null}
      </section> : null}
      {action && 'eventId' in action ? confirmation : null}
    </div>
  </section>
}
