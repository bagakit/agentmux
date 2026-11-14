import * as ContextMenu from '@radix-ui/react-context-menu'
import { useCallback, useContext, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import type { AgentDerivedAction } from '@agentmux/core/agent-derived-actions'
import { SettingsNavigation } from './SettingsNavigation'
import { useShallow } from 'zustand/react/shallow'
import { semanticIconComponent } from '@agentmux/client-ui/icons'
import type { FocusContext } from '../lib/focus-context'
import { agentRosterMenuActions } from '../lib/agent-roster-menu'
import { copyTextToClipboard } from '../lib/clipboard-copy'
import { useAppStore } from '../store'
import { AgentMenuIdentityActions } from './AgentMenuIdentityActions'
import { createRegionCopyModel, regionCopyLinkActions, RegionMenuEntryView } from './RegionContextMenu'
import { AgentSessionReadingSurface } from './AgentSessionReadingSurface'
import { SessionLearningSurface } from './SessionLearningSurface'
import { FocusWorkspaceStage } from './FocusWorkspaceStage'
import { SessionTakeoverSurface } from './SessionTakeoverSurface'
import { useAgentCurrentForkControls } from './AgentCurrentForkControls'
import type { TakeoverSource } from '../lib/session-takeover'
import { FocusAgentWorkspaceMenu } from './FocusAgentWorkspaceMenu'
import { focusAgentMenuLocation, requireFocusAgentMenuLocation } from '../lib/focus-agent-menu-location'
import { AgentMenuContent } from './AgentMenuContent'
import { WorkbenchMenuScope, WorkbenchMenuSubmit } from './WorkbenchMenuScope'
import { useAgentNativeSourceControls } from './AgentNativeSourceControls'
import { agentMenuRunMatches, agentMenuSession } from '../lib/agent-menu-target'
import { executionHostProjection } from '../lib/region-execution-host'
import { DocumentOverlayPortal } from './WindowOverlayHost'
import { useSessionStop } from './SessionStop'
import { useSessionRestart } from './SessionRestart'
import { useWorkbenchPresentationActive } from '../lib/workbench-presentation'
import { useAgentConnectorMenu } from '../lib/use-agent-connector-menu'
import { useAgentPromotion } from '../lib/use-agent-promotion'
import { requestWorkbenchReferenceClose } from '../lib/workbench-close-request'

const ThemeActionEditIcon = semanticIconComponent('action.edit')
const AgentIcon = semanticIconComponent('object.agent')


/** The original card carries both its presentation address and canonical execution control. */
export function FocusContextMenu(props: Parameters<typeof LocalFocusContextMenu>[0]) {
  return props.context.access ? <SourceFocusContextMenu {...props} /> : <LocalFocusContextMenu {...props} />
}

function LocalFocusContextMenu({ open, context, children, onOpenChange, onRename, onRestoreFocus }: {
  open: boolean; context: FocusContext; children: ReactNode; onOpenChange(open: boolean): void; onRename(): void; onRestoreFocus(): void
}) {
  const active = useWorkbenchPresentationActive()
  const settings = useContext(SettingsNavigation)
  const activeRef = useRef(active); activeRef.current = active
  const sessionId = context.id
  const actionOwnsFocus = useRef(false)
  const origin = useRef<HTMLElement | null>(null)
  const stop = useSessionStop(active)
  const restart = useSessionRestart(active)
  const connector = useAgentConnectorMenu(undefined, context.id, undefined, { source: context, active })
  // Keep the original confirmation controller through dismissal, but only an open
  // menu subscribes to Store changes. Closed cards add no update fan-out/readers.
  const subscribe = useCallback((listener: () => void) => open ? useAppStore.subscribe(listener) : () => {}, [open])
  const selectFacts = useShallow((state: ReturnType<typeof useAppStore.getState>) => ({
    session: agentMenuSession(state.sessions, context),
    host: state.config?.hosts.find(host => host.id === (context.control?.hostId ?? context.hostId)),
    executor: context.executorId ? state.config?.executors[context.executorId] : undefined,
    config: state.config, sessions: state.sessions, tabs: state.tabs, layouts: state.layouts,
    spaceZoneBindings: state.spaceZoneBindings, spatialRequests: state.spatialRequests,
    topicCategories: state.topicCategories,
    projectGroups: state.projectGroups, scratchTopicSnapshots: state.scratchTopicSnapshots
  }))
  const heldFacts = useRef<ReturnType<typeof selectFacts> | null>(null)
  const readFacts = useCallback(() => {
    if (open) heldFacts.current = selectFacts(useAppStore.getState())
    return heldFacts.current
  }, [open, selectFacts])
  const facts = useSyncExternalStore(subscribe, readFacts, readFacts)
  const { session, host, executor } = facts ?? {}
  const location = useMemo(() => open && facts ? focusAgentMenuLocation(facts, context) : null, [open, facts, context])
  const promotion = useAgentPromotion(session, context.name, location?.reference)
  const [reading, setReading] = useState<{ mode: 'history' | 'learn'; source: { hostId: string; agentSessionId: string }; label: string } | null>(null)
  const [takeover, setTakeover] = useState<TakeoverSource | null>(null)
  const forkOrigin = location?.reference ? { workspaceId: location.reference.displayWorkspaceId, tabGroupId: location.reference.groupId,
    tabId: location.reference.tabId, regionId: location.reference.regionId, sessionId: context.id } : { sessionId: context.id }
  const forkAt = useAgentCurrentForkControls({ session: session ?? null, linkOrigin: forkOrigin, readOnly: false, sessionSource: !location?.reference })
  /** With one confirmed location the action opens in its own Region; only placeless cards ask where. */
  function openInRegion(actionId: string): boolean {
    const state = useAppStore.getState(), reference = location?.reference
    const current = agentMenuSession(state.sessions, context)
    if (!reference || !current || !context.control) return false
    try { requireFocusAgentMenuLocation(state, context, reference) } catch { return false }
    actionOwnsFocus.current = true
    if (!state.focusExecutionSession(context.id, reference)) return true
    state.requestRegionDerivedAction({ tabId: reference.tabId, regionId: reference.regionId, sessionId: current.id, runId: current.control.run.runId, actionId })
    return true
  }
  function openTakeover(derived?: AgentDerivedAction) {
    const current = agentMenuSession(useAppStore.getState().sessions, context)
    if (!current || !context.control || !agentMenuRunMatches(current, context.control)) {
      useAppStore.getState().reportError(new Error('The original Agent or Run changed. Reopen this Agent menu to review its current source.'), { kind: 'indeterminate', ...(context.control ? { subject: context.control } : {}) })
      return
    }
    if (openInRegion(derived ? derived.id : 'take-over')) return
    actionOwnsFocus.current = true
    setTakeover({ kind: 'session', hostId: current.control.hostId, agentSessionId: current.control.agentSessionId, presentationSessionId: current.id,
      expectedRun: { ...current.control.run }, cwd: current.workspacePath, label: context.name, executorId: current.executorId,
      ...(context.access?.identity.runtimeId ? { expectedRuntimeId: context.access.identity.runtimeId } : {}),
      diagnostic: current.status.detail ?? context.detail, origin: { sessionId: current.id },
      ...(derived ? { derived: { id: derived.id, label: derived.label, instruction: derived.instruction } } : {}) })
  }
  function openReading(mode: 'history' | 'learn') {
    if (!context.control) return
    if (mode === 'learn' && openInRegion('pass-on-experience')) return
    actionOwnsFocus.current = true
    setReading({ mode, source: { hostId: context.control.hostId, agentSessionId: context.control.agentSessionId }, label: context.name })
  }
  const nativeSource = useAgentNativeSourceControls({ session: session ?? null, readOnly: false })
  const [refreshing, setRefreshing] = useState(false)
  async function refreshObservation() {
    setRefreshing(true)
    try { await useAppStore.getState().refreshSession(context.id) }
    catch (error) { useAppStore.getState().reportError(error) }
    finally { setRefreshing(false) }
  }
  const actions = context.control ? agentRosterMenuActions({ sessionId: context.control.agentSessionId, writeClipboardText: async text => {
    await copyTextToClipboard(text, error => useAppStore.getState().reportError(error))
  } }) : [{ key: 'copy-session' as const, label: 'Copy Agent Link' as const, onSelect: async () => {
    useAppStore.getState().reportError(new Error('The original canonical Agent identity is not confirmed. No Agent link was copied.'), {
      kind: 'indeterminate', summary: 'The original work surface and draft are kept. Refresh this Agent’s identity, then retry Copy Agent Link.'
    })
  } }]
  const regionLinks = location?.reference ? regionCopyLinkActions(createRegionCopyModel({ regionId: location.reference.regionId, agentSessionId: null,
    writeClipboardText: async text => {
      try { requireFocusAgentMenuLocation(useAppStore.getState(), context, location.reference!); await copyTextToClipboard(text, error => useAppStore.getState().reportError(error)) }
      catch (error) { useAppStore.getState().reportError(error) }
    } }).entries) : []
  return <><ContextMenu.Root modal={false} open={open} onOpenChange={open => { if (open) actionOwnsFocus.current = false; connector.onOpen(open); onOpenChange(open) }}>
    <ContextMenu.Trigger asChild onContextMenu={event => { origin.current = event.currentTarget }} onKeyDown={event => {
      if (event.key !== 'ContextMenu' && !(event.key === 'F10' && event.shiftKey)) return
      event.preventDefault()
      const rect = event.currentTarget.getBoundingClientRect()
      event.currentTarget.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: rect.left, clientY: rect.bottom }))
    }}>{children}</ContextMenu.Trigger>
    {open ? <DocumentOverlayPortal component={ContextMenu.Portal}>
      <ContextMenu.Content className="tab-context-menu focus-context-menu" data-agent-session-id={sessionId} collisionPadding={8}
        onCloseAutoFocus={event => {
          if (!activeRef.current) { event.preventDefault(); return }
          const activeElement = document.activeElement
          const closing = event.target
          const laterFocus = activeElement instanceof HTMLElement && activeElement !== document.body &&
            closing instanceof HTMLElement && !closing.contains(activeElement)
          if (actionOwnsFocus.current || connector.dialogOpen || laterFocus) { event.preventDefault(); actionOwnsFocus.current = false }
          else onRestoreFocus()
        }}>
        <WorkbenchMenuScope.Provider value={ContextMenu}><WorkbenchMenuSubmit.Provider value={() => onOpenChange(false)}>
          <AgentMenuContent name={context.name} executorLabel={executor?.label ?? context.providerId ?? 'Executor unknown'}
            sessionId={context.control?.agentSessionId}
            executionHost={executionHostProjection(context.control?.hostId ?? context.hostId, context.workspacePath, host)}
            links={<AgentMenuIdentityActions links={[...actions.map(action => ({ ...action, icon: <AgentIcon size={16} /> })), ...regionLinks]}
              session={session ?? null} providerId={session?.providerId ?? context.providerId ?? undefined} executorId={context.executorId}
              executorLabel={executor?.label ?? context.providerId ?? 'Executor unknown'} Item={ContextMenu.Item} Group={ContextMenu.Group} Label={ContextMenu.Label} />}
            onPromote={promotion.open ? () => { actionOwnsFocus.current = true; promotion.open?.() } : undefined}
            onHistory={context.control ? () => openReading('history') : undefined}
            onLearn={context.control ? () => openReading('learn') : undefined}
            onTakeOver={session ? () => openTakeover() : undefined}
            onDerived={session ? action => openTakeover(action) : undefined}
            onCustomize={settings ? () => { actionOwnsFocus.current = true; settings.open('derived-actions') } : undefined}
            nativeSourceDetails={nativeSource.details} nativeSourceCheck={nativeSource.checkAction}
            onRefreshObservation={session ? refreshObservation : undefined} refreshing={refreshing}
            onRestart={() => { actionOwnsFocus.current = true; onRestoreFocus(); restart.requestRestart(context, context.name, origin.current) }}
            onStop={() => { actionOwnsFocus.current = true; onRestoreFocus(); stop.requestStop(context, context.name, origin.current) }}
            onCloseWorkface={location?.reference ? () => {
              try {
                const state = useAppStore.getState(), reference = location.reference!
                const surface = state.tabs[reference.tabId]?.regions[reference.regionId]
                if (surface?.kind !== 'agent' || surface.sessionId !== context.id) throw Error('This Agent workface changed. Choose its current exact position before closing.')
                actionOwnsFocus.current = true
                requestWorkbenchReferenceClose(reference)
              } catch (error) { useAppStore.getState().reportError(error) }
            } : undefined}
            extensions={{ controls: forkAt(), forkAction: action => forkAt(undefined, { id: action.id, label: action.label, instruction: action.instruction }), workspace: location ? <FocusAgentWorkspaceMenu target={context} references={location.references} issue={location.issue} /> : null,
              connections: connector.group ? <RegionMenuEntryView entry={{ kind: 'connector-group', group: connector.group }} index={0} nested
                Item={ContextMenu.Item} Group={ContextMenu.Group} Label={ContextMenu.Label} Separator={ContextMenu.Separator}
                Sub={ContextMenu.Sub} SubTrigger={ContextMenu.SubTrigger} SubContent={ContextMenu.SubContent} Portal={ContextMenu.Portal} /> : null,
              identityActions: <ContextMenu.Item className="tab-context-menu__item" onSelect={() => {
              actionOwnsFocus.current = true; onRename()
            }}><ThemeActionEditIcon size={14} /><span>Rename Agent</span></ContextMenu.Item> }} />
        </WorkbenchMenuSubmit.Provider></WorkbenchMenuScope.Provider>
      </ContextMenu.Content>
    </DocumentOverlayPortal> : null}
  </ContextMenu.Root>{promotion.feedback}{active ? <>{promotion.dialog}{restart.dialog}{stop.dialog}{connector.dialog}{reading?.mode === 'history' ? <AgentSessionReadingSurface source={reading.source} label={reading.label} returnTrigger={origin.current} onClose={() => setReading(null)} /> : null}
    {reading?.mode === 'learn' ? <FocusWorkspaceStage><SessionLearningSurface source={reading.source} label={reading.label} active returnTrigger={origin.current as HTMLButtonElement | null} onClose={() => setReading(null)} /></FocusWorkspaceStage> : null}
    {takeover ? <FocusWorkspaceStage><SessionTakeoverSurface source={takeover} active returnTrigger={origin.current as HTMLButtonElement | null} onClose={() => setTakeover(null)} /></FocusWorkspaceStage> : null}</> : null}</>
}


