import { TextInput } from '@agentmux/client-ui/input'
import * as Menu from '@radix-ui/react-dropdown-menu'
import { useEffect, useMemo, useRef, useState } from 'react'
import { semanticIconComponent } from '@agentmux/client-ui/icons'
import { notebookFingerprint, notebookPageArchiveRoot, type NotebookActor, type NotebookPage } from '@agentmux/core/notebook-catalog'
import { useWorkbenchPresentationActive } from '../lib/workbench-presentation'
import { resolveOverlayContainer } from './WindowOverlayHost'
import { useNotebookLibrary } from '../lib/notebook-library'
import { notebookDescendants, notebookPageRows } from '../lib/notebook-page-tree'
import { presentError } from '@agentmux/client-ui/error-presentation'
import { useAppStore } from '../store'
import type { SurveyBrowserPreparation } from '../lib/survey-browser-creation'
import { spatialSources } from '../../../shared/space-addresses'
import { NotebookOperationIssue, useNotebookOperation } from './NotebookOperation'
import { SCRATCH_WORKSPACE_ID } from '../../../shared/scratch-topics'
import { scratchTopicsForWorkspace } from '../lib/scratch-topic-snapshots'
import { api } from '../lib/api'

const ThemeNavigationDisclosureIcon = semanticIconComponent('navigation.disclosure')
const ThemeActionOpenFolderIcon = semanticIconComponent('action.open-folder')
const ThemeObjectLinkIcon = semanticIconComponent('object.link')
const ThemeObjectHistoryIcon = semanticIconComponent('object.history')
const ThemeActionMoreIcon = semanticIconComponent('action.more')
const ThemeActionRestoreIcon = semanticIconComponent('action.restore')
const ThemeActionArchiveIcon = semanticIconComponent('action.archive')
const ThemeActionSaveIcon = semanticIconComponent('action.save')
const ThemeActionOpenExternalIcon = semanticIconComponent('action.open-external')
const ThemeObjectBookmarkIcon = semanticIconComponent('object.bookmark')
const ThemeObjectTeamIcon = semanticIconComponent('object.team')


