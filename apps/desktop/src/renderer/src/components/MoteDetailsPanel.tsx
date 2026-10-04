import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { ArrowRight, FileText, Pencil, Plus } from 'lucide-react'
import { useShallow } from 'zustand/react/shallow'
import type { SessionSnapshot } from '../../../shared/contracts'
import { AgentMarkdown } from '@agentmux/client-ui/components/AgentMarkdown'
import { presentError } from '@agentmux/client-ui/error-presentation'
import { MOTE_SOUL_PATH } from '../../../shared/scratch-topics'
import type { MoteWorkfaceScope } from '../lib/mote-workface'
import type { WorkbenchProjectionSelection } from '../lib/workbench-projection'
import { topicSpaceIconTarget, type SpaceIconTarget } from '../lib/space-object-appearance'
import { sessionPresentationById } from '../lib/session-presentation'
import { documentKey } from '../lib/workbench-tabs'
import { readMoteMaterial } from '../lib/mote-cooperation'
import { MOTE_BEHAVIOR_AXES, parseMoteBehaviorBlock } from '../lib/mote-behavior'
import { MoteBehaviorAction, MoteBehaviorDialog } from './MoteBehaviorDialog'
import { useAppStore } from '../store'
import { useWorkspaceFileTree } from './file-tree/useWorkspaceFileTree'
import { SpaceObjectIcon } from './SpaceObjectIcon'
import { SpaceIconPicker } from './SpaceIconPicker'
import { MoteRenameDialog } from './MoteRenameDialog'
import { StatusDot } from './StatusDot'
import { MoteIdeaControls } from './MoteIdeaControls'
import { MoteFirstCooperation } from './MoteFirstCooperation'
import { MoteCurrentWork } from './MoteCurrentWork'
import { LiquidSelectionSurface } from './settings/LiquidSelectionSurface'

const NO_EXPANDED_PATHS: ReadonlySet<string> = new Set()
type MoteSection = 'profile' | 'ideas'

