import { TextInput } from '@agentmux/client-ui/input'
import { scratchTopicsForConfig } from '../lib/scratch-topic-snapshots'
import * as ContextMenu from '@radix-ui/react-context-menu'
import * as DropdownMenu from './HoverDropdownMenu'
import { semanticIconComponent } from '@agentmux/client-ui/icons'
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useShallow } from 'zustand/react/shallow'
import type { FocusContext } from '../lib/focus-context'
import type { WorkbenchTab } from '../lib/workbench-tabs'
import type { WorkbenchProjectionSelection } from '../lib/workbench-projection'
import { formatTabAddress } from '../lib/agent-address'
import { PMO_TEAMS_TOPIC_ID, SCRATCH_WORKSPACE_ID } from '../../../shared/scratch-topics'
import { createPmoTeamsTopicTargetSelector, pmoTeamsTopicFloatingTargetTopicId, readPmoTeamsTopicFloatingState, usePmoTeamsTopicFloatingState } from '../lib/pmo-teams-topic-floating'
import { primaryMoteExecutorId } from '../lib/primary-mote-executor'
import { topicIdForSession } from '../lib/workbench-tabs'
import { scratchMoteTopics, scratchTopicKind, scratchTopicsForWorkspace } from '../lib/scratch-topic-snapshots'
import { useScratchTopics } from '../hooks/useScratchTopics'
import { topicSpaceIconTarget } from '../lib/space-object-appearance'
import { recordForWorkbenchTab, useWorkbenchTabNameMetadata, useWorkbenchTabSessions } from '../lib/workbench-session-subscriptions'
import { workbenchTabDisplayName } from '../lib/workbench-tab-presentation'
import { currentDisplayNameRevision, useAppStore } from '../store'
import { resolveOverlayContainer } from './WindowOverlayHost'
import { SpaceObjectIcon } from './SpaceObjectIcon'
import { useFocusStopAgent } from './FocusStopAgent'

const ThemeActionEditIcon = semanticIconComponent('action.edit')
const ThemeActionStopIcon = semanticIconComponent('action.stop')
const ThemeObjectInboxIcon = semanticIconComponent('object.inbox')
const ThemeActionOpenExternalIcon = semanticIconComponent('action.open-external')
const ThemeObjectConversationIcon = semanticIconComponent('object.conversation')
const ThemeStatusWarningIcon = semanticIconComponent('status.warning')
const ThemeNavigationDownIcon = semanticIconComponent('navigation.down')
const ThemeStatusSelectedIcon = semanticIconComponent('status.selected')
const ThemeActionMoreIcon = semanticIconComponent('action.more')
const ThemeLayoutCloseRightIcon = semanticIconComponent('layout.close-right')


