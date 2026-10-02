import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { FileText, Pencil, Plus } from 'lucide-react'
import { AgentMarkdown } from '@agentmux/client-ui/components/AgentMarkdown'
import { presentError } from '@agentmux/client-ui/error-presentation'
import { MOTE_SOUL_PATH } from '../../../shared/scratch-topics'
import { api } from '../lib/api'
import type { MoteWorkfaceScope } from '../lib/mote-workface'
import type { WorkbenchProjectionSelection } from '../lib/workbench-projection'
import { topicSpaceIconTarget, type SpaceIconTarget } from '../lib/space-object-appearance'
import { sessionPresentationById } from '../lib/session-presentation'
import { useAppStore } from '../store'
import { useWorkspaceFileTree } from './file-tree/useWorkspaceFileTree'
import { SpaceObjectIcon } from './SpaceObjectIcon'
import { SpaceIconPicker } from './SpaceIconPicker'
import { MoteRenameDialog } from './MoteRenameDialog'
import { StatusDot } from './StatusDot'

const NO_EXPANDED_PATHS: ReadonlySet<string> = new Set()
type MoteSection = 'profile' | 'ideas'

/** Object content in the shared tools frame. Files and conversations keep their original owners. */
export function MoteDetailsPanel({ scope, reference, onOpenPath, onCreateNote }: {
  scope: MoteWorkfaceScope; reference?: WorkbenchProjectionSelection | null | undefined
  onOpenPath(path: string): Promise<unknown>; onCreateNote(): void
}) {
  const [section, setSection] = useState<MoteSection>('profile')
  const [rename, setRename] = useState<Pick<MoteWorkfaceScope, 'topic' | 'workspace'> | null>(null)
  const [avatar, setAvatar] = useState<SpaceIconTarget | null>(null)
  const renameInvoker = useRef<{ node: HTMLButtonElement; key: string } | null>(null)
  const avatarInvoker = useRef<{ node: HTMLButtonElement; key: string } | null>(null)
  const iconTarget = useMemo(() => topicSpaceIconTarget(scope.workspace, scope.topic), [scope.workspace, scope.topic])
  const icon = useAppStore(state => state.spaceObjectIcons[iconTarget.key] ?? null)
  const sessionId = useAppStore(state => {
    const layout = state.layouts[scope.workspace.id], group = layout?.groups.find(item => item.id === layout.activeGroupId)
    const tab = state.tabs[reference ? reference.tabId : reference === null ? '' : group?.activeTabId ?? '']
    const region = tab?.topicId === scope.topic.id ? tab.regions[reference?.regionId ?? tab.layout.activeRegionId] : undefined
    return region?.kind === 'agent' ? region.sessionId : undefined
  })
  const session = useAppStore(state => sessionId ? sessionPresentationById(state.sessions).get(sessionId) : undefined)
  const returnFocus = (invoker: { node: HTMLButtonElement; key: string } | null) =>
    invoker?.key === iconTarget.key && invoker.node.isConnected ? invoker.node : null
  const identity = <>
    <div className="mote-details__identity">
          <button type="button" className="icon-button mote-details__avatar" aria-label="Change Mote avatar" title="Change Mote avatar" onClick={event => {
            avatarInvoker.current = { node: event.currentTarget, key: iconTarget.key }
            setAvatar({ ...iconTarget, name: scope.topic.title })
          }}>
            <SpaceObjectIcon kind="mote" name={scope.topic.title} manualIcon={icon} avatarObjectKey={iconTarget.key}
              avatarWorkspaceId={scope.workspace.id} avatarTopicId={scope.topic.id} moteSessionId={sessionId}
              moteHostId={scope.workspace.hostId} moteAvailability={sessionId ? 'restoring' : reference === null ? 'restoring' : 'no-agent'} />
          </button>
          <div><div className="mote-details__name"><strong>{scope.topic.title}</strong><button type="button" className="icon-button" aria-label="Rename Mote" title="Rename Mote" onClick={event => {
            renameInvoker.current = { node: event.currentTarget, key: iconTarget.key }
            setRename({ topic: { ...scope.topic }, workspace: { ...scope.workspace } })
          }}><Pencil size={12} /></button></div><span className="mote-details__status">{session ? <><StatusDot status={session.status} />{session.status.state}</> : sessionId || reference === null ? 'Status not confirmed' : 'No Agent selected'}</span></div>
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
    }}>{(['profile', 'ideas'] as const).map(id => <button type="button" key={id} role="tab"
      aria-selected={section === id} tabIndex={section === id ? 0 : -1} className={section === id ? 'selected' : ''}
      onClick={() => setSection(id)}>{id === 'profile' ? 'Profile' : 'Ideas'}</button>)}</div>
    <MoteContent key={JSON.stringify([scope.workspace.id, scope.workspace.hostId, scope.workspace.path, scope.topic.id, scope.topic.directoryPath, scope.rootPath])}
      scope={scope} section={section} profile={identity} onShowIdeas={() => setSection('ideas')} onOpenPath={onOpenPath} onCreateNote={onCreateNote} />
    <MoteRenameDialog target={rename} onClose={() => setRename(null)} returnFocus={() => returnFocus(renameInvoker.current)} />
    <SpaceIconPicker target={avatar} onClose={() => setAvatar(null)} returnFocus={() => returnFocus(avatarInvoker.current)} />
  </section>
}

