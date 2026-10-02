import { Check, ChevronDown, LoaderCircle } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import type { ScratchTopicSnapshot, WorkspaceRecord } from '../../../shared/contracts'
import { PMO_TEAMS_TOPIC_ID, SCRATCH_WORKSPACE_ID } from '../../../shared/scratch-topics'
import { useScratchTopics } from '../hooks/useScratchTopics'
import { scratchMoteTopics } from '../lib/scratch-topic-snapshots'
import { api } from '../lib/api'
import { useAppStore } from '../store'
import { requestPmoTeamsTopicFloatingOpen, pmoTeamsTopicFloatingTargetTabId, createPmoTeamsTopicTargetSelector } from '../lib/pmo-teams-topic-floating'
import { useLauncherState } from '../lib/launcher-state'
import { topicSpaceIconTarget } from '../lib/space-object-appearance'
import { presentError } from '@agentmux/client-ui/error-presentation'
import { SpaceObjectIcon } from './SpaceObjectIcon'
import { tabGroupForTab } from '../lib/workbench-tabs'
import * as DropdownMenu from './HoverDropdownMenu'
import { ServiceWindowNotice } from './ServiceWindowNotice'
import { MoteArchiveNotice, useMoteArchiveAction } from './MoteArchiveNotice'

function LauncherMoteAvatar({ mote, topicId }: { mote?: ScratchTopicSnapshot | undefined; topicId: string }) {
  const workspace = useAppStore(state => state.config?.workspaces.find(item => item.id === SCRATCH_WORKSPACE_ID))
  const target = useMemo(() => workspace && mote ? topicSpaceIconTarget(workspace, mote) : undefined, [workspace, mote])
  const icon = useAppStore(state => target ? state.spaceObjectIcons[target.key] ?? null : null)
  return <SpaceObjectIcon kind="mote" name={mote?.title ?? 'Saved Mote'} manualIcon={icon}
    avatarWorkspaceId={workspace?.id} avatarTopicId={topicId} avatarObjectKey={target?.key} />
}