export function FocusToolbar({ children, selectedId, selected, tab, reference, onReview, onCloseWorkspace, regionOnly, onToggleRegion }: {
  children: ReactNode; selectedId: string | null; selected: FocusContext | undefined; tab: WorkbenchTab | null; reference?: WorkbenchProjectionSelection | undefined; onReview(): void; onCloseWorkspace(): void; regionOnly?: boolean | undefined; onToggleRegion?: (() => void) | undefined
}) {
  return <header className="focus-toolbar">
    <div className="focus-toolbar__filters">{children}</div>
    {(tab || selectedId) ? <FocusToolbarContext key={JSON.stringify([selectedId, tab?.id])} selectedId={selectedId} selected={selected} tab={tab} reference={reference} onReview={onReview} onCloseWorkspace={onCloseWorkspace} regionOnly={regionOnly} onToggleRegion={onToggleRegion} /> : null}
  </header>
}
function FocusToolbarContext({ selectedId, selected, tab, reference, onReview, onCloseWorkspace, regionOnly, onToggleRegion }: {
  selectedId: string | null; selected: FocusContext | undefined; tab: WorkbenchTab | null; reference?: WorkbenchProjectionSelection | undefined; onReview(): void; onCloseWorkspace(): void; regionOnly?: boolean | undefined; onToggleRegion?: (() => void) | undefined
}) {
  const renameTab = useAppStore(state => state.renameTab)
  const stop = useFocusStopAgent()
  const sessions = useWorkbenchTabSessions(tab ?? undefined)
  const sessionNameMetadata = useWorkbenchTabNameMetadata(tab ?? undefined)
  const agentNames = useAppStore(useShallow(state => recordForWorkbenchTab(state.agentNames, tab ?? undefined)))
  const timelines = useAppStore(useShallow(state => recordForWorkbenchTab(state.timelines, tab ?? undefined)))
  const [floating, setFloating] = usePmoTeamsTopicFloatingState()
  const { topics, error: directoryError } = useScratchTopics(SCRATCH_WORKSPACE_ID)
  const scratch = useAppStore(state => state.config?.workspaces.find(workspace => workspace.id === SCRATCH_WORKSPACE_ID))
  const icons = useAppStore(state => state.spaceObjectIcons)
  const motes = useMemo(() => scratchMoteTopics(topics ?? []), [topics])
  const topicId = useAppStore(state => floating.focusChatTopicId === undefined ? pmoTeamsTopicFloatingTargetTopicId(floating, state.tabs) : floating.focusChatTopicId)
  const recipient = motes.find(topic => topic.id === topicId)
  const confirmed = topicId === PMO_TEAMS_TOPIC_ID || Boolean(topicId && recipient && !recipient.readError && scratchTopicKind(topicId, topics) === 'mote')
  const recipientName = confirmed ? recipient?.title || 'Mote' : 'Unconfirmed Mote'
  const recipientLabel = `${recipientName}${recipient?.moteArchive?.state === 'archived' ? ' · Archived' : ''}`
  const recipientIssue = floating.preferenceIssue ?? (!confirmed ? `${topicId ? 'Chat recipient ' + topicId : 'Saved Chat recipient'} is unconfirmed. Choose an available Mote; this Chat will not be sent until its identity is confirmed.` : directoryError || recipient?.readError ? `Mote directory could not be refreshed: ${directoryError || recipient?.readError}. The known recipient is retained.` : null)
  const recipientIcon = useMemo(() => scratch && recipient && confirmed ? topicSpaceIconTarget(scratch, recipient) : null, [scratch, recipient, confirmed])
  const [discussionPending, setDiscussionPending] = useState(false)
  const discussionFlight = useRef(false)
  const mounted = useRef(true)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  const [draft, setDraft] = useState<string | null>(null)
  const [menuOpen, setMenuOpen] = useState(false)
  const renameRef = useRef<HTMLInputElement>(null)
  const expectedNameRevision = useRef({ revision: 0 }), savingName = useRef(false), editGeneration = useRef(0)
  useEffect(() => () => { ++editGeneration.current; expectedNameRevision.current = { revision: 0 } }, [tab?.id])
  const identityRef = useRef<HTMLButtonElement>(null)
  const menuOriginRef = useRef<HTMLButtonElement | null>(null)
  const menuEscapeReturnRef = useRef<HTMLButtonElement | null>(null)
  const renameCancelledRef = useRef(false)
  const originalTerminal = tab && Object.values(tab.regions).some(surface => surface.kind === 'terminal' && surface.sessionId === selectedId)
  const name = tab ? workbenchTabDisplayName(tab, sessions, agentNames, timelines, sessionNameMetadata) : selected?.name || 'Session awaiting recovery'
  const activeSurface = reference && tab?.regions[reference.regionId]
  const statusLabel = selected?.stateLabel ?? (activeSurface ? activeSurface.kind[0]!.toUpperCase() + activeSurface.kind.slice(1) : originalTerminal ? 'Terminal' : 'Recovery unknown')
  useEffect(() => {
    if (draft !== null) { renameRef.current?.focus(); renameRef.current?.select() }
    else if (renameCancelledRef.current) { renameCancelledRef.current = false; identityRef.current?.focus() }
  }, [draft === null])
  function closeMenuFocus(event: Event) {
    // Selected actions and outside interaction keep their own destination.
    event.preventDefault()
    const origin = menuEscapeReturnRef.current
    menuEscapeReturnRef.current = null
    origin?.focus()
  }
  async function commitRename() {
    if (draft === null) return
    const value = draft.trim() || null
    if (!tab || savingName.current) return
    savingName.current = true
    const generation = editGeneration.current, baseline = expectedNameRevision.current
    try {
      if (await renameTab(tab.id, value, baseline.revision) && expectedNameRevision.current === baseline) {
        ++baseline.revision
        if (generation === editGeneration.current) { ++editGeneration.current; setDraft(null) }
      }
    }
    finally { savingName.current = false }
  }
  function currentReference(): WorkbenchProjectionSelection | null {
    const state = useAppStore.getState()
    if (reference && tab?.id === reference.tabId && state.tabs[reference.tabId]?.regions[reference.regionId] &&
      state.layouts[reference.displayWorkspaceId]?.groups.some(group => group.id === reference.groupId && group.tabOrder.includes(reference.tabId))) return reference
    state.reportError(new Error('The displayed Tab location is unconfirmed. Its original work surface is kept; choose an available Focus location.'), { kind: 'indeterminate' })
    return null
  }
  function viewInSpace() {
    const target = currentReference()
    if (!target) return
    const state = useAppStore.getState()
    void state.selectWorkspace(target.displayWorkspaceId)
    state.focusRegion(target.displayWorkspaceId, target.tabId, target.regionId, 'keyboard', target.groupId)
  }
  async function chatAboutTab() {
    if (discussionFlight.current) return
    const target = currentReference()
    if (!target) return
    const state = useAppStore.getState()
    const choice = readPmoTeamsTopicFloatingState() ?? floating
    const topicId = choice.focusChatTopicId === undefined ? pmoTeamsTopicFloatingTargetTopicId(choice, state.tabs) : choice.focusChatTopicId
    const scratch = state.config?.workspaces.find(workspace => workspace.id === SCRATCH_WORKSPACE_ID)
    const topics = scratchTopicsForWorkspace(state.scratchTopicSnapshots, scratch)
    const recipient = motes.find(topic => topic.id === topicId)
    if (topicId === null || topicId !== PMO_TEAMS_TOPIC_ID && (!recipient || recipient.readError || scratchTopicKind(topicId, topics) !== 'mote')) {
      state.reportError(new Error(`Mote identity is unconfirmed${topicId ? ' (' + topicId + ')' : ''}. This Chat was not sent. The displayed Tab and original drafts are kept; choose an available Mote or retry its directory.`), { kind: 'indeterminate' })
      return
    }
    const moteTarget = { ...choice, targetTopicId: topicId, targetTabId: pmoTeamsTopicFloatingTargetTopicId(choice, state.tabs) === topicId ? choice.targetTabId : undefined }
    const targetTabId = createPmoTeamsTopicTargetSelector(moteTarget)(state)
    const moteTab = targetTabId ? state.tabs[targetTabId] : undefined
    const region = moteTab?.regions[moteTab.layout.activeRegionId]
    const session = region?.kind === 'agent' ? state.sessions.find(item => item.id === region.sessionId) : undefined
    const executorId = topicId === PMO_TEAMS_TOPIC_ID ? primaryMoteExecutorId(state)
      : session?.kind === 'agent' && topicIdForSession(state.config, session, scratchTopicsForConfig(state.config, state.scratchTopicSnapshots)) === topicId &&
        state.config?.executors[session.executorId]?.providerId === session.providerId ? session.executorId : undefined
    const prompt = `Discuss this Tab with me. Inspect this exact complete work surface before suggesting or making changes.\n\n${formatTabAddress(target.tabId)}`
    discussionFlight.current = true; setDiscussionPending(true)
    const errorBefore = state.error
    try {
      await state.openScratchTopic(topicId, SCRATCH_WORKSPACE_ID, { newTab: true, reveal: false, initialRequest: { prompt, ...(executorId ? { executorId } : {}) } })
    } catch (cause) {
      if (useAppStore.getState().error === errorBefore) useAppStore.getState().reportError(cause, { kind: 'indeterminate', summary: 'Mote discussion preparation is unconfirmed. The original Tab and drafts are kept.' })
    } finally {
      discussionFlight.current = false
      if (mounted.current) setDiscussionPending(false)
    }
  }
  const actions = [
    ...(tab ? [{ key: 'rename', label: 'Rename Tab', icon: ThemeActionEditIcon, run: () => { ++editGeneration.current; expectedNameRevision.current = { revision: currentDisplayNameRevision('tab', tab.id) }; setDraft(name) } }] : []),
    ...(tab && onToggleRegion ? [{ key: 'level', label: regionOnly ? 'Show entire Tab' : 'Show only this Region', icon: ThemeActionStopIcon, run: onToggleRegion }] : []),
    ...(selected?.actionable ? [{ key: 'review', label: 'Review request', icon: ThemeObjectInboxIcon, run: onReview }] : []),
    ...(selectedId && activeSurface?.kind === 'agent' ? [{ key: 'stop', label: 'Stop Agent', icon: ThemeActionStopIcon, run: () => stop.requestStop(selectedId, selected?.name ?? name, menuOriginRef.current) }] : []),
  ]
  return <div className="focus-toolbar__context">
    {draft !== null ? <TextInput ref={renameRef} className="focus-toolbar__rename" aria-label="Rename Tab" value={draft} onChange={event => { ++editGeneration.current; setDraft(event.target.value) }} onBlur={commitRename} onKeyDown={event => { event.stopPropagation(); if (event.key === 'Enter') { event.preventDefault(); commitRename() } if (event.key === 'Escape') { event.preventDefault(); renameCancelledRef.current = true; ++editGeneration.current; setDraft(null) } }} /> : <ContextMenu.Root modal={false}>
      <ContextMenu.Trigger asChild onContextMenu={() => { menuOriginRef.current = identityRef.current }}><button ref={identityRef} type="button" className="focus-toolbar__identity" aria-label={`Focus context: ${name}`} title={`${name} · ${statusLabel} · Right-click for Focus actions`} onKeyDown={event => { if ((event.shiftKey && event.key === 'F10') || event.key === 'ContextMenu') { event.preventDefault(); menuOriginRef.current = event.currentTarget; setMenuOpen(true) } }}><strong>{name}</strong><small>{statusLabel}</small></button></ContextMenu.Trigger>
      <ContextMenu.Portal container={resolveOverlayContainer() as HTMLElement | undefined}><ContextMenu.Content className="tab-context-menu" collisionPadding={8} onEscapeKeyDown={() => { menuEscapeReturnRef.current = identityRef.current }} onCloseAutoFocus={closeMenuFocus}>{actions.map(action => <ContextMenu.Item key={action.key} className="tab-context-menu__item" onSelect={action.run}><action.icon size={14} /><span>{action.label}</span></ContextMenu.Item>)}</ContextMenu.Content></ContextMenu.Portal>
    </ContextMenu.Root>}
    <button type="button" className="focus-toolbar__action" aria-label="View in Space" title={`View in Space · ${name}`} onClick={viewInSpace}><ThemeActionOpenExternalIcon size={14} aria-hidden="true" /><span>Space</span></button>
    <div className="focus-toolbar__chat">
      <button type="button" className="focus-toolbar__action" aria-label="Chat about this tab with Mote" aria-description={`Recipient: ${recipientLabel}${recipientIssue ? ' · ' + recipientIssue : ''}`} title={`Chat about this tab with ${recipientLabel} · ${name}${recipientIssue ? '\n' + recipientIssue : ''}`} disabled={discussionPending} aria-busy={discussionPending} onClick={() => { void chatAboutTab() }}><ThemeObjectConversationIcon size={14} aria-hidden="true" /><span>{discussionPending ? 'Preparing…' : 'Chat'}</span></button>
      <DropdownMenu.Root modal={false}>
        <DropdownMenu.Trigger asChild><button type="button" className="focus-toolbar__mote-choice" aria-label="Choose Chat Mote" aria-description={`${recipientLabel}${topicId ? ' · ' + topicId : ''}${recipientIssue ? ' · ' + recipientIssue : ''}`} title={`${recipientLabel}${topicId ? ' · ' + topicId : ''}${recipientIssue ? '\n' + recipientIssue : ''}`} data-focus-chat-topic={topicId}>
          <SpaceObjectIcon kind="mote" name={recipientName} manualIcon={recipientIcon ? icons[recipientIcon.key] ?? null : null} avatarWorkspaceId={recipientIcon?.avatarTarget?.workspaceId} avatarTopicId={recipientIcon?.avatarTarget?.topicId} avatarObjectKey={recipientIcon?.key} />
          <span className="focus-toolbar__mote-name">{recipientName}</span>{recipientIssue ? <ThemeStatusWarningIcon size={12} className="focus-toolbar__mote-warning" aria-hidden="true" /> : null}<ThemeNavigationDownIcon size={11} aria-hidden="true" />
        </button></DropdownMenu.Trigger>
        <DropdownMenu.Portal><DropdownMenu.Content className="tab-context-menu focus-chat-mote-menu" align="end" collisionPadding={8} onCloseAutoFocus={event => {
          const focused = document.activeElement
          if (focused instanceof HTMLElement && focused.isConnected && focused !== document.body && !focused.closest('[hidden], [inert]') && event.target instanceof HTMLElement && !event.target.contains(focused)) event.preventDefault()
        }}>
          <DropdownMenu.Label className="focus-chat-mote-menu__label">Chat with</DropdownMenu.Label>
          {recipientIssue ? <p role="status" className="focus-chat-mote-menu__notice">{recipientIssue}</p> : null}
          <DropdownMenu.RadioGroup value={topicId ?? ''} aria-label="Chat Mote">
            {motes.map(mote => { const icon = scratch && !mote.readError ? topicSpaceIconTarget(scratch, mote) : null
              return <DropdownMenu.RadioItem key={mote.id} value={mote.id} data-chat-mote-id={mote.id} className="tab-context-menu__item focus-chat-mote-menu__item" disabled={mote.id !== PMO_TEAMS_TOPIC_ID && Boolean(mote.readError)} onSelect={() => setFloating({ focusChatTopicId: mote.id })}>
                <span className="focus-chat-mote-menu__icon">
                <SpaceObjectIcon kind="mote" name={mote.title || 'Mote'} manualIcon={icon ? icons[icon.key] ?? null : null} avatarWorkspaceId={icon?.avatarTarget?.workspaceId} avatarTopicId={icon?.avatarTarget?.topicId} avatarObjectKey={icon?.key} />
                </span>
                <span className="focus-chat-mote-menu__name">{mote.title || 'Mote'}{mote.moteArchive?.state === 'archived' ? <small>Archived</small> : null}{mote.readError ? <small>{mote.id === PMO_TEAMS_TOPIC_ID ? 'Details unavailable' : 'Identity unconfirmed'}</small> : null}</span>
                <span className="focus-chat-mote-menu__check"><DropdownMenu.ItemIndicator><ThemeStatusSelectedIcon size={12} /></DropdownMenu.ItemIndicator></span>
              </DropdownMenu.RadioItem> })}
          </DropdownMenu.RadioGroup>
          {!motes.length ? <p className="focus-chat-mote-menu__notice">No confirmed Mote directory yet.</p> : null}
        </DropdownMenu.Content></DropdownMenu.Portal>
      </DropdownMenu.Root>
    </div>
    {selected?.actionable ? <button type="button" className="focus-toolbar__review" aria-label="Review request" title="Review request" onClick={onReview}><ThemeObjectInboxIcon size={12} /><span>Review</span></button> : null}
    <DropdownMenu.Root modal={false} open={menuOpen} onOpenChange={setMenuOpen}>
      <DropdownMenu.Trigger asChild><button type="button" className="icon-button focus-toolbar__view-menu" aria-label="Focus context actions" title={`Focus view actions · ${name}`} onPointerEnter={event => { if (!menuOpen && event.pointerType === 'mouse' && event.buttons === 0) menuOriginRef.current = null }} onPointerDown={event => { menuOriginRef.current = event.currentTarget }} onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ' || event.key === 'ArrowDown') menuOriginRef.current = event.currentTarget }}><ThemeActionMoreIcon size={14} /></button></DropdownMenu.Trigger>
      <DropdownMenu.Portal container={resolveOverlayContainer() as HTMLElement | undefined}><DropdownMenu.Content className="tab-context-menu" align="end" collisionPadding={8} onEscapeKeyDown={() => { menuEscapeReturnRef.current = menuOriginRef.current }} onCloseAutoFocus={closeMenuFocus}>{actions.map(action => <DropdownMenu.Item key={action.key} className="tab-context-menu__item" onSelect={action.run}><action.icon size={14} /><span>{action.label}</span></DropdownMenu.Item>)}</DropdownMenu.Content></DropdownMenu.Portal>
    </DropdownMenu.Root>
    <button type="button" className="icon-button" aria-label="Close Focus workspace" title="Collapse Focus workspace" onClick={onCloseWorkspace}><ThemeLayoutCloseRightIcon size={14} /></button>
    {stop.dialog}
  </div>
}