function MoteContent({ scope, section, profile, onShowIdeas, onOpenPath, onCreateNote }: {
  scope: MoteWorkfaceScope; section: MoteSection; profile: ReactNode; onShowIdeas(): void
  onOpenPath(path: string): Promise<unknown>; onCreateNote(): void
}) {
  const tree = useWorkspaceFileTree(scope.workspace.id, NO_EXPANDED_PATHS, scope.rootPath)
  const revision = useAppStore(state => state.workspaceFileRevisions[scope.workspace.id] ?? 0)
  const refresh = useRef(tree.refreshTree); refresh.current = tree.refreshTree
  const observedRevision = useRef(revision)
  useEffect(() => { if (observedRevision.current !== revision) { observedRevision.current = revision; void refresh.current() } }, [revision])
  const [selected, setSelected] = useState<string | null>(null)
  const [note, setNote] = useState<{ path: string; content: string } | null>(null)
  const [issue, setIssue] = useState<string | null>(null), [loading, setLoading] = useState(false), [attempt, setAttempt] = useState(0)
  useEffect(() => {
    if (!selected || section !== 'ideas') return
    let current = true; setLoading(true); setIssue(null)
    void api.files.read(scope.workspace.id, selected).then(result => {
      if (!current) return
      if (result.status === 'read') setNote({ path: selected, content: result.document.content })
      else setIssue('The original note is not readable as text. Open its file to inspect it.')
    }).catch(error => { if (current) setIssue(presentError(error)) }).finally(() => { if (current) setLoading(false) })
    return () => { current = false }
  }, [scope.workspace.id, section, selected, attempt, revision])
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
      <div className="mote-details__self">
        <div className="mote-details__section-actions"><span>Self setting</span><button type="button" className="icon-button" aria-label="Edit self setting" title="Edit self setting" onClick={() => void onOpenPath(scope.rootPath + '/' + MOTE_SOUL_PATH)}><Pencil size={12} /></button></div>
        {scope.topic.soul ? <AgentMarkdown content={scope.topic.soul.content} className="mote-details__prose" sourcePath={scope.rootPath + '/' + MOTE_SOUL_PATH}
          workspaceRoot={scope.workspace.path} openWorkspaceFile={path => { void onOpenPath(path) }} /> : <p role="status" className="mote-details__hint">Self setting is not confirmed yet. Open the original file to inspect it.</p>}
      </div>
      <div className="mote-details__recent">
        <div className="mote-details__section-actions"><span>Recent ideas</span></div>
        {notesIssue}
        {!tree.rootCache?.loading && recent.length > 0 && notes.some(entry => typeof entry.mtimeMs !== 'number' || !Number.isFinite(entry.mtimeMs)) ? <p role="status" className="mote-details__hint">Some recent updates are not confirmed. All notes remain in Ideas.</p> : null}
        <div className="mote-details__notes">{recent.map(entry => <button type="button" key={entry.path} className="mote-details__note" onClick={() => { setSelected(entry.path); onShowIdeas() }}><FileText size={13} /><span>{entry.name.replace(/\.(md|txt)$/i, '')}</span></button>)}</div>
        {!tree.rootCache?.loading && !recent.length && !tree.rootError ? <p className="mote-details__hint">{notes.length ? 'Recent updates are not confirmed. All notes remain in Ideas.' : 'No ideas here yet.'}</p> : null}
      </div>
    </> : <>
      <div className="mote-details__section-actions"><span>Notes in this folder</span><button type="button" className="small-button" onClick={onCreateNote}><Plus size={12} /> New note</button></div>
      {notesIssue}
      {!tree.rootCache?.loading && !notes.length && !tree.rootError ? <p className="mote-details__hint">No notes here yet. Capture a thought in a file, then continue the discussion.</p> : null}
      <div className="mote-details__notes">{notes.map(entry => <button type="button" key={entry.path} aria-pressed={selected === entry.path}
        className="mote-details__note" onClick={() => setSelected(entry.path)}><FileText size={13} /><span>{entry.name.replace(/\.(md|txt)$/i, '')}<small>{entry.path.slice(scope.rootPath.length + 1)}</small></span></button>)}</div>
      {selected ? <div className="mote-details__preview">
        <div className="mote-details__section-actions"><span>{selected.slice(scope.rootPath.length + 1)}</span><button type="button" className="small-button" onClick={() => void onOpenPath(selected)}>Open file</button></div>
        {loading ? <p role="status">Reading note…</p> : null}
        {issue ? <div role="status" className="mote-details__issue">{issue}<button type="button" className="small-button" onClick={() => setAttempt(value => value + 1)}>Retry</button></div> : null}
        {note?.path === selected ? <AgentMarkdown content={note.content} className="mote-details__prose" workspaceRoot={scope.workspace.path}
          sourcePath={selected} openWorkspaceFile={path => { void onOpenPath(path) }} /> : null}
      </div> : null}
      <p className="mote-details__hint">Notes stay in your files. Use the file tree for other folders and formats.</p>
    </>}
  </div>
}
