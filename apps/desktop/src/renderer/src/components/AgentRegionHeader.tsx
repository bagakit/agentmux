import { ArrowRight, History, MoreHorizontal, RotateCcw } from 'lucide-react'
import { useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import * as DropdownMenu from './HoverDropdownMenu'
import { RegionMenuEntryView, useRegionMenuEntries } from './RegionContextMenu'
import { HostBadge } from './HostBadge'
import type { RegionExecutionHost } from '../lib/region-execution-host'
import { useAgentNativeSourceControls, nativeSourceLabel, type AgentNativeSourceReference } from './AgentNativeSourceControls'

/** SessionPane owns identity/reading; layout and address actions arrive already bound to the Region. */
export function AgentRegionHeader({ name, executorLabel, sessionId, sessionKind, executionHost, regionId, readOnly, onHistory, onTakeOver, onRefreshObservation, refreshing = false, portalTargetId = null, resultReview, nativeSession, currentConversationActions }: {
  name: string
  executorLabel: string
  sessionId: string
  sessionKind: 'agent' | 'terminal'
  executionHost: RegionExecutionHost
  regionId: string | undefined
  readOnly: boolean
  onHistory: (() => void) | undefined
  onTakeOver?: (() => void) | undefined
  onRefreshObservation?: (() => void) | undefined
  refreshing?: boolean
  /** One precise owner may present its existing controls in the Focus bar. */
  portalTargetId?: string | null
  resultReview?: ReactNode
  currentConversationActions?: ReactNode
  nativeSession?: AgentNativeSourceReference | undefined
}) {
  const entries = useRegionMenuEntries()
  const nativeSourceActions = useAgentNativeSourceControls({ session: nativeSession ?? null, readOnly })
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
  const header = <header className="agent-region-header"
    data-agent-session-id={sessionKind === 'agent' ? sessionId : undefined} data-owner-region-id={regionId}
    data-session-kind={sessionKind}
    aria-label={`${sessionKind === 'agent' ? 'Agent' : 'Terminal'} ${name}; ${readOnly ? 'Read-only; ' : ''}${executorLabel}; ${sessionKind === 'agent' ? 'Session' : 'Terminal'} ${sessionId}; Host ${executionHost.label}`}>
    <strong className="agent-region-header__name" title={name}>{name}</strong>
    <HostBadge host={executionHost} />
    {readOnly ? <span className="agent-region-header__mode">Read-only</span> : null}
    {resultReview}
    <DropdownMenu.Root>
      <DropdownMenu.Trigger className="agent-region-header__more"
        aria-label={`More actions for ${name}${nativeSession && nativeSourceLabel(nativeSession) ? `; ${nativeSourceLabel(nativeSession)}` : ''}`} title={`${name}; ${executorLabel}; ${executionHost.label}`}
        onPointerDown={(event) => event.stopPropagation()}>
        {nativeSession && nativeSourceLabel(nativeSession) ? <span className="agent-region-header__source" data-native-source-marker="">{nativeSourceLabel(nativeSession)}</span> : null}
        <MoreHorizontal size={14} />
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal><DropdownMenu.Content className="tab-context-menu agent-region-menu"
        data-owner-region-id={regionId} data-agent-session-id={sessionKind === 'agent' ? sessionId : undefined} side="bottom" align="end" sideOffset={4} collisionPadding={8}
        onPointerDown={(event) => event.stopPropagation()}
        onCloseAutoFocus={event => {
          if (handoffFocus.current) event.preventDefault()
          handoffFocus.current = false
        }}>
        <DropdownMenu.Label className="agent-region-menu__context">
          <span>{name}</span>
          {sessionKind === 'agent' ? <><span>Executor: {executorLabel}</span><span>Session: {sessionId}</span></> : <span>Terminal: {sessionId}</span>}
          <span>Host: {executionHost.label}{executionHost.configured ? '' : executionHost.id ? ' · Not configured' : ''}</span>
          <span>Host ID: {executionHost.id ?? 'Unknown'}</span>
          <span>Directory: {executionHost.cwd || 'Unknown'}</span>
        </DropdownMenu.Label>
        {nativeSourceActions}
        {currentConversationActions}
        {onHistory || onTakeOver || onRefreshObservation || entries.length > 0 ? <DropdownMenu.Separator className="tab-context-menu__separator" /> : null}
        {onTakeOver && !readOnly && sessionKind === 'agent' ? <DropdownMenu.Item className="tab-context-menu__item" onSelect={() => {
          handoffFocus.current = true
          onTakeOver()
        }}>
          <ArrowRight size={14} /><span>Take over</span>
        </DropdownMenu.Item> : null}
        {onRefreshObservation ? <DropdownMenu.Item className="tab-context-menu__item" disabled={refreshing} onSelect={onRefreshObservation}>
          <RotateCcw size={14} /><span>{refreshing ? 'Refreshing observation…' : 'Refresh observation'}</span>
        </DropdownMenu.Item> : null}
        {onHistory ? <><DropdownMenu.Item className="tab-context-menu__item" onSelect={onHistory}>
          <History size={14} /><span>Conversation history</span>
        </DropdownMenu.Item>{entries.length > 0 ? <DropdownMenu.Separator className="tab-context-menu__separator" /> : null}</> : null}
        {entries.map((entry, index) => <RegionMenuEntryView key={index} entry={entry} index={index}
          Item={DropdownMenu.Item} Separator={DropdownMenu.Separator} />)}
      </DropdownMenu.Content></DropdownMenu.Portal>
    </DropdownMenu.Root>
  </header>
  return host ? <><div ref={home} className="agent-region-header-home" />{createPortal(header, host)}</> : header
}
