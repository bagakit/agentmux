import { useEffect, useMemo, useRef, useState } from 'react'
import { FileText, Lightbulb, Pencil, Plus, Smile } from 'lucide-react'
import { AgentMarkdown } from '@agentmux/client-ui/components/AgentMarkdown'
import { presentError } from '@agentmux/client-ui/error-presentation'
import { MOTE_SOUL_PATH } from '../../../shared/scratch-topics'
import { api } from '../lib/api'
import type { MoteWorkfaceScope } from '../lib/mote-workface'
import type { WorkbenchProjectionSelection } from '../lib/workbench-projection'
import { topicSpaceIconTarget } from '../lib/space-object-appearance'
import { sessionPresentationById } from '../lib/session-presentation'
import { useAppStore } from '../store'
import { useWorkspaceFileTree } from './file-tree/useWorkspaceFileTree'
import { SpaceObjectIcon } from './SpaceObjectIcon'
import { SpaceIconPicker } from './SpaceIconPicker'
import { MoteRenameDialog } from './MoteRenameDialog'
import { StatusDot } from './StatusDot'

const NO_EXPANDED_PATHS: ReadonlySet<string> = new Set()
type MoteSection = 'profile' | 'persona' | 'ideas'

/** Object content in the shared tools frame. Files and conversations keep their original owners. */
export function MoteDetailsPanel({ scope, reference, onOpenPath, onCreateNote }: {
  scope: MoteWorkfaceScope; reference?: WorkbenchProjectionSelection | null | undefined
  onOpenPath(path: string): Promise<unknown>; onCreateNote(): void
}) {
  const [section, setSection] = useState<MoteSection>('profile')
  const [rename, setRename] = useState(false), [avatar, setAvatar] = useState(false)
  const panel = useRef<HTMLElement>(null)
  const iconTarget = useMemo(() => topicSpaceIconTarget(scope.workspace, scope.topic), [scope.workspace, scope.topic])
  const icon = useAppStore(state => state.spaceObjectIcons[iconTarget.key] ?? null)
  const sessionId = useAppStore(state => {
    const layout = state.layouts[scope.workspace.id], group = layout?.groups.find(item => item.id === layout.activeGroupId)
    const tab = state.tabs[reference ? reference.tabId : reference === null ? '' : group?.activeTabId ?? '']
    const region = tab?.topicId === scope.topic.id ? tab.regions[reference?.regionId ?? tab.layout.activeRegionId] : undefined
    return region?.kind === 'agent' ? region.sessionId : undefined
  })
  const session = useAppStore(state => sessionId ? sessionPresentationById(state.sessions).get(sessionId) : undefined)
  const returnFocus = () => panel.current?.querySelector<HTMLButtonElement>('[role="tab"][aria-selected="true"]') ?? null
  return <section className="mote-details" ref={panel} data-mote-details={scope.topic.id}>
    <div className="source-control-switch" role="tablist" aria-label="Mote details" onKeyDown={event => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
      const controls = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]')]
      const index = controls.indexOf(event.target as HTMLButtonElement)
      if (index < 0) return
      event.preventDefault()
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? controls.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + controls.length) % controls.length
      controls[next]!.click(); controls[next]!.focus()
    }}>{(['profile', 'persona', 'ideas'] as const).map(id => <button type="button" key={id} role="tab"
      aria-selected={section === id} tabIndex={section === id ? 0 : -1} className={section === id ? 'selected' : ''}
      onClick={() => setSection(id)}>{id === 'profile' ? 'Profile' : id === 'persona' ? 'Persona' : 'Ideas'}</button>)}</div>
    <div key={section} className="mote-details__content" role="tabpanel" aria-label={section === 'profile' ? 'Mote profile' : section === 'persona' ? 'Mote persona' : 'Mote ideas'}>
      {section === 'profile' ? <>
        <div className="mote-details__identity">
          <button type="button" className="mote-details__avatar" aria-label="Change Mote avatar" onClick={() => setAvatar(true)}>
            <SpaceObjectIcon kind="mote" name={scope.topic.title} manualIcon={icon} avatarObjectKey={iconTarget.key}
              avatarWorkspaceId={scope.workspace.id} avatarTopicId={scope.topic.id} moteSessionId={sessionId}
              moteHostId={scope.workspace.hostId} moteAvailability={sessionId ? 'restoring' : reference === null ? 'restoring' : 'no-agent'} />
          </button>
          <div><strong>{scope.topic.title}</strong><span className="mote-details__status">{session ? <><StatusDot status={session.status} />{session.status.state}</> : sessionId || reference === null ? 'Status not confirmed' : 'No Agent selected'}</span></div>
        </div>
        {scope.topic.summary ? <p>{scope.topic.summary}</p> : <p className="mote-details__hint">A lasting collaborator. Discussions and notes belong to this Mote.</p>}
        <div className="mote-details__actions"><button type="button" className="small-button" onClick={() => setRename(true)}><Pencil size={12} /> Rename</button>
          <button type="button" className="small-button" onClick={() => setAvatar(true)}><Smile size={12} /> Avatar</button></div>
        <button type="button" className="mote-details__link" onClick={() => setSection('persona')}><FileText size={13} /> Read self setting</button>
        <button type="button" className="mote-details__link" onClick={() => setSection('ideas')}><Lightbulb size={13} /> Explore notes and ideas</button>
      </> : section === 'persona' ? <>
        <div className="mote-details__section-actions"><span>SOUL.md</span><button type="button" className="small-button" onClick={() => void onOpenPath(scope.rootPath + '/' + MOTE_SOUL_PATH)}><Pencil size={12} /> Edit</button></div>
        {scope.topic.soul ? <AgentMarkdown content={scope.topic.soul.content} className="mote-details__prose" sourcePath={scope.rootPath + '/' + MOTE_SOUL_PATH}
          workspaceRoot={scope.workspace.path} openWorkspaceFile={path => { void onOpenPath(path) }} /> : <p role="status">Self setting is not confirmed yet. Open the original file to inspect it.</p>}
      </> : <MoteIdeas key={JSON.stringify([scope.workspace.id, scope.workspace.hostId, scope.workspace.path, scope.topic.id, scope.topic.directoryPath, scope.rootPath])} scope={scope} onOpenPath={onOpenPath} onCreateNote={onCreateNote} />}
    </div>
    <MoteRenameDialog target={rename ? { topic: scope.topic, workspace: scope.workspace } : null} onClose={() => setRename(false)} returnFocus={returnFocus} />
    <SpaceIconPicker target={avatar ? iconTarget : null} onClose={() => setAvatar(false)} returnFocus={returnFocus} />
  </section>
}

