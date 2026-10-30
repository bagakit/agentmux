import * as ContextMenu from '@radix-ui/react-context-menu'
import { regionIds } from '@agentmux/layout'
import { semanticIconComponent } from '@agentmux/client-ui/icons'
import type { AgentMenuTarget } from '../lib/agent-menu-target'
import { requireFocusAgentMenuLocation } from '../lib/focus-agent-menu-location'
import type { WorkbenchProjectionSelection } from '../lib/workbench-projection'
import { regionSwapMenuEntries, workbenchSplitMenuEntries } from '../lib/workbench-tab-actions'
import { useWorkbenchRegionLabels } from '../lib/workbench-session-subscriptions'
import type { WorkbenchTab } from '../lib/workbench-tabs'
import { openWorkbenchWindow } from '../lib/workbench-windows'
import { copyTextToClipboard } from '../lib/clipboard-copy'
import { useAppStore } from '../store'
import { createRegionCopyModel, RegionMenuEntryView, type RegionMenuEntry } from './RegionContextMenu'
import { WorkbenchMenuSubmenu } from './WorkbenchMenuSubmenu'

const RegionIcon = semanticIconComponent('object.region')

/** Only an open card mounts this consumer. All layout commands keep their existing owner. */
function ExactLocationMenu({ target, reference, includeLink }: {
  target: AgentMenuTarget; reference: WorkbenchProjectionSelection; includeLink: boolean
}) {
  const tab = useAppStore.getState().tabs[reference.tabId]
  if (!tab) return <ContextMenu.Label className="agent-region-menu__context" role="status">This work surface changed. Reopen the menu to choose its current location.</ContextMenu.Label>
  return <ConfirmedLocationMenu target={target} reference={reference} includeLink={includeLink} tab={tab} />
}

function ConfirmedLocationMenu({ target, reference, includeLink, tab }: {
  target: AgentMenuTarget; reference: WorkbenchProjectionSelection; includeLink: boolean; tab: WorkbenchTab
}) {
  const labels = useWorkbenchRegionLabels(tab)
  function dispatch(action: (state: ReturnType<typeof useAppStore.getState>) => unknown) {
    const state = useAppStore.getState()
    try { requireFocusAgentMenuLocation(state, target, reference); void Promise.resolve(action(state)).catch(error => state.reportError(error)) }
    catch (error) { state.reportError(error, { kind: 'indeterminate', ...(target.control ? { subject: target.control } : {}), summary: 'The original work and draft are kept. Reopen this Agent menu and choose its exact location.' }) }
  }
  const ids = regionIds(tab.layout.root)
  const model = createRegionCopyModel({ regionId: reference.regionId, agentSessionId: null,
    writeClipboardText: async text => { requireFocusAgentMenuLocation(useAppStore.getState(), target, reference); await copyTextToClipboard(text, error => useAppStore.getState().reportError(error)) },
    splitMenu: workbenchSplitMenuEntries({ regionCount: ids.length,
      split: direction => dispatch(state => state.splitRegion(tab.workspaceId, tab.id, reference.regionId, direction)),
      arrange: mode => dispatch(state => state.arrangeTabRegions(tab.workspaceId, tab.id, mode)) }),
    swapMenu: regionSwapMenuEntries({ regionId: reference.regionId, regions: ids.flatMap(regionId => tab.regions[regionId] ? [{ regionId, label: labels[regionId]! }] : []),
      swap: (a, b) => dispatch(state => state.swapRegions(tab.workspaceId, tab.id, a, b)) }),
    promote: ids.length > 1 ? () => dispatch(state => state.promoteRegionToTab(tab.workspaceId, tab.id, reference.regionId)) : undefined })
  const entries: RegionMenuEntry[] = [...model.entries.filter(entry => includeLink || entry.kind !== 'action').filter((entry, index, entries) => entry.kind !== 'separator' || index > 0 && entries[index - 1]?.kind !== 'separator'),
    { kind: 'window', onSelect: () => dispatch(() => openWorkbenchWindow({ kind: 'region', ...reference })) }]
  return <>{entries.map((entry, index) => <RegionMenuEntryView key={index} entry={entry} index={index}
    Item={ContextMenu.Item} Separator={ContextMenu.Separator} Group={ContextMenu.Group} Label={ContextMenu.Label} />)}</>
}

export function FocusAgentWorkspaceMenu({ target, references, issue }: {
  target: AgentMenuTarget; references: readonly WorkbenchProjectionSelection[]; issue: string | null
}) {
  if (references.length === 1) return <ExactLocationMenu target={target} reference={references[0]!} includeLink={false} />
  const state = useAppStore.getState()
  return <>{issue ? <ContextMenu.Label className="agent-region-menu__context" role="status">{references.length > 1 ? 'Choose the exact work surface for layout and Region actions.' : issue}</ContextMenu.Label> : null}
    {references.map(reference => {
      const tab = state.tabs[reference.tabId]
      const workspace = state.config?.workspaces.find(item => item.id === reference.displayWorkspaceId)
      const group = state.layouts[reference.displayWorkspaceId]?.groups.find(item => item.id === reference.groupId)
      return <WorkbenchMenuSubmenu key={JSON.stringify(reference)} label={`${workspace?.name ?? reference.displayWorkspaceId} · ${group?.id ?? reference.groupId} · ${tab?.name ?? reference.tabId} · ${reference.regionId}`} icon={<RegionIcon size={14} />}>
        <ExactLocationMenu target={target} reference={reference} includeLink />
      </WorkbenchMenuSubmenu>
    })}</>
}
