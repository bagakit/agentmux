import { RegionCurrentDemand } from './RegionCurrentDemand'
import { AgentConnections } from './AgentConnections'
import { useAppStore } from '../store'
import { sessionPresentationById } from '../lib/session-presentation'
import { semanticIconComponent } from '@agentmux/client-ui/icons'
import { useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import * as DropdownMenu from './HoverDropdownMenu'
import { useRegionMenuEntries, useRegionMenuObservation, type RegionContextContribution } from './RegionContextMenu'
import { AgentRegionMenuContent } from './AgentRegionMenuContent'
import { useSessionStop } from './SessionStop'
import { useWorkbenchPresentationActive } from '../lib/workbench-presentation'
import { WorkbenchMenuScope } from './WorkbenchMenuScope'
import * as ContextMenu from '@radix-ui/react-context-menu'
import { DocumentOverlayPortal } from './WindowOverlayHost'
import { HostBadge } from './HostBadge'
import type { RegionExecutionHost } from '../lib/region-execution-host'
import { useAgentNativeSourceControls, nativeSourceLabel, type AgentNativeSourceReference } from './AgentNativeSourceControls'

const ThemeActionMoreIcon = semanticIconComponent('action.more')


/** SessionPane owns identity/reading; layout and address actions arrive already bound to the Region. */
export function AgentRegionHeader({ name, executorLabel, sessionId, sessionKind, executionHost, regionId, readOnly, onHistory, onTakeOver, onLearn, onRefreshObservation, refreshing = false, portalTargetId = null, resultReview, nativeSession, currentConversationActions }: {
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
  onRefreshObservation?: (() => void) | undefined
  refreshing?: boolean
  /** One precise owner may present its existing controls in the Focus bar. */
  portalTargetId?: string | null
  resultReview?: ReactNode
  currentConversationActions?: ReactNode
  nativeSession?: AgentNativeSourceReference | undefined
}) {
  const connectorSession = useAppStore(state => sessionKind === 'agent' ? sessionPresentationById(state.sessions).get(sessionId) : undefined)
  const entries = useRegionMenuEntries()
  const active = useWorkbenchPresentationActive()
  const stop = useSessionStop(active)
  const moreTrigger = useRef<HTMLButtonElement>(null)
  const menuObservation = useRegionMenuObservation()
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
  useLayoutEffect(() => () => host?.remove(), [host])
  const content = (contextual?: RegionContextContribution | null) => <AgentRegionMenuContent name={name} executorLabel={executorLabel} sessionId={sessionId}
    sessionKind={sessionKind} executionHost={executionHost} readOnly={readOnly}
    entries={[...(contextual?.agentLink ? [{ kind: 'action' as const, action: contextual.agentLink }] : []),
      ...(sessionKind === 'agent' && !readOnly ? [...entries, { kind: 'stop' as const, onSelect: () => {
      stop.requestStop(nativeSession ? { id: nativeSession.id, hostId: nativeSession.control.hostId, control: nativeSession.control } : null, name, moreTrigger.current)
    } }] : entries)]}
    onTakeOver={onTakeOver ? () => { handoffFocus.current = true; onTakeOver(moreTrigger.current ?? undefined) } : undefined}
    onLearn={onLearn ? () => { handoffFocus.current = true; onLearn(moreTrigger.current ?? undefined) } : undefined}
    onHistory={onHistory ? () => { handoffFocus.current = true; onHistory(moreTrigger.current ?? undefined) } : undefined} onRefreshObservation={onRefreshObservation} refreshing={refreshing}
    nativeSourceDetails={nativeSource.details} nativeSourceCheck={nativeSource.checkAction} currentConversationActions={currentConversationActions} contextualActions={contextual?.tools} />
  function closeMenuFocus(event: Event) {
    if (handoffFocus.current || menuObservation.dialogOpen || stop.dialog !== null) event.preventDefault()
    handoffFocus.current = false
  }
  const header = <header className="agent-region-header"
    data-agent-session-id={sessionKind === 'agent' ? sessionId : undefined} data-owner-region-id={regionId}
    data-session-kind={sessionKind}
    aria-label={`${sessionKind === 'agent' ? 'Agent' : 'Terminal'} ${name}; ${readOnly ? 'Read-only; ' : ''}${executorLabel}; ${sessionKind === 'agent' ? 'Session' : 'Terminal'} ${sessionId}; Host ${executionHost.label}`}>
    <strong className="agent-region-header__name" title={name}>{name}</strong>
    <HostBadge host={executionHost} />
    {readOnly ? <span className="agent-region-header__mode">Read-only</span> : null}
    {resultReview}
    {!readOnly && connectorSession?.kind === 'agent' ? <AgentConnections session={connectorSession} regionId={regionId} visible={active} /> : null}
    {sessionKind === 'agent' && nativeSession ? <RegionCurrentDemand agentSessionId={nativeSession.control.agentSessionId} hostId={nativeSession.control.hostId} /> : null}
    <DropdownMenu.Root {...(menuObservation.moreOpen !== undefined ? { open: menuObservation.moreOpen } : {})} onOpenChange={menuObservation.onOpen}>
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
        <WorkbenchMenuScope.Provider value={DropdownMenu}>{content()}</WorkbenchMenuScope.Provider>
      </DropdownMenu.Content></DropdownMenu.Portal>
    </DropdownMenu.Root>
    {sessionKind === 'agent' && menuObservation.setAgentMenuAvailable ? <DocumentOverlayPortal component={ContextMenu.Portal}>
      <ContextMenu.Content className="tab-context-menu agent-region-menu" data-menu-entry="context"
        data-owner-region-id={regionId} data-agent-session-id={sessionId} collisionPadding={8}
        onPointerDown={event => event.stopPropagation()} onCloseAutoFocus={event => {
          closeMenuFocus(event)
          menuObservation.onContextCloseAutoFocus?.(event)
        }}>
        <WorkbenchMenuScope.Provider value={ContextMenu}>{content(menuObservation.contextualMenu)}</WorkbenchMenuScope.Provider>
      </ContextMenu.Content>
    </DocumentOverlayPortal> : null}
  </header>
  return <>{host ? <><div ref={home} className="agent-region-header-home" />{createPortal(header, host)}</> : header}{active ? stop.dialog : null}</>
}