/** Object content in the shared tools frame. Files and conversations keep their original owners. */
export function MoteDetailsPanel({ scope, reference, onOpenPath, onCreateNote, active = true }: {
  scope: MoteWorkfaceScope; reference?: WorkbenchProjectionSelection | null | undefined; active?: boolean
  onOpenPath(path: string): Promise<unknown>; onCreateNote(): void
}) {
  const [section, setSection] = useState<MoteSection>('profile')
  const [rename, setRename] = useState<Pick<MoteWorkfaceScope, 'topic' | 'workspace'> | null>(null)
  const [avatar, setAvatar] = useState<SpaceIconTarget | null>(null)
  const renameInvoker = useRef<{ node: HTMLButtonElement; key: string } | null>(null)
  const avatarInvoker = useRef<{ node: HTMLButtonElement; key: string } | null>(null)
  const bindings = useAppStore(state => state.spaceZoneBindings)
  const iconTarget = useMemo(() => topicSpaceIconTarget(scope.workspace, scope.topic, bindings), [scope.workspace, scope.topic, bindings])
  const icon = useAppStore(state => iconTarget ? state.spaceObjectIcons[iconTarget.key] ?? null : null)
  const sessionId = useAppStore(state => {
    const layout = state.layouts[scope.workspace.id], group = layout?.groups.find(item => item.id === layout.activeGroupId)
    const tab = state.tabs[reference ? reference.tabId : reference === null ? '' : group?.activeTabId ?? '']
    const region = tab?.topicId === scope.topic.id ? tab.regions[reference?.regionId ?? tab.layout.activeRegionId] : undefined
    return region?.kind === 'agent' ? region.sessionId : undefined
  })
  const heldStatus = useRef<{ sessionId: string | undefined; status: Pick<SessionSnapshot['status'], 'state' | 'source'> | undefined } | null>(null)
  const observedStatus = useAppStore(useShallow(state => {
    if (!active || section !== 'profile') return null
    const session = sessionId ? sessionPresentationById(state.sessions).get(sessionId) : undefined
    return session ? { state: session.status.state, source: session.status.source } : undefined
  }))
  if (observedStatus !== null) heldStatus.current = { sessionId, status: observedStatus }
  if (!heldStatus.current || heldStatus.current.sessionId !== sessionId) {
    const session = sessionId ? sessionPresentationById(useAppStore.getState().sessions).get(sessionId) : undefined
    heldStatus.current = { sessionId, status: session ? { state: session.status.state, source: session.status.source } : undefined }
  }
  const status = heldStatus.current.status
  const returnFocus = (invoker: { node: HTMLButtonElement; key: string } | null) =>
    iconTarget && invoker?.key === iconTarget.key && invoker.node.isConnected ? invoker.node : null
  const identity = <>
    <div className="mote-details__identity">
          <button type="button" className="icon-button mote-details__avatar" aria-label="Change Mote avatar" title="Change Mote avatar" onClick={event => {
            if (!iconTarget) { useAppStore.getState().reportError(new Error('The original avatar identity is unconfirmed. Its existing appearance and workface are kept; repair the same directory record.')); return }
            avatarInvoker.current = { node: event.currentTarget, key: iconTarget.key }
            setAvatar({ ...iconTarget, name: scope.topic.title })
          }}>
            <SpaceObjectIcon kind="mote" name={scope.topic.title} manualIcon={icon} avatarObjectKey={iconTarget?.key}
              avatarWorkspaceId={scope.workspace.id} avatarTopicId={scope.topic.id} moteSessionId={sessionId}
              visible={active} moteHostId={scope.workspace.hostId} moteAvailability={sessionId ? 'restoring' : reference === null ? 'restoring' : 'no-agent'} />
          </button>
          <div><div className="mote-details__name"><strong>{scope.topic.title}</strong><button type="button" className="icon-button" aria-label="Rename Mote" title="Rename Mote" onClick={event => {
            renameInvoker.current = { node: event.currentTarget, key: scope.topic.id }
            setRename({ topic: { ...scope.topic }, workspace: { ...scope.workspace } })
          }}><Pencil size={12} /></button></div><span className="mote-details__status">{status ? <><StatusDot status={status} />{status.state}</> : sessionId || reference === null ? 'Status not confirmed' : 'No Agent selected'}</span></div>
        </div>
        {scope.topic.summary ? <p>{scope.topic.summary}</p> : null}
  </>
  return <section className="mote-details" data-mote-details={scope.topic.id}>
    <div className="source-control-switch" role="tablist" aria-label="Mote details" onKeyDown={event => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
      const controls = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]')]
      const index = controls.indexOf(event.target as HTMLButtonElement)
      if (index < 0) return
      event.preventDefault()
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? controls.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + controls.length) % controls.length
      controls[next]!.click(); controls[next]!.focus()
    }}>
      <LiquidSelectionSurface selected={section} active={active} targetAttribute="data-mote-section" />
      {(['profile', 'ideas'] as const).map(id => <button type="button" key={id} role="tab" data-mote-section={id}
      aria-selected={section === id} tabIndex={section === id ? 0 : -1} className={section === id ? 'selected' : ''}
      onClick={() => setSection(id)}>{id === 'profile' ? 'Profile' : 'Ideas'}</button>)}</div>
    <MoteContent key={JSON.stringify([scope.workspace.id, scope.workspace.hostId, scope.workspace.path, scope.topic.id, scope.topic.directoryPath, scope.rootPath])}
      scope={scope} reference={reference} active={active} section={section} profile={identity} onShowIdeas={() => setSection('ideas')} onOpenPath={onOpenPath} onCreateNote={onCreateNote} />
    <MoteRenameDialog target={rename} onClose={() => setRename(null)} returnFocus={() => renameInvoker.current?.key === scope.topic.id && renameInvoker.current.node.isConnected ? renameInvoker.current.node : null} />
    <SpaceIconPicker target={avatar} onClose={() => setAvatar(null)} returnFocus={() => returnFocus(avatarInvoker.current)} />
  </section>
}

