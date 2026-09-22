import { History, MoreHorizontal, PanelsTopLeft, RotateCcw } from 'lucide-react'
import { useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import * as DropdownMenu from './HoverDropdownMenu'
import { RegionMenuEntryView, useRegionMenuEntries } from './RegionContextMenu'

/** SessionPane owns identity/reading; layout and address actions arrive already bound to the Region. */
export function AgentRegionHeader({ name, executorLabel, sessionId, regionId, readOnly, onHistory, onRefreshObservation, refreshing = false, portalTargetId = null }: {
  name: string
  executorLabel: string
  sessionId: string
  regionId: string | undefined
  readOnly: boolean
  onHistory: (() => void) | undefined
  onRefreshObservation?: (() => void) | undefined
  refreshing?: boolean
  /** One precise owner may present its existing controls in the Focus bar. */
  portalTargetId?: string | null
}) {
  const entries = useRegionMenuEntries()
  const home = useRef<HTMLDivElement>(null)
  const [host] = useState(() => {
    // Static SessionPane presentation has no DOM host to move.
    if (typeof document === 'undefined') return null
    const element = document.createElement('div')
    element.className = 'agent-region-header-host'
    return element
  })
  const [merged, setMerged] = useState(false)
  const targetId = readOnly ? null : portalTargetId
  useLayoutEffect(() => {
    if (!host) return
    const attach = () => {
      const target = targetId ? document.getElementById(targetId) : null
      const destination = target ?? home.current
      if (destination && host.parentElement !== destination) destination.append(host)
      setMerged(target !== null)
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
    aria-label={`Agent ${name}; ${readOnly ? 'Read-only; ' : ''}${executorLabel}; Session ${sessionId}`}>
    {merged ? null : <strong className="agent-region-header__name" title={name}>{name}</strong>}
    {readOnly ? <span className="agent-region-header__mode">Read-only</span> : null}
    {onHistory || onRefreshObservation || entries.length > 0 ? <DropdownMenu.Root>
      <DropdownMenu.Trigger className="agent-region-header__more"
        aria-label={`More actions for ${name}`} title={`${merged ? 'Region actions · ' : ''}${name}; ${executorLabel}; Session ${sessionId}`}
        onPointerDown={(event) => event.stopPropagation()}>
        {merged ? <PanelsTopLeft size={14} /> : <MoreHorizontal size={14} />}
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal><DropdownMenu.Content className="tab-context-menu agent-region-menu"
        data-owner-region-id={regionId} data-agent-session-id={sessionId} side="bottom" align="end" sideOffset={4} collisionPadding={8}
        onPointerDown={(event) => event.stopPropagation()}>
        <DropdownMenu.Label className="agent-region-menu__context">
          <span>{name}</span><span>Executor: {executorLabel}</span><span>Session: {sessionId}</span>
        </DropdownMenu.Label>
        <DropdownMenu.Separator className="tab-context-menu__separator" />
        {onRefreshObservation ? <DropdownMenu.Item className="tab-context-menu__item" disabled={refreshing} onSelect={onRefreshObservation}>
          <RotateCcw size={14} /><span>{refreshing ? 'Refreshing observation…' : 'Refresh observation'}</span>
        </DropdownMenu.Item> : null}
        {onHistory ? <><DropdownMenu.Item className="tab-context-menu__item" onSelect={onHistory}>
          <History size={14} /><span>Conversation history</span>
        </DropdownMenu.Item>{entries.length > 0 ? <DropdownMenu.Separator className="tab-context-menu__separator" /> : null}</> : null}
        {entries.map((entry, index) => <RegionMenuEntryView key={index} entry={entry} index={index}
          Item={DropdownMenu.Item} Separator={DropdownMenu.Separator} />)}
      </DropdownMenu.Content></DropdownMenu.Portal>
    </DropdownMenu.Root> : null}
  </header>
  return host ? <><div ref={home} className="agent-region-header-home" />{createPortal(header, host)}</> : header
}
