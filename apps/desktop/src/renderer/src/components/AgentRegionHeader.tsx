import { AgentWorkModeBadge } from './AgentWorkModeBadge'
import { AgentOperationFeedback } from './AgentOperationFeedback'
import { RegionCurrentDemand } from './RegionCurrentDemand'
import { AgentConnections } from './AgentConnections'
import { useAppStore } from '../store'
import { sessionPresentationById } from '../lib/session-presentation'
import { semanticIconComponent } from '@agentmux/client-ui/icons'
import { useContext, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import type { AgentDerivedAction } from '@agentmux/core/agent-derived-actions'
import { SettingsNavigation } from './SettingsNavigation'
import { createPortal } from 'react-dom'
import * as DropdownMenu from './HoverDropdownMenu'
import { RegionCopyLinkRow, regionCopyLinkActions, RegionMenuEntryView, useRegionMenuEntries, useRegionMenuObservation, type RegionContextContribution } from './RegionContextMenu'
import { AgentMenuContent } from './AgentMenuContent'
import { AgentMenuIdentityActions } from './AgentMenuIdentityActions'
import { useSessionStop } from './SessionStop'
import { useWorkbenchPresentationActive, WorkbenchPresentationContext } from '../lib/workbench-presentation'
import { useAgentPromotion } from '../lib/use-agent-promotion'
import { WorkbenchMenuScope, WorkbenchMenuSubmit } from './WorkbenchMenuScope'
import * as ContextMenu from '@radix-ui/react-context-menu'
import { DocumentOverlayPortal } from './WindowOverlayHost'
import { HostBadge } from './HostBadge'
import type { RegionExecutionHost } from '../lib/region-execution-host'
import { useAgentNativeSourceControls, nativeSourceLabel, type AgentNativeSourceReference } from './AgentNativeSourceControls'

const ThemeActionMoreIcon = semanticIconComponent('action.more')


/** SessionPane owns identity/reading; layout and address actions arrive already bound to the Region. */
export function AgentRegionHeader({ name, executorLabel, sessionId, sessionKind, executionHost, regionId, readOnly, onHistory, onTakeOver, onLearn, onDerived, onRefreshObservation, refreshing = false, portalTargetId = null, resultReview, recordDetails, nativeSession, currentConversationActions, forkAction }: {
  name: string
  executorLabel: string
  sessionId: string
  sessionKind: 'agent' | 'terminal'
  executionHost: RegionExecutionHost
  regionId: string | undefined
  readOnly: boolean
  onHistory: ((trigger?: HTMLButtonElement) => void) | undefined
  onTakeOver?: ((trigger?: HTMLButtonElement) => void) | undefined
  onLearn?: ((trigger?: HTMLButtonElement) => void) | undefined
  onDerived?: ((action: AgentDerivedAction, trigger?: HTMLButtonElement) => void) | undefined
  onRefreshObservation?: (() => void) | undefined
  refreshing?: boolean
  /** One precise owner may present its existing controls in the Focus bar. */
  portalTargetId?: string | null
  resultReview?: ReactNode
  recordDetails?: ReactNode
  currentConversationActions?: ReactNode
  forkAction?: ((action: AgentDerivedAction) => ReactNode) | undefined
  nativeSession?: AgentNativeSourceReference | undefined
}) {
  const settings = useContext(SettingsNavigation)
  const connectorSession = useAppStore(state => {
    const session = sessionKind === 'agent' ? sessionPresentationById(state.sessions).get(sessionId) : undefined
    return session?.kind === 'agent' ? session : undefined
  })
  const presentation = useContext(WorkbenchPresentationContext)
  const promotion = useAgentPromotion(readOnly ? null : connectorSession, name, presentation.reference && regionId ? { ...presentation.reference, regionId } : undefined, regionId)
  const entries = useRegionMenuEntries()
  const active = useWorkbenchPresentationActive()
  const stop = useSessionStop(active)
  const moreTrigger = useRef<HTMLButtonElement>(null)
  const menuObservation = useRegionMenuObservation()
  const [localMenuOpen, setLocalMenuOpen] = useState(false)
  function changeMenu(open: boolean) { setLocalMenuOpen(open); menuObservation.onOpen(open) }
  function submitMenu() {
    setLocalMenuOpen(false)
    if (menuObservation.onSubmitted) menuObservation.onSubmitted()
    else menuObservation.onOpen(false)
  }
  const nativeSource = useAgentNativeSourceControls({ session: nativeSession ?? null, readOnly })
  useLayoutEffect(() => {
    if (sessionKind !== 'agent' || !menuObservation.setAgentMenuAvailable) return
    menuObservation.setAgentMenuAvailable(true)
    return () => menuObservation.setAgentMenuAvailable?.(false)
  }, [sessionKind, menuObservation.setAgentMenuAvailable])
  const home = useRef<HTMLDivElement>(null)
  const handoffFocus = useRef(false)
  const [host] = useState(() => {
    // Static SessionPane presentation has no DOM host to move.
    if (typeof document === 'undefined') return null
    const element = document.createElement('div')
    element.className = 'agent-region-header-host'
    return element
  })
  const targetId = readOnly ? null : portalTargetId
  useLayoutEffect(() => {
    if (!host) return
    const attach = () => {
      const target = targetId ? document.getElementById(targetId) : null
      const destination = target ?? home.current
      if (destination && host.parentElement !== destination) destination.append(host)
      return targetId === null || target !== null
    }
    // Missing destinations keep the original local Header readable and operable.
    if (attach()) return
    const observer = new MutationObserver(() => { if (attach()) observer.disconnect() })
    observer.observe(document.body, { childList: true, subtree: true })
    return () => observer.disconnect()
  }, [host, targetId])
  useLayoutEffect(() => host ? host.remove.bind(host) : undefined, [host])
  const content = (Menu: typeof ContextMenu | typeof DropdownMenu, contextual?: RegionContextContribution | null) => <AgentMenuContent
    name={name} executorLabel={executorLabel} sessionId={nativeSession?.control.agentSessionId ?? sessionId}
    sessionKind={sessionKind} executionHost={executionHost} readOnly={readOnly}
    links={sessionKind === 'agent' ? <AgentMenuIdentityActions
      links={regionCopyLinkActions([...(contextual?.agentLink ? [{ kind: 'action' as const, action: contextual.agentLink }] : []), ...entries])}
      session={nativeSession ?? null} providerId={connectorSession?.providerId} executorId={connectorSession?.executorId}
      executorLabel={executorLabel} Item={Menu.Item} Group={Menu.Group} Label={Menu.Label} />
      : entries.some(entry => entry.kind === 'action') ? <RegionCopyLinkRow entries={entries}
        Item={Menu.Item} Group={Menu.Group} Label={Menu.Label} labelPresentation="tooltip" /> : null}
    onPromote={promotion.open ? () => { handoffFocus.current = true; promotion.open?.() } : undefined}
    onRestart={entries.find(entry => entry.kind === 'restart')?.onSelect}
    onStop={sessionKind === 'agent' && !readOnly ? () => {
      stop.requestStop(nativeSession ? { id: nativeSession.id, hostId: nativeSession.control.hostId, control: nativeSession.control } : null, name, moreTrigger.current)
    } : undefined}
    onTakeOver={onTakeOver ? () => { handoffFocus.current = true; onTakeOver(moreTrigger.current ?? undefined) } : undefined}
    onLearn={onLearn ? () => { handoffFocus.current = true; onLearn(moreTrigger.current ?? undefined) } : undefined}
    onDerived={onDerived ? action => { handoffFocus.current = true; onDerived(action, moreTrigger.current ?? undefined) } : undefined}
    onCustomize={settings ? () => settings.open('derived-actions') : undefined}
    onHistory={onHistory ? () => { handoffFocus.current = true; onHistory(moreTrigger.current ?? undefined) } : undefined}
    onRefreshObservation={onRefreshObservation} refreshing={refreshing}
    nativeSourceDetails={nativeSource.details} nativeSourceCheck={nativeSource.checkAction}
    extensions={{ context: contextual?.tools, controls: currentConversationActions, forkAction,
      workspace: entries.some(entry => ['layout', 'swaps', 'promote', 'window'].includes(entry.kind)) ? entries
        .filter(entry => ['layout', 'swaps', 'promote', 'window'].includes(entry.kind))
        .map((entry, index) => <RegionMenuEntryView key={index} entry={entry} index={index}
          Item={Menu.Item} Separator={Menu.Separator} Group={Menu.Group} Label={Menu.Label}
          Sub={Menu.Sub} SubTrigger={Menu.SubTrigger} SubContent={Menu.SubContent} Portal={Menu.Portal} />) : null,
      connections: entries.some(entry => entry.kind === 'connector-group') ? entries.filter(entry => entry.kind === 'connector-group')
        .map((entry, index) => <RegionMenuEntryView key={index} entry={entry} index={index} nested
          Item={Menu.Item} Separator={Menu.Separator} Group={Menu.Group} Label={Menu.Label}
          Sub={Menu.Sub} SubTrigger={Menu.SubTrigger} SubContent={Menu.SubContent} Portal={Menu.Portal} />) : null }} />
  function closeMenuFocus(event: Event) {
    const closing = event.target as Element | null
    const owner = closing?.ownerDocument ?? moreTrigger.current?.ownerDocument
    const focused = owner?.activeElement
    const laterFocus = closing?.nodeType === 1 && focused && focused !== owner?.body && !closing.contains(focused)
    if (handoffFocus.current || menuObservation.dialogOpen || stop.dialog !== null || laterFocus) event.preventDefault()
    handoffFocus.current = false
  }
  const header = <header className="agent-region-header"
    data-agent-session-id={sessionKind === 'agent' ? sessionId : undefined} data-owner-region-id={regionId}
    data-session-kind={sessionKind}
    aria-label={`${sessionKind === 'agent' ? 'Agent' : 'Terminal'} ${name}; ${readOnly ? 'Read-only; ' : ''}${executorLabel}; ${sessionKind === 'agent' ? 'Session' : 'Terminal'} ${sessionId}; Host ${executionHost.label}`}>
    <strong className="agent-region-header__name" title={name}>{name}</strong>
    {sessionKind === 'agent' ? <AgentWorkModeBadge source={connectorSession ?? (executionHost.id === null ? undefined : {
      hostId: executionHost.id, workspacePath: '', resourceUnobserved: true
    })} /> : <HostBadge host={executionHost} />}
    {connectorSession?.kind === 'agent' ? <AgentOperationFeedback compact subject={{ hostId: connectorSession.control.hostId, agentSessionId: connectorSession.control.agentSessionId, regionId }} /> : null}
    {readOnly ? <span className="agent-region-header__mode">Read-only</span> : null}
    {promotion.feedback}
    {recordDetails}
    {resultReview}
    {!readOnly && connectorSession?.kind === 'agent' ? <AgentConnections session={connectorSession} regionId={regionId} visible={active} /> : null}
    {sessionKind === 'agent' && nativeSession ? <RegionCurrentDemand agentSessionId={nativeSession.control.agentSessionId} hostId={nativeSession.control.hostId} /> : null}
    <DropdownMenu.Root open={menuObservation.moreOpen ?? localMenuOpen} onOpenChange={changeMenu}>
      <DropdownMenu.Trigger ref={moreTrigger} className="agent-region-header__more"
        aria-label={`More actions for ${name}${nativeSession && nativeSourceLabel(nativeSession) ? `; ${nativeSourceLabel(nativeSession)}` : ''}`} title={`${name}; ${executorLabel}; ${executionHost.label}`}
        onPointerDown={event => event.stopPropagation()}>
        {nativeSession && nativeSourceLabel(nativeSession) ? <span className="agent-region-header__source" data-native-source-marker="">{nativeSourceLabel(nativeSession)}</span> : null}
        <ThemeActionMoreIcon size={14} />
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal><DropdownMenu.Content className="tab-context-menu agent-region-menu"
        data-menu-entry="more" data-owner-region-id={regionId} data-agent-session-id={sessionKind === 'agent' ? sessionId : undefined} side="bottom" align="end" sideOffset={0} collisionPadding={8}
        onPointerDown={(event) => event.stopPropagation()}
        onCloseAutoFocus={closeMenuFocus}>
        <WorkbenchMenuScope.Provider value={DropdownMenu}><WorkbenchMenuSubmit.Provider value={submitMenu}>{content(DropdownMenu)}</WorkbenchMenuSubmit.Provider></WorkbenchMenuScope.Provider>
      </DropdownMenu.Content></DropdownMenu.Portal>
    </DropdownMenu.Root>
    {sessionKind === 'agent' && menuObservation.setAgentMenuAvailable ? <DocumentOverlayPortal component={ContextMenu.Portal}>
      <ContextMenu.Content className="tab-context-menu agent-region-menu" data-menu-entry="context"
        data-owner-region-id={regionId} data-agent-session-id={sessionId} collisionPadding={8}
        onPointerDown={event => event.stopPropagation()} onCloseAutoFocus={event => {
          closeMenuFocus(event)
          menuObservation.onContextCloseAutoFocus?.(event)
        }}>
        <WorkbenchMenuScope.Provider value={ContextMenu}><WorkbenchMenuSubmit.Provider value={submitMenu}>{content(ContextMenu, menuObservation.contextualMenu)}</WorkbenchMenuSubmit.Provider></WorkbenchMenuScope.Provider>
      </ContextMenu.Content>
    </DocumentOverlayPortal> : null}
  </header>
  return <>{host ? <><div ref={home} className="agent-region-header-home" />{createPortal(header, host)}</> : header}{active ? <>{stop.dialog}{promotion.dialog}</> : null}</>
}