function MoteContent({ scope, reference, section, profile, onShowIdeas, onOpenPath, onCreateNote, active }: {
  scope: MoteWorkfaceScope; reference?: WorkbenchProjectionSelection | null | undefined; section: MoteSection; profile: ReactNode; active: boolean; onShowIdeas(): void
  onOpenPath(path: string): Promise<unknown>; onCreateNote(): void
}) {
  const tree = useWorkspaceFileTree(scope.workspace.id, NO_EXPANDED_PATHS, scope.rootPath, active)
  const revision = useMoteFileRevision(scope.workspace.id, active)
  const refresh = useRef(tree.refreshTree); refresh.current = tree.refreshTree
  const observedRevision = useRef(revision)
  useEffect(() => {
    if (!active || observedRevision.current === revision || tree.rootCache?.loading) return
    observedRevision.current = revision
    // An absent cache is already admitted by the original tree's initial auto read.
    if (tree.rootCache) void refresh.current()
  }, [active, revision, tree.rootCache?.loading])
  const [selected, setSelected] = useState<string | null>(null)
  const [note, setNote] = useState<{ path: string; content: string; revision: string } | null>(null)
  const [issue, setIssue] = useState<string | null>(null), [loading, setLoading] = useState(false), [attempt, setAttempt] = useState(0)
  const [behaviorOpen, setBehaviorOpen] = useState(false)
  const behaviorInvoker = useRef<HTMLElement | null>(null)
  useEffect(() => { setBehaviorOpen(false) }, [section])
  const noteRequest = useMemo(() => ({}), [scope.workspace.id, section, selected, attempt, revision])
  const currentNote = useRef<object | null>(noteRequest); currentNote.current = noteRequest
  const admittedNote = useRef<object | null>(null)
  useEffect(() => () => { currentNote.current = null }, [])
  useEffect(() => {
    currentNote.current = noteRequest
    if (!active || !selected || section !== 'ideas' || admittedNote.current === noteRequest) return
    admittedNote.current = noteRequest; setLoading(true); setIssue(null)
    void readMoteMaterial(scope, selected).then(observation => {
      if (currentNote.current !== noteRequest) return
      const result = observation.result
      if (result.status === 'read') setNote({ path: selected, content: result.document.content, revision: result.document.revision })
      else setIssue(result.status === 'unknown' || result.status === 'error' ? result.message : result.status === 'deleted'
        ? 'The original file is no longer present. Any last confirmed content is kept below; inspect its folder.'
        : result.status === 'directory' ? 'This is a directory. Inspect it in the original file tree.'
        : 'The original file contains binary data. Open its file to inspect it.')
    }).catch(error => { if (currentNote.current === noteRequest) setIssue(presentError(error)) })
      .finally(() => { if (currentNote.current === noteRequest) setLoading(false) })
  }, [active, noteRequest])
  const notes = (tree.rootCache?.children ?? []).filter(entry => !entry.isDirectory && /\.(md|txt)$/i.test(entry.name) && !['SOUL.md', 'topic.md'].includes(entry.name))
  const recent = notes.filter(entry => typeof entry.mtimeMs === 'number' && Number.isFinite(entry.mtimeMs))
    .sort((a, b) => b.mtimeMs! - a.mtimeMs!).slice(0, 3)
  const notesIssue = <>
    {tree.rootError ? <div role="status" className="mote-details__issue">{tree.rootError}<button type="button" className="small-button" onClick={() => void tree.refreshTree()}>Retry notes</button></div> : null}
    {tree.rootCache?.loading ? <p role="status" className="mote-details__hint">Reading notes…</p> : null}
  </>
  return <div key={section} className="mote-details__content" role="tabpanel" aria-label={section === 'profile' ? 'Mote profile' : 'Mote ideas'}>
    {section === 'profile' ? <>
      <div className="mote-details__profile">{profile}</div>
      <MoteFirstCooperation scope={scope} reference={reference} />
      <MoteCurrentWork scope={scope} reference={reference} active={active} />
      <MoteBehaviorSummary scope={scope} active={active} onEdit={() => { behaviorInvoker.current = document.activeElement as HTMLElement; setBehaviorOpen(true) }} onOpenPath={onOpenPath} />
      {behaviorOpen ? <MoteBehaviorDialog scope={scope} reference={reference} onOpenPath={onOpenPath}
        onClose={() => setBehaviorOpen(false)} returnFocus={() => behaviorInvoker.current?.isConnected ? behaviorInvoker.current : null} /> : null}
      <div className="mote-details__recent">
        <div className="mote-details__section-actions"><span>Recent ideas</span><MoteBehaviorAction label="View ideas and saved materials" onClick={onShowIdeas}><ArrowRight size={16} /></MoteBehaviorAction></div>
        {notesIssue}
        {!tree.rootCache?.loading && recent.length > 0 && notes.some(entry => typeof entry.mtimeMs !== 'number' || !Number.isFinite(entry.mtimeMs)) ? <p role="status" className="mote-details__hint">Some recent updates are not confirmed. All notes remain in Ideas.</p> : null}
        <div className="mote-details__notes">{recent.map(entry => <button type="button" key={entry.path} className="mote-details__note" onClick={() => { setSelected(entry.path); onShowIdeas() }}><FileText size={13} /><span>{entry.name.replace(/\.(md|txt)$/i, '')}</span></button>)}</div>
        {!tree.rootCache?.loading && !recent.length && !tree.rootError ? <p className="mote-details__hint">{notes.length ? 'Recent updates are not confirmed. All notes remain in Ideas.' : 'No ideas here yet.'}</p> : null}
      </div>
    </> : <>
      <MoteIdeaControls scope={scope} reference={reference} material={note?.path === selected && !issue && !loading ? note : null} onOpenPath={onOpenPath} />
      <div className="mote-details__section-actions"><span>Notes in this folder</span><button type="button" className="small-button" onClick={onCreateNote}><Plus size={12} /> New note</button></div>
      {notesIssue}
      {!tree.rootCache?.loading && !notes.length && !tree.rootError ? <p className="mote-details__hint">No notes here yet. Capture a thought in a file, then continue the discussion.</p> : null}
      <div className="mote-details__notes">{notes.map(entry => <button type="button" key={entry.path} aria-pressed={selected === entry.path}
        className="mote-details__note" onClick={() => setSelected(entry.path)}><FileText size={13} /><span>{entry.name.replace(/\.(md|txt)$/i, '')}<small>{entry.path.slice(scope.rootPath.length + 1)}</small></span></button>)}</div>
      {selected ? <div className="mote-details__preview">
        <div className="mote-details__section-actions"><span>{selected.slice(scope.rootPath.length + 1)}</span><button type="button" className="small-button" onClick={() => void onOpenPath(selected)}>Open file</button></div>
        <p className="mote-details__hint mote-details__source" title={scope.workspace.path + '/' + selected}>{scope.topic.title} · {selected}</p>
        <p className="mote-details__hint">Source and scope are available when recorded in this file. Agent use is not confirmed.</p>
        {loading ? <p role="status">Reading note…</p> : null}
        {issue ? <div role="status" className="mote-details__issue">{issue}<button type="button" className="small-button" onClick={() => setAttempt(value => value + 1)}>Retry</button></div> : null}
        {active && note?.path === selected ? <><p className="mote-details__hint" title={note.revision}>{issue || loading ? 'Last confirmed saved content' : 'Read from the saved file'}</p><AgentMarkdown content={note.content} className="mote-details__prose" workspaceRoot={scope.workspace.path}
          sourcePath={selected} openWorkspaceFile={path => { void onOpenPath(path) }} /></> : null}
        <button type="button" className="small-button" onClick={() => void onOpenPath(selected)}>Correct or remove a detail in editor</button>
        <p className="mote-details__hint">Edit only what should change, then Save. File changes keep the original conversations and existing Session context.</p>
      </div> : null}
      <p className="mote-details__hint">Notes stay in your files. Use the file tree for other folders and formats.</p>
    </>}
  </div>
}