/** An explicit creation request uses the selected Mote's existing input owner. */
export function LauncherMoteAction({ workspace, prompt, sourceTabId, sourceRegionId, disabled = false }: {
  workspace: WorkspaceRecord | undefined; prompt: string; sourceTabId?: string | undefined; sourceRegionId?: string | undefined; disabled?: boolean
}) {
  const topicId = useLauncherState(state => state.moteTopicId ?? PMO_TEAMS_TOPIC_ID)
  const selectMote = useLauncherState(state => state.selectMote)
  const selectTab = useMemo(() => createPmoTeamsTopicTargetSelector({ open: false, preview: false, targetTopicId: topicId }), [topicId])
  const tabId = useAppStore(selectTab)
  const sourceIsTarget = useAppStore(state => {
    const tab = tabId ? state.tabs[tabId] : undefined
    return Boolean(tab && tab.workspaceId === SCRATCH_WORKSPACE_ID && tab.topicId === topicId && tab.id === sourceTabId && tab.layout.activeRegionId === sourceRegionId)
  })
  const { topics, error: directoryError } = useScratchTopics(SCRATCH_WORKSPACE_ID)
  const motes = scratchMoteTopics(topics)
  const selectedMote = motes.find(mote => mote.id === topicId)
  const availableMotes = motes.filter(mote => mote.moteArchive?.state !== 'archived')
  const scratch = useAppStore(state => state.config?.workspaces.find(item => item.id === SCRATCH_WORKSPACE_ID))
  const archive = useMoteArchiveAction(scratch)
  const moteName = selectedMote?.title ?? 'Saved Mote'
  const directoryIssue = directoryError ?? (topics !== null && !selectedMote ? 'The selected Mote was not found in the current directory read.' : null)
  const archiveIssue = selectedMote?.moteArchive?.state === 'unknown' ? selectedMote.moteArchive.issue : null
  const [pending, setPending] = useState(false), [issue, setIssue] = useState<string | null>(null), [submittedFor, setSubmittedFor] = useState<string | null>(null)
  const [submission, setSubmission] = useState<'queued' | 'submitted'>('queued')
  const inFlight = useRef(false)
  const scope = JSON.stringify([workspace?.id, workspace?.hostId, workspace?.path, sourceTabId, sourceRegionId, topicId])
  const currentScope = useRef(scope); currentScope.current = scope
  const active = useRef(true)
  useEffect(() => { active.current = true; return () => { active.current = false } }, [])
  useEffect(() => { setIssue(null) }, [scope, prompt])
  const submitted = submittedFor === JSON.stringify([workspace?.id, prompt, topicId, tabId])
  const hasDraft = Boolean(prompt.trim())
  async function createWithMote() {
    if (inFlight.current || disabled) return
    const capturedScope = scope, requestedTabId = tabId
    const originalTab = tabId ? useAppStore.getState().tabs[tabId] : undefined
    const originalRegion = originalTab?.regions[originalTab.layout.activeRegionId]
    const originalOwner = originalRegion ? { tabId: originalTab!.id, regionId: originalRegion.regionId,
      draftKey: originalRegion.kind === 'agent' ? originalRegion.sessionId : originalRegion.kind === 'launcher' ? originalRegion.regionId : undefined } : null
    if (!hasDraft || submitted) { requestPmoTeamsTopicFloatingOpen({ targetTopicId: topicId, ...(requestedTabId ? { targetTabId: requestedTabId } : {}) }); return }
    const sourceStillOwned = () => {
      if (!active.current || currentScope.current !== capturedScope) return false
      if (!sourceTabId || !sourceRegionId) return true
      const source = useAppStore.getState().tabs[sourceTabId]?.regions[sourceRegionId]
      return source?.kind === 'launcher' && source.workspaceId === workspace?.id
    }
    inFlight.current = true
    setPending(true); setIssue(null)
    try {
      await api.scratch.ensureMote(SCRATCH_WORKSPACE_ID, topicId)
      if (!sourceStillOwned()) return
      await useAppStore.getState().openScratchTopic(topicId, SCRATCH_WORKSPACE_ID, { reveal: false, ...(requestedTabId ? { tabId: requestedTabId } : {}) })
      if (!sourceStillOwned()) return
      const state = useAppStore.getState()
      const tabId = pmoTeamsTopicFloatingTargetTabId({ open: false, preview: false, targetTopicId: topicId, ...(requestedTabId ? { targetTabId: requestedTabId } : {}) }, state.tabs, state.layouts[SCRATCH_WORKSPACE_ID], state.agentFocus.pmo.sessionId)
      const tab = tabId ? state.tabs[tabId] : undefined
      const region = tab?.regions[tab.layout.activeRegionId]
      const draftKey = region?.kind === 'agent' ? region.sessionId : region?.kind === 'launcher' ? region.regionId : undefined
      if (originalOwner && (tab?.id !== originalOwner.tabId || region?.regionId !== originalOwner.regionId || draftKey !== originalOwner.draftKey)) return
      if (!tab || tab.workspaceId !== SCRATCH_WORKSPACE_ID || tab.topicId !== topicId || !draftKey) throw new Error('The selected Mote has no confirmed Agent input. Your request remains in the Launcher.')
      const context = `Help me create an Agent for the following task in this project. Use the project's Host and working directory when creating it.\n\nProject: ${workspace?.name ?? 'Unselected'}\nHost: ${workspace?.hostId ?? 'Unknown'}\nWorking directory: ${workspace?.path ?? 'Unknown'}\n\n${prompt}`
      if (region?.kind === 'agent') {
        if (!state.send(region.sessionId, context, error => {
          if (sourceStillOwned()) setIssue(presentError(error))
        }, 'manual')) throw new Error('The selected Mote could not queue the creation request.')
        setSubmission('queued')
      } else if (region?.kind === 'launcher') {
        const executorId = Object.keys(state.config?.executors ?? {})[0]
        const layout = state.layouts[SCRATCH_WORKSPACE_ID]
        const groupId = layout ? tabGroupForTab(layout, tab.id) : null
        if (!executorId || !groupId) throw new Error('Configure an Agent Executor to start the selected Mote. Both drafts are kept.')
        await state.launchAgent(executorId, context, groupId, { tabId: tab.id, regionId: region.regionId })
        const currentTarget = useAppStore.getState().tabs[tab.id]
        if (!sourceStillOwned() || currentTarget?.topicId !== topicId || currentTarget.layout.activeRegionId !== region.regionId) return
        setSubmission('submitted')
      }
      // Queue admission / initial prompt submission is not proof that a new Agent was created.
      // Neither Composer draft participates in this request, so both remain independently editable.
      requestPmoTeamsTopicFloatingOpen({ targetTopicId: topicId, targetTabId: tab.id })
      setSubmittedFor(JSON.stringify([workspace?.id, prompt, topicId, tab.id]))
    } catch (error) {
      if (active.current && currentScope.current === capturedScope) {
        setIssue(presentError(error))
      }
    } finally { inFlight.current = false; if (active.current) setPending(false) }
  }
  // The coordinator already owns this input. Sending it into itself would recursively duplicate
  // the request; the original floating chooser remains the way to select another Mote.
  if (sourceIsTarget) return null
  return <div className="launcher-mote">
    <div className="launcher-mote__actions"><button type="button" className="launcher-mote__create" disabled={disabled || pending} title={`${hasDraft ? 'Send a creation request to' : 'Open'} ${moteName}; both unsent drafts are kept`} onClick={() => { void createWithMote() }}>
      {pending ? <LoaderCircle className="spin" size={13} /> : submitted ? <Check size={13} /> : <LauncherMoteAvatar mote={selectedMote} topicId={topicId} />}<span>{pending ? 'Submitting…' : submitted ? `Request ${submission}` : 'Create with Mote'}</span>
    </button>
    {availableMotes.length > 1 || !availableMotes.some(mote => mote.id === topicId) ? <DropdownMenu.Root><DropdownMenu.Trigger className="launcher-mote__target" aria-label={`Choose Mote: ${moteName}`} title={moteName} disabled={pending}><span>{moteName}</span><ChevronDown size={12} /></DropdownMenu.Trigger><DropdownMenu.Portal><DropdownMenu.Content className="tab-context-menu composer-menu" side="top" align="start">{availableMotes.map(mote => <DropdownMenu.Item key={mote.id} className="tab-context-menu__item" onSelect={() => selectMote(mote.id)}><LauncherMoteAvatar mote={mote} topicId={mote.id} /><span>{mote.title}</span>{mote.id === topicId ? <span aria-label="Selected Mote">✓</span> : null}</DropdownMenu.Item>)}{availableMotes.length === 0 ? <DropdownMenu.Item className="tab-context-menu__item" disabled>No active Motes</DropdownMenu.Item> : null}</DropdownMenu.Content></DropdownMenu.Portal></DropdownMenu.Root> : <span className="launcher-mote__target" title={moteName}>{moteName}</span>}</div>
    {selectedMote?.moteArchive?.state === 'archived' ? <div className="launcher-mote__archive" role="status">
      <span>Archived · You can still create with this Mote.</span>
      <button type="button" className="small-button" disabled={archive.pending === topicId} onClick={() => void archive.change(selectedMote, false)}>Restore Mote</button>
    </div> : null}
    {directoryIssue ? <ServiceWindowNotice notice={{ kind: 'indeterminate', notice: {
      step: directoryError ? 'Mote directory read needs attention' : 'Selected Mote directory is unconfirmed', mode: `${directoryIssue}${archiveIssue ? ` Mote archive state is unconfirmed: ${archiveIssue}` : ''}${archive.failure ? ` ${archive.failure.action} for ${archive.failure.title} was not confirmed: ${archive.failure.message}` : ''} Your saved selection is kept; you can still open this Mote or choose another.`,
      restore: archive.failure ? `Refresh the directory, then retry ${archive.failure.action.toLowerCase()} for ${archive.failure.title}.` : 'Refresh the directory to confirm the same Mote.'
    } }} actions={<button type="button" className="small-button" onClick={() => void useAppStore.getState().refreshScratchTopics(SCRATCH_WORKSPACE_ID, true)}>Retry directory</button>} /> : null}
    {!directoryIssue ? <MoteArchiveNotice workspaceId={SCRATCH_WORKSPACE_ID} issue={archive.issue} failure={archive.failure} /> : null}
    {!directoryIssue ? <MoteArchiveNotice workspaceId={SCRATCH_WORKSPACE_ID} issue={archiveIssue} targetName={moteName} /> : null}
    {issue ? <ServiceWindowNotice notice={{ kind: 'indeterminate', notice: { step: `Creation handoff to ${moteName} is unconfirmed`, mode: `${issue} Both original drafts and the current project are kept.`, restore: 'Open the selected Mote to inspect its request queue and launch status before retrying.' } }} /> : null}
  </div>
}
