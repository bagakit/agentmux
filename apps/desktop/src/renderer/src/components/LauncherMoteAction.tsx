import { Check, ChevronDown, LoaderCircle } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import type { WorkspaceRecord } from '../../../shared/contracts'
import { SCRATCH_WORKSPACE_ID } from '../../../shared/scratch-topics'
import { useScratchTopics } from '../hooks/useScratchTopics'
import { scratchMoteTopics } from '../lib/scratch-topic-snapshots'
import { api } from '../lib/api'
import { useAppStore } from '../store'
import { requestPmoTeamsTopicFloatingOpen, pmoTeamsTopicFloatingTargetTabId, pmoTeamsTopicFloatingTargetTopicId, createPmoTeamsTopicTargetSelector, usePmoTeamsTopicFloatingState } from '../lib/pmo-teams-topic-floating'
import { presentError } from '../lib/error-presentation'
import { MoteIcon } from './MoteIcon'
import { tabGroupForTab } from '../lib/workbench-tabs'
import * as DropdownMenu from './HoverDropdownMenu'
import { ServiceWindowNotice } from './ServiceWindowNotice'
import { MoteArchiveNotice, useMoteArchiveAction } from './MoteArchiveNotice'

/** An explicit creation request uses the selected Mote's existing input owner. */
export function LauncherMoteAction({ workspace, prompt, sourceTabId, sourceRegionId, disabled = false }: {
  workspace: WorkspaceRecord | undefined; prompt: string; sourceTabId?: string | undefined; sourceRegionId?: string | undefined; disabled?: boolean
}) {
  const [floating, setFloating] = usePmoTeamsTopicFloatingState()
  const topicId = useAppStore(state => pmoTeamsTopicFloatingTargetTopicId(floating, state.tabs))
  const selectTab = useMemo(() => createPmoTeamsTopicTargetSelector(floating), [floating.targetTopicId, floating.targetTabId])
  const tabId = useAppStore(selectTab)
  const sourceIsTarget = useAppStore(state => {
    const tab = tabId ? state.tabs[tabId] : undefined
    return Boolean(tab && tab.workspaceId === SCRATCH_WORKSPACE_ID && tab.topicId === topicId && tab.id === sourceTabId && tab.layout.activeRegionId === sourceRegionId)
  })
  const { topics } = useScratchTopics(SCRATCH_WORKSPACE_ID)
  const motes = scratchMoteTopics(topics)
  const selectedMote = motes.find(mote => mote.id === topicId)
  const availableMotes = motes.filter(mote => mote.moteArchive?.state !== 'archived')
  const scratch = useAppStore(state => state.config?.workspaces.find(item => item.id === SCRATCH_WORKSPACE_ID))
  const archive = useMoteArchiveAction(scratch)
  const moteName = motes.find(mote => mote.id === topicId)?.title ?? 'Saved Mote'
  const [pending, setPending] = useState(false), [issue, setIssue] = useState<string | null>(null), [submittedFor, setSubmittedFor] = useState<string | null>(null)
  const [submission, setSubmission] = useState<'queued' | 'submitted'>('queued')
  const inFlight = useRef(false)
  const scope = JSON.stringify([workspace?.id, workspace?.hostId, workspace?.path, sourceTabId, sourceRegionId, topicId, floating.targetTabId])
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
    <div className="launcher-mote__actions"><button type="button" className="launch-refine__toggle" disabled={disabled || pending} title={`${hasDraft ? 'Send a creation request to' : 'Open'} ${moteName}; both unsent drafts are kept`} onClick={() => { void createWithMote() }}>
      {pending ? <LoaderCircle className="spin" size={13} /> : submitted ? <Check size={13} /> : <MoteIcon size={13} />}<span>{pending ? 'Submitting…' : submitted ? `Request ${submission}` : 'Create with Mote'}</span>
    </button>
    {availableMotes.length > 1 || selectedMote?.moteArchive?.state === 'archived' ? <DropdownMenu.Root><DropdownMenu.Trigger className="launcher-mote__target" aria-label={`Choose Mote: ${moteName}`} title={moteName} disabled={pending}><span>{moteName}</span><ChevronDown size={12} /></DropdownMenu.Trigger><DropdownMenu.Portal><DropdownMenu.Content className="tab-context-menu composer-menu" side="top" align="start">{availableMotes.map(mote => <DropdownMenu.Item key={mote.id} className="tab-context-menu__item" onSelect={() => setFloating({ targetTopicId: mote.id, targetTabId: undefined })}><MoteIcon size={13} /><span>{mote.title}</span>{mote.id === topicId ? <span aria-label="Selected Mote">✓</span> : null}</DropdownMenu.Item>)}</DropdownMenu.Content></DropdownMenu.Portal></DropdownMenu.Root> : <span className="launcher-mote__target" title={moteName}>{moteName}</span>}</div>
    {selectedMote?.moteArchive?.state === 'archived' ? <div className="workbench-restore-notice mote-context-notice" role="status">
      <span>{moteName} · Archived. This request keeps its original Mote.</span>
      <button type="button" className="small-button" disabled={archive.pending === topicId} onClick={() => void archive.change(selectedMote, false)}>Restore Mote</button>
    </div> : null}
    <MoteArchiveNotice workspaceId={SCRATCH_WORKSPACE_ID} issue={archive.issue ?? (selectedMote?.moteArchive?.state === 'unknown' ? selectedMote.moteArchive.issue : null)} />
    {issue ? <ServiceWindowNotice notice={{ kind: 'indeterminate', notice: { step: `Creation handoff to ${moteName} is unconfirmed`, mode: `${issue} Both original drafts and the current project are kept.`, restore: 'Open the selected Mote to inspect its request queue and launch status before retrying.' } }} /> : null}
  </div>
}