/** The common menu body consumes source-qualified capabilities; no local Session lookup. */
function SourceFocusContextMenu({ context, children, open, onOpenChange, onRename, onRestoreFocus }: Parameters<typeof LocalFocusContextMenu>[0]) {
  const access = context.access!, active = useWorkbenchPresentationActive()
  const [reading, setReading] = useState(false)
  const trigger = useRef<HTMLElement | null>(null), actionOwnsFocus = useRef(false)
  return <><ContextMenu.Root modal={false} open={active && open} onOpenChange={onOpenChange}>
    <ContextMenu.Trigger asChild onContextMenu={event => { trigger.current = event.currentTarget }}>{children}</ContextMenu.Trigger>
    {open ? <DocumentOverlayPortal component={ContextMenu.Portal}><ContextMenu.Content className="tab-context-menu focus-context-menu" collisionPadding={8} onCloseAutoFocus={event => {
      const activeElement = document.activeElement, closing = event.target
      const laterFocus = activeElement instanceof HTMLElement && activeElement !== document.body && closing instanceof HTMLElement && !closing.contains(activeElement)
      if (!active || actionOwnsFocus.current || laterFocus) { event.preventDefault(); actionOwnsFocus.current = false }
      else onRestoreFocus()
    }}>
      <WorkbenchMenuScope.Provider value={ContextMenu}><WorkbenchMenuSubmit.Provider value={() => onOpenChange(false)}>
        <AgentMenuContent name={context.name} executorLabel={context.providerId ?? 'Executor unknown'} sessionId={access.identity.agentSessionId}
          executionHost={executionHostProjection(access.identity.runtimeId, context.workspacePath)}
          links={<ContextMenu.Item className="tab-context-menu__item" onSelect={() => { void copyTextToClipboard(JSON.stringify(access.identity), error => useAppStore.getState().reportError(error)) }}>Copy Agent identity</ContextMenu.Item>}
          onHistory={access.conversationPort && access.conversationReference ? () => setReading(true) : undefined}
          onRefreshObservation={access.refresh}
          onCloseWorkface={access.close ? () => { actionOwnsFocus.current = true; access.close?.() } : undefined}
          extensions={{ workspace: <ContextMenu.Item className="tab-context-menu__item" onSelect={() => access.open()}>View in Space</ContextMenu.Item>,
            identityActions: access.rename && access.nameRevision !== undefined ? <ContextMenu.Item className="tab-context-menu__item" onSelect={() => { actionOwnsFocus.current = true; onRename() }}><ThemeActionEditIcon size={14} /><span>Rename Agent</span></ContextMenu.Item> : undefined,
            context: access.issue ? <ContextMenu.Label className="tab-context-menu__label">{access.issue}</ContextMenu.Label> : undefined }} />
      </WorkbenchMenuSubmit.Provider></WorkbenchMenuScope.Provider>
    </ContextMenu.Content></DocumentOverlayPortal> : null}
  </ContextMenu.Root>{active && reading && access.conversationPort && access.conversationReference ? <AgentSessionReadingSurface source={access.conversationReference} port={access.conversationPort} label={context.name} returnTrigger={trigger.current} onClose={() => setReading(false)} /> : null}</>
}