/** Confirmed summary is derived only from the current original saved file, never a local form. */
function MoteBehaviorSummary({ scope, onEdit, onOpenPath, active }: {
  scope: MoteWorkfaceScope; active: boolean; onEdit(): void; onOpenPath(path: string): Promise<unknown>
}) {
  const key = documentKey(scope.workspace.id, scope.rootPath + '/' + MOTE_SOUL_PATH)
  const snapshot = () => {
    const state = useAppStore.getState()
    return { revision: state.workspaceFileRevisions[scope.workspace.id] ?? 0,
      documentIssue: state.documentIssues[key]?.kind, savedRevision: state.documents[key]?.revision }
  }
  const observed = useAppStore(useShallow(state => active ? {
    revision: state.workspaceFileRevisions[scope.workspace.id] ?? 0,
    documentIssue: state.documentIssues[key]?.kind, savedRevision: state.documents[key]?.revision
  } : null))
  const retained = useRef(observed ?? snapshot())
  if (observed !== null) retained.current = observed
  const { revision, documentIssue, savedRevision } = retained.current
  const [saved, setSaved] = useState<{ content: string; revision: string } | null>(null)
  const [issue, setIssue] = useState<string | null>(null), [loading, setLoading] = useState(false), [attempt, setAttempt] = useState(0)
  const [soulOpen, setSoulOpen] = useState(false)
  const request = useMemo(() => ({}), [revision, attempt, documentIssue, savedRevision])
  const current = useRef<object | null>(request); current.current = request
  const admitted = useRef<object | null>(null)
  useEffect(() => () => { current.current = null }, [])
  useEffect(() => {
    current.current = request
    if (!active || admitted.current === request) return
    admitted.current = request; setLoading(true); setIssue(null)
    void readMoteMaterial(scope, scope.rootPath + '/' + MOTE_SOUL_PATH).then(observation => {
      if (current.current !== request) return
      const result = observation.result
      if (result.status === 'read') setSaved(result.document)
      else setIssue('Saved behavior is unconfirmed. ' + (result.status === 'unknown' || result.status === 'error' ? result.message : result.status))
    }).catch(cause => { if (current.current === request) setIssue(presentError(cause)) })
      .finally(() => { if (current.current === request) setLoading(false) })
  }, [active, request])
  const parsed = useMemo(() => saved ? parseMoteBehaviorBlock(saved.content) : null, [saved?.content])
  const confirmed = !loading && !issue && !documentIssue && parsed?.status === 'valid' ? parsed : null
  const summary = confirmed ? MOTE_BEHAVIOR_AXES.map(axis => axis.choices.find(choice => choice.value === confirmed.preferences[axis.id])!.title).join(' · ') : null
  return <div className="mote-details__self mote-behavior-summary">
    <div className="mote-details__section-actions"><span>Behavior</span><MoteBehaviorAction label="Edit behavior settings" onClick={onEdit}><Pencil size={14} /></MoteBehaviorAction></div>
    {confirmed ? <><span className="mote-behavior-summary__tag">MBTI style · {confirmed.code}</span><p className="mote-behavior-summary__rules" title={summary!}>{summary}</p></> : <p className="mote-details__hint">{loading ? 'Reading saved behavior…' : !admitted.current ? 'Saved behavior not read yet.' : issue || documentIssue ? 'Saved behavior is unconfirmed.' : parsed?.status === 'unconfirmed' ? 'Original behavior needs review.' : 'Not set yet.'}</p>}
    {issue ? <div role="status" className="mote-details__issue">{issue}<button type="button" className="small-button" onClick={() => setAttempt(value => value + 1)}>Retry settings</button></div> : null}
    <details className="mote-details__soul" onToggle={event => setSoulOpen(event.currentTarget.open)}><summary>Original SOUL</summary>
      {active && soulOpen && (saved || scope.topic.soul) ? <AgentMarkdown content={saved?.content ?? scope.topic.soul!.content} className="mote-details__prose" sourcePath={scope.rootPath + '/' + MOTE_SOUL_PATH}
        workspaceRoot={scope.workspace.path} openWorkspaceFile={path => { void onOpenPath(path) }} /> : soulOpen && !saved && !scope.topic.soul ? <p className="mote-details__hint">Open the original file to inspect it.</p> : null}
      <p className="mote-details__hint">Saved changes apply to new Sessions. Current discussions keep their context; your current directions take priority.</p>
      <button type="button" className="small-button" onClick={() => void onOpenPath(scope.rootPath + '/' + MOTE_SOUL_PATH)}>Open original SOUL</button>
    </details>
  </div>
}

/** Pause only automatic observation; the last displayed original revision remains honest. */
function useMoteFileRevision(workspaceId: string, active: boolean): number {
  const observed = useAppStore(state => active ? state.workspaceFileRevisions[workspaceId] ?? 0 : null)
  const held = useRef(observed ?? useAppStore.getState().workspaceFileRevisions[workspaceId] ?? 0)
  if (observed !== null) held.current = observed
  return held.current
}