function MoteIdeas({ scope, onOpenPath, onCreateNote }: {
  scope: MoteWorkfaceScope; onOpenPath(path: string): Promise<unknown>; onCreateNote(): void
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
    if (!selected) return
    let current = true; setLoading(true); setIssue(null)
    void api.files.read(scope.workspace.id, selected).then(result => {
      if (!current) return
      if (result.status === 'read') setNote({ path: selected, content: result.document.content })
      else setIssue('The original note is not readable as text. Open its file to inspect it.')
    }).catch(error => { if (current) setIssue(presentError(error)) }).finally(() => { if (current) setLoading(false) })
    return () => { current = false }
  }, [scope.workspace.id, selected, attempt, revision])
  const notes = (tree.rootCache?.children ?? []).filter(entry => !entry.isDirectory && /\.(md|txt)$/i.test(entry.name) && !['SOUL.md', 'topic.md'].includes(entry.name))
  return <>
    <div className="mote-details__section-actions"><span>Notes in this folder</span><button type="button" className="small-button" onClick={onCreateNote}><Plus size={12} /> New note</button></div>
    {tree.rootError ? <div role="status" className="mote-details__issue">{tree.rootError}<button type="button" className="small-button" onClick={() => void tree.refreshTree()}>Retry notes</button></div> : null}
    {tree.rootCache?.loading ? <p role="status" className="mote-details__hint">Reading notes…</p> : !notes.length && !tree.rootError ? <p className="mote-details__hint">No notes here yet. Capture a thought in a file, then continue the discussion.</p> : null}
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
  </>
}
