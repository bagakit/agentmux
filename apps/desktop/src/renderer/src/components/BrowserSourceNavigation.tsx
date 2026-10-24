import { useEffect, useState } from 'react'
import type { AgentMuxBrowserSource } from '@agentmux/core'
import { regionIds } from '@agentmux/layout'
import { semanticIconComponent } from '@agentmux/client-ui/icons'
import { useAppStore } from '../store'
import { resolveBrowserSource } from '../lib/browser-child-projection'
import { workbenchTabDisplayName } from '../lib/workbench-tab-presentation'
import type { WorkbenchProjectionSelection } from '../lib/workbench-projection'
import { focusWorkbenchWindow } from '../lib/workbench-windows'
import { workbenchDocumentIdentity, workbenchWindowPlacement } from '../lib/workbench-window-registry'
import * as DropdownMenu from './HoverDropdownMenu'

const SourceIcon = semanticIconComponent('object.display')

/** The same control stays with BrowserPane when its original host moves between windows. */
export function BrowserSourceNavigation({ source, onOpenChange }: { source: AgentMuxBrowserSource; onOpenChange?(open: boolean): void }) {
  const tabs = useAppStore(state => state.tabs), layouts = useAppStore(state => state.layouts)
  const [expanded, setExpanded] = useState(false), [notice, setNotice] = useState<string | null>(null)
  const resolution = resolveBrowserSource({ tabs, layouts }, source)
  const change = (open: boolean) => { setExpanded(open); onOpenChange?.(open) }
  useEffect(() => {
    if (resolution.status === 'available' && !notice && expanded) { setExpanded(false); onOpenChange?.(false) }
  }, [resolution.status, notice, expanded, onOpenChange])
  useEffect(() => () => onOpenChange?.(false), [onOpenChange])
  const label = (location: WorkbenchProjectionSelection) => {
    const tab = tabs[location.tabId], state = useAppStore.getState()
    const ordinal = tab ? regionIds(tab.layout.root).indexOf(location.regionId) + 1 : 0
    const name = tab ? workbenchTabDisplayName(tab, state.sessions, state.agentNames, state.timelines, state.sessionNameMetadata) : 'Tab'
    return `${name} · Region ${ordinal || '?'}`
  }
  async function navigate(location: WorkbenchProjectionSelection) {
    const current = useAppStore.getState(), observed = resolveBrowserSource(current, source)
    const locations = observed.status === 'available' ? [observed.location] : observed.locations
    if (!locations.some(candidate => candidate.displayWorkspaceId === location.displayWorkspaceId && candidate.groupId === location.groupId &&
      candidate.tabId === location.tabId && candidate.regionId === location.regionId)) {
      setNotice('The source display changed. Choose its current location again.'); change(true); return
    }
    current.focusRegion(location.displayWorkspaceId, location.tabId, location.regionId, 'navigation', location.groupId)
    const placement = workbenchWindowPlacement({ kind: 'region', ...location }) ?? workbenchWindowPlacement({ kind: 'tab',
      displayWorkspaceId: location.displayWorkspaceId, groupId: location.groupId, tabId: location.tabId })
    const identity = placement?.window ?? workbenchDocumentIdentity(document)
    if (!identity || !await focusWorkbenchWindow(identity)) {
      setNotice('The source location is selected. Its native window focus is unconfirmed; use that original window.'); change(true); return
    }
    change(false); setNotice(null)
  }
  const trigger = <button type="button" className="browser-source-navigation__trigger" aria-label="Go to source Browser"
      title={resolution.status === 'available' ? `Opened from ${label(resolution.location)}` : resolution.status === 'ambiguous' ? 'Choose the original Browser display' : 'The original Browser display is unavailable'}
      onClick={resolution.status === 'available' && !notice ? () => void navigate(resolution.location) : undefined}>
      <SourceIcon size={13} /><span>Source</span>
    </button>
  if (resolution.status === 'available' && !notice) return <span className="browser-source-navigation">{trigger}</span>
  return <span className="browser-source-navigation"><DropdownMenu.Root modal={false} open={expanded} onOpenChange={change}>
    <DropdownMenu.Trigger asChild>{trigger}</DropdownMenu.Trigger>
    <DropdownMenu.Portal><DropdownMenu.Content className="browser-menu browser-source-navigation__menu" align="start" sideOffset={5} collisionPadding={8}>
      <DropdownMenu.Label className="browser-menu__label">{notice ?? (resolution.status === 'ambiguous' ? 'This source has several displays. Choose one:' : 'The source page no longer has an available display. This page remains open.')}</DropdownMenu.Label>
      {resolution.status === 'ambiguous' ? resolution.locations.map(location => <DropdownMenu.Item className="browser-menu__item" key={JSON.stringify(location)}
        onSelect={() => void navigate(location)}>{label(location)}</DropdownMenu.Item>) : null}
      <DropdownMenu.Item className="browser-menu__item" onSelect={() => { change(false); setNotice(null) }}>Dismiss</DropdownMenu.Item>
    </DropdownMenu.Content></DropdownMenu.Portal>
  </DropdownMenu.Root></span>
}
