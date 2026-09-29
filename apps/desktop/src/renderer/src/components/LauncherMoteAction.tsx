import { ChevronDown, LoaderCircle } from 'lucide-react'
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
import * as DropdownMenu from './HoverDropdownMenu'
import { ServiceWindowNotice } from './ServiceWindowNotice'

/** The only handoff is an explicit draft preparation. It never invokes Session launch or send. */
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
  const moteName = motes.find(mote => mote.id === topicId)?.title ?? 'Saved Mote'
  const [pending, setPending] = useState(false), [issue, setIssue] = useState<string | null>(null), [preparedFor, setPreparedFor] = useState<string | null>(null)
  const scope = JSON.stringify([workspace?.id, sourceTabId, sourceRegionId, topicId, floating.targetTabId])
  const currentScope = useRef(scope); currentScope.current = scope
  const active = useRef(true)
  useEffect(() => { active.current = true; return () => { active.current = false } }, [])
  useEffect(() => { setIssue(null) }, [scope, prompt])
  const prepared = preparedFor === JSON.stringify([workspace?.id, prompt, topicId, tabId])
  const hasDraft = Boolean(prompt.trim())
  async function prepare() {
    if (pending || disabled) return
    const capturedScope = scope, requestedTabId = tabId
    const originalTab = tabId ? useAppStore.getState().tabs[tabId] : undefined
    const originalRegion = originalTab?.regions[originalTab.layout.activeRegionId]
    const originalOwner = originalRegion ? { tabId: originalTab!.id, regionId: originalRegion.regionId,
      draftKey: originalRegion.kind === 'agent' ? originalRegion.sessionId : originalRegion.kind === 'launcher' ? originalRegion.regionId : undefined } : null
    if (!hasDraft || prepared) { requestPmoTeamsTopicFloatingOpen({ targetTopicId: topicId, ...(requestedTabId ? { targetTabId: requestedTabId } : {}) }); return }
    setPending(true); setIssue(null)
    try {
      await api.scratch.ensureMote(SCRATCH_WORKSPACE_ID, topicId)
      if (!active.current || currentScope.current !== capturedScope) return
      await useAppStore.getState().openScratchTopic(topicId, SCRATCH_WORKSPACE_ID, { reveal: false, ...(requestedTabId ? { tabId: requestedTabId } : {}) })
      if (!active.current || currentScope.current !== capturedScope) return
      const state = useAppStore.getState()
      const tabId = pmoTeamsTopicFloatingTargetTabId({ open: false, preview: false, targetTopicId: topicId, ...(requestedTabId ? { targetTabId: requestedTabId } : {}) }, state.tabs, state.layouts[SCRATCH_WORKSPACE_ID], state.agentFocus.pmo.sessionId)
      const tab = tabId ? state.tabs[tabId] : undefined
      const region = tab?.regions[tab.layout.activeRegionId]
      const draftKey = region?.kind === 'agent' ? region.sessionId : region?.kind === 'launcher' ? region.regionId : undefined
      if (originalOwner && (tab?.id !== originalOwner.tabId || region?.regionId !== originalOwner.regionId || draftKey !== originalOwner.draftKey)) return
      if (!tab || tab.topicId !== topicId || !draftKey) throw new Error('The selected Mote has no confirmed Agent input. Your request remains in the Launcher.')
      const context = `Project: ${workspace?.name ?? 'Unselected'}\nHost: ${workspace?.hostId ?? 'Unknown'}\nWorking directory: ${workspace?.path ?? 'Unknown'}\n\n${prompt}`
      const existing = state.agentComposerDrafts[draftKey] ?? ''
      state.setAgentComposerDraft(draftKey, existing ? `${existing}\n\n---\n\n${context}` : context)
      requestPmoTeamsTopicFloatingOpen({ targetTopicId: topicId, targetTabId: tab.id })
      setPreparedFor(JSON.stringify([workspace?.id, prompt, topicId, tab.id]))
    } catch (error) {
      if (active.current && currentScope.current === capturedScope) {
        setIssue(presentError(error))
        requestPmoTeamsTopicFloatingOpen({ targetTopicId: topicId, ...(requestedTabId ? { targetTabId: requestedTabId } : {}) })
      }
    } finally { if (active.current) setPending(false) }
  }
  // The coordinator already owns this input. Preparing it into itself would recursively duplicate
  // the request; the original floating chooser remains the way to select another Mote.
  if (sourceIsTarget) return null
  return <div className="launcher-mote">
    <div className="launcher-mote__actions"><button type="button" className="launch-refine__toggle" disabled={disabled || pending} title={`${hasDraft ? 'Prepare the complete request in' : 'Open'} ${moteName}; no request is sent automatically`} onClick={() => { void prepare() }}>
      {pending ? <LoaderCircle className="spin" size={13} /> : <MoteIcon size={13} />}<span>{pending ? 'Preparing…' : prepared ? `Prepared in ${moteName}` : hasDraft ? `Prepare in ${moteName}` : `Open ${moteName}`}</span>
    </button>
    {motes.length > 1 ? <DropdownMenu.Root><DropdownMenu.Trigger className="icon-button" aria-label="Choose Mote" title="Choose Mote" disabled={pending}><ChevronDown size={12} /></DropdownMenu.Trigger><DropdownMenu.Portal><DropdownMenu.Content className="tab-context-menu composer-menu" side="top" align="start">{motes.map(mote => <DropdownMenu.Item key={mote.id} className="tab-context-menu__item" onSelect={() => setFloating({ targetTopicId: mote.id, targetTabId: undefined })}><MoteIcon size={13} /><span>{mote.title}</span>{mote.id === topicId ? <span aria-label="Selected Mote">✓</span> : null}</DropdownMenu.Item>)}</DropdownMenu.Content></DropdownMenu.Portal></DropdownMenu.Root> : null}</div>
    {issue ? <ServiceWindowNotice notice={{ kind: 'indeterminate', notice: { step: 'Mote draft preparation did not complete', mode: `${issue} Both original drafts and the current project are kept. No request was sent.`, restore: 'Open the selected Mote to restore its Agent input, then prepare the request again.' } }} /> : null}
  </div>
}