export function NotebookPageDetails({ page }: { page: NotebookPage }) {
  const visible = useWorkbenchPresentationActive()
  const [menuOpen, setMenuOpen] = useState(false)
  useEffect(() => { if (!visible) setMenuOpen(false) }, [visible])
  useEffect(() => setMenuOpen(false), [page.noteId])
  const library = useNotebookLibrary(state => state.state), book = library?.notebooks[page.notebookId]
  const config = useAppStore(state => state.config), snapshots = useAppStore(state => state.scratchTopicSnapshots)
  const topicNames = useMemo(() => new Map(spatialSources(config, scratchTopicsForWorkspace(snapshots,
    config?.workspaces.find(workspace => workspace.id === SCRATCH_WORKSPACE_ID)) ?? []).spaces.map(space => [space.spaceId, space.name])), [config, snapshots])
  const operation = useNotebookOperation(), [title, setTitle] = useState(page.title), [editing, setEditing] = useState(false)
  const [panel, setPanel] = useState<'move' | 'sources' | 'history' | 'followers' | null>(null)
  const followOperation = useNotebookOperation()
  const [self, setSelf] = useState<NotebookActor | null>(null), [actorIssue, setActorIssue] = useState<string | null>(null)
  const agentNames = useAppStore(state => state.agentNames)
  const followers = page.followers ?? []
  const following = self !== null && followers.some(f => f.actor.kind === self.kind && f.actor.id === self.id)
  async function refreshActor() {
    try { setSelf(await api.notebooks.actor()); setActorIssue(null) }
    catch (error) { setSelf(null); setActorIssue(presentError(error)) }
  }
  useEffect(() => {
    if (!visible) return
    let active = true
    void api.notebooks.actor().then(actor => { if (active) { setSelf(actor); setActorIssue(null) } }, error => { if (active) { setSelf(null); setActorIssue(presentError(error)) } })
    return () => { active = false }
  }, [visible])
  const [destination, setDestination] = useState(page.notebookId), [parentId, setParentId] = useState(page.parentNoteId ?? '')
  const [sourceIssue, setSourceIssue] = useState<string | null>(null)
  const cancelTitle = useRef(false)
  const sourceCreation = useRef<{ sourceId: string; prepared: SurveyBrowserPreparation | null } | null>(null)
  useEffect(() => { if (!editing && !operation.busy && !operation.issue) setTitle(page.title) }, [page.title, editing, operation.busy, operation.issue])
  const allPages = Object.values(library?.pages ?? {}), excluded = notebookDescendants(allPages, page.noteId)
  async function rename() {
    const value = title.trim(); if (!value) { setTitle(page.title); return }
    if (value === page.title) return
    await operation.run({ kind: 'rename-page', noteId: page.noteId, title: value })
  }
  async function move() {
    await operation.run({ kind: 'move', noteId: page.noteId, notebookId: destination, parentNoteId: parentId || null }, () => {
      const state = useAppStore.getState()
      if (state.recallNoteId === page.noteId) state.setRecallNotebook(destination, page.noteId)
      setPanel(null)
    })
  }
  async function openSource(source: NotebookPage['sources'][number]) {
    const before = useAppStore.getState(), heldSelection = before.recallZoneSelection
    if (sourceCreation.current && sourceCreation.current.sourceId !== source.sourceId) { setSourceIssue('The previous source page is still opening. Retry that same source; your Note and links are kept.'); return }
    sourceCreation.current ??= { sourceId: source.sourceId, prepared: null }; setSourceIssue(null)
    try {
      const created = await before.createSurveyBrowser({ workspaceId: page.resource.workspaceId, url: source.url, preparation: sourceCreation.current.prepared,
        onPrepared(prepared) { sourceCreation.current = { sourceId: source.sourceId, prepared } } })
      sourceCreation.current = null
      const now = useAppStore.getState()
      if (now.mainSurface !== before.mainSurface || now.recallZoneSelection !== heldSelection || now.recallNoteId !== before.recallNoteId) return
      now.setMainSurface('survey'); now.setSurveyZoneSelection({ zoneId: created.zone.zoneId, selection: [created.reference], active: created.reference })
    } catch (error) { setSourceIssue(presentError(error)) }
  }
  const archiveRoot = library ? notebookPageArchiveRoot(library.pages, page.noteId) : undefined
  const restoreLabel = archiveRoot && archiveRoot.noteId !== page.noteId ? 'Restore parent page' : 'Restore page'
  const events = library?.trail.filter(event => event.noteId === page.noteId).slice().reverse() ?? []
  const labels = { created: 'Created', moved: 'Moved', renamed: 'Renamed', 'source-added': 'Source added', organized: 'Added to Topic', relocated: 'File moved', archived: 'Archived', restored: 'Restored', followed: 'Followed', unfollowed: 'Unfollowed' }
  return <header className="notebook-page-heading" aria-label="Page details">
    <button className="notebook-breadcrumb" onClick={() => { const state = useAppStore.getState(); state.setRecallNotebook(page.notebookId); state.setRecallZoneSelection(null); state.setMainSurface('recall') }}>{book?.name ?? page.notebookId}<ThemeNavigationDisclosureIcon size={12} /></button>
    <TextInput className="notebook-page-title" aria-label="Page title" title={title} value={title} placeholder="Untitled note" disabled={operation.busy || Boolean(operation.issue)}
      onFocus={() => setEditing(true)} onChange={event => setTitle(event.target.value)} onBlur={() => { setEditing(false); if (cancelTitle.current) { cancelTitle.current = false; return } void rename() }}
      onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); event.currentTarget.blur() } if (event.key === 'Escape') { cancelTitle.current = true; setTitle(page.title); event.currentTarget.blur() } }} />
    <div className="notebook-page-actions">{(['move', 'sources', 'history'] as const).map(kind => {
      const Icon = kind === 'move' ? ThemeActionOpenFolderIcon : kind === 'sources' ? ThemeObjectLinkIcon : ThemeObjectHistoryIcon
      return <button className="note-text-button" key={kind} aria-label={kind === 'move' ? 'Move page' : kind === 'sources' ? 'Page sources' : 'Page history'} aria-expanded={panel === kind}
        onClick={() => { if (kind === 'move') { setDestination(page.notebookId); setParentId(page.parentNoteId ?? '') } setPanel(panel === kind ? null : kind) }}><Icon size={13} /><span>{kind === 'move' ? 'Move' : kind === 'sources' ? `Sources${page.sources.length ? ` · ${page.sources.length}` : ''}` : 'History'}</span></button>
    })}
      <button type="button" className="note-text-button notebook-follow-action" aria-label={following ? 'Unfollow page' : 'Follow page'} aria-pressed={self === null ? undefined : following}
        disabled={followOperation.busy || Boolean(followOperation.issue)} onClick={() => void followOperation.run({ kind: following ? 'unfollow' : 'follow', noteId: page.noteId })}>
        <ThemeObjectBookmarkIcon size={13} /><span>{following ? 'Following' : 'Follow'}</span>
      </button>
      <button type="button" className="note-text-button" aria-label="Page followers" aria-expanded={panel === 'followers'} onClick={() => setPanel(panel === 'followers' ? null : 'followers')}>
        <ThemeObjectTeamIcon size={13} /><span>Followers{followers.length ? ` · ${followers.length}` : ''}</span>
      </button>
      <Menu.Root modal={false} open={visible && menuOpen} onOpenChange={setMenuOpen}><Menu.Trigger asChild><button type="button" className="note-text-button" aria-label="Page options" title="Page options"><ThemeActionMoreIcon size={15} /></button></Menu.Trigger>
        <Menu.Portal container={resolveOverlayContainer()}><Menu.Content className="tab-context-menu" align="end" sideOffset={4} collisionPadding={8} onCloseAutoFocus={event => { if (!visible) event.preventDefault() }}>
          <Menu.Item className="tab-context-menu__item" disabled={operation.busy || Boolean(operation.issue)} title={archiveRoot?.title}
            onSelect={() => void operation.run({ kind: archiveRoot ? 'restore' : 'archive', noteId: archiveRoot?.noteId ?? page.noteId })}>
            {archiveRoot ? <ThemeActionRestoreIcon size={14} /> : <ThemeActionArchiveIcon size={14} />}<span>{archiveRoot ? restoreLabel : 'Archive page'}</span>
          </Menu.Item>
        </Menu.Content></Menu.Portal>
      </Menu.Root>
    </div>
    {archiveRoot ? <div className="notebook-archive-status" role="status"><ThemeActionArchiveIcon size={13} /><span>{archiveRoot.noteId === page.noteId ? 'Archived' : `Archived with ${archiveRoot.title}`}</span>
      <button type="button" className="note-text-button" title={archiveRoot.title} disabled={operation.busy || Boolean(operation.issue)} onClick={() => void operation.run({ kind: 'restore', noteId: archiveRoot.noteId })}><ThemeActionRestoreIcon size={13} />{restoreLabel}</button>
    </div> : null}
    <NotebookOperationIssue operation={operation} />
    <NotebookOperationIssue operation={followOperation} />
    {panel === 'followers' ? <section className="notebook-page-panel notebook-followers" aria-label="Note followers">
      {followers.length ? <ul>{followers.map(follower => {
        const actor = follower.actor, isSelf = self !== null && actor.kind === self.kind && actor.id === self.id
        return <li key={notebookFingerprint(actor)}><span title={`${actor.kind} · ${actor.id}`}>
          <strong>{isSelf ? 'You' : actor.kind === 'agent' ? `Agent · ${agentNames[actor.id] ?? actor.id}` : actor.kind === 'device' ? `Device · ${actor.id}` : actor.id}</strong>
          {actor.kind === 'agent' && agentNames[actor.id] ? <small>{actor.id}</small> : null}
        </span><time dateTime={new Date(follower.followedAt).toISOString()} title={new Date(follower.followedAt).toLocaleString()}>Since {new Date(follower.followedAt).toLocaleDateString()}</time></li>
      })}</ul> : <p>No one is following this page yet.</p>}
      <p>Following is saved until you unfollow. It does not indicate who is viewing this page.</p>
      {self === null ? <div className="notebook-change-issue" role="status">Your follow state is unknown. {actorIssue ?? 'Confirming your identity.'}
        <div className="notebook-follow-recovery"><button type="button" className="note-text-button" onClick={() => void refreshActor()}>Refresh identity</button>
          <button type="button" className="note-text-button" disabled={followOperation.busy || Boolean(followOperation.issue)} onClick={() => void followOperation.run({ kind: 'unfollow', noteId: page.noteId })}>Unfollow myself</button></div>
      </div> : null}
    </section> : null}
    {panel === 'move' ? <form className="notebook-page-panel notebook-move" aria-label="Move Note page" onSubmit={event => { event.preventDefault(); void move() }}>
      <label>Notebook<select aria-label="Destination notebook" value={destination} disabled={operation.busy || Boolean(operation.issue)} onChange={event => { setDestination(event.target.value); setParentId('') }}>
        {Object.values(library?.notebooks ?? {}).map(book => <option key={book.notebookId} value={book.notebookId}>{book.name}</option>)}</select></label>
      <label>Under page<select aria-label="Parent page" value={parentId} disabled={operation.busy || Boolean(operation.issue)} onChange={event => setParentId(event.target.value)}><option value="">Notebook root</option>
        {notebookPageRows(allPages, destination).filter(row => !excluded.has(row.page.noteId)).map(row => <option key={row.page.noteId} value={row.page.noteId}>{'　'.repeat(row.depth)}{row.page.title}</option>)}</select></label>
      <div><button className="note-text-button" type="submit" disabled={operation.busy || Boolean(operation.issue)}><ThemeActionSaveIcon size={13} />Move page</button><button className="note-text-button" type="button" onClick={() => setPanel(null)}>Cancel</button></div>
    </form> : null}
    {panel === 'sources' ? <section className="notebook-page-panel" aria-label="Saved web sources">
      {page.sources.length ? page.sources.map(source => <button className="notebook-source" key={source.sourceId} onClick={() => void openSource(source)} aria-label={`Open source ${source.title || source.url}`}>
        <ThemeObjectLinkIcon size={14} /><span><strong>{source.title || source.url}</strong><small>{source.url}</small><small>{new Date(source.recordedAt).toLocaleString()}{source.operator ? ` · ${source.operator.kind} · ${source.operator.id}` : ''}</small></span><ThemeActionOpenExternalIcon size={13} /></button>) : <p>No webpage was attached to this note.</p>}
      {sourceIssue ? <p role="status">{sourceIssue} Retry the same source above.</p> : null}
    </section> : null}
    {panel === 'history' ? <section className="notebook-page-panel notebook-history" aria-label="Note history">{events.map(event => <div key={event.eventId}>
      <span className="notebook-history-dot" /><div><strong>{labels[event.action]}</strong><small>{new Date(event.at).toLocaleString()} · {event.actor.kind} · {event.actor.id}</small>
        {event.before && (event.before.notebookId !== event.after.notebookId || event.before.parentNoteId !== event.after.parentNoteId) ? <p>{event.before.notebookName ?? library?.notebooks[event.before.notebookId]?.name ?? event.before.notebookId} / {event.before.parentNoteId ? library?.pages[event.before.parentNoteId]?.title ?? event.before.parentNoteId : 'Root'} → {event.after.notebookName ?? library?.notebooks[event.after.notebookId]?.name ?? event.after.notebookId} / {event.after.parentNoteId ? library?.pages[event.after.parentNoteId]?.title ?? event.after.parentNoteId : 'Root'}</p> : null}
        {event.before && event.before.title !== event.after.title ? <p>{event.before.title} → {event.after.title}</p> : null}
        {event.before && notebookFingerprint(event.before.resource) !== notebookFingerprint(event.after.resource) ? <p>{event.before.resource.hostId} · {event.before.resource.path} → {event.after.resource.hostId} · {event.after.resource.path}</p> : null}
        {event.source ? <p>{event.source.url}</p> : null}{event.topic ? <p title={event.topic.spaceId}>{topicNames.get(event.topic.spaceId) ?? 'Recorded Topic'}</p> : null}
      </div></div>)}</section> : null}
  </header>
}
