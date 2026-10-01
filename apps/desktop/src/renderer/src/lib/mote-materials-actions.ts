import { useCallback, useEffect, useRef } from 'react'
import { directoryIdentity, homeZoneId } from '../../../shared/space-addresses'
import { fileNavigationSelection, useAppStore } from '../store'
import { fileTabId } from './workbench-tabs'
import { fileExplorerContains, fileExplorerRelativeRoot } from './file-explorer-scope'
import type { MoteWorkfaceScope } from './mote-workface'
import { joinWorkspacePath } from './workspace-paths'
import { readPmoTeamsTopicFloatingState, requestPmoTeamsTopicFloatingClose, subscribePmoTeamsTopicFloatingState } from './pmo-teams-topic-floating'

function floatingSelection(): string {
  const current = readPmoTeamsTopicFloatingState()
  return JSON.stringify([current?.open, current?.preview, current?.targetTopicId, current?.targetTabId])
}

/** Materials use the original File/launcher owners, never the background Project. */
export function useMoteMaterialsActions(scope: MoteWorkfaceScope | null, options: {
  floating?: boolean | undefined
  onTabSelect?: ((tabId: string) => void) | undefined
  onOpened?: (() => void) | undefined
} = {}) {
  const latest = useRef({ scope, options }); latest.current = { scope, options }
  const pending = useRef<(() => void) | null>(null)
  useEffect(() => () => pending.current?.(), [])
  const open = useCallback(async (path: string) => {
    const captured = latest.current, owner = captured.scope
    if (!owner) return
    const state = useAppStore.getState(), workspaceId = owner.workspace.id
    const layout = state.layouts[workspaceId], tabId = fileTabId(workspaceId, path)
    const existing = state.tabs[tabId]
    const existingGroup = layout?.groups.find(group => group.tabOrder.includes(tabId))
    const group = existingGroup ?? layout?.groups.find(group => group.tabOrder.some(id => state.tabs[id]?.topicId === owner.topic.id)) ?? layout?.groups.find(group => group.id === layout.activeGroupId)
    if (!group) { state.reportError(new Error('The original file workface is still restoring.')); return }
    const topic = state.scratchTopicSnapshots[workspaceId]?.topics?.find(item => {
      const root = fileExplorerRelativeRoot(owner.workspace.path, item.directoryPath)
      return root !== null && fileExplorerContains(root, path)
    })
    const topicId = existing ? existing.topicId : topic?.id ?? (fileExplorerContains(owner.rootPath, path) ? owner.topic.id : undefined)
    const spaceId = directoryIdentity(owner.workspace.hostId, topic?.directoryPath ?? (topicId === owner.topic.id ? owner.topic.directoryPath : owner.workspace.path))
    const space = existing?.space ?? { spaceId, zoneId: homeZoneId(spaceId) }
    const regionId = existing?.layout.activeRegionId ?? 'region:' + tabId
    pending.current?.()
    const navigation = fileNavigationSelection(state), floating = floatingSelection()
    const controller = new AbortController()
    const unsubscribers: (() => void)[] = []
    const events = ['pointerdown', 'keydown', 'input', 'focusin'] as const
    const release = () => {
      for (const unsubscribe of unsubscribers) unsubscribe()
      for (const event of events) document.removeEventListener(event, cancel, true)
      if (pending.current === cancel) pending.current = null
    }
    const cancel = () => { controller.abort(); release() }
    pending.current = cancel
    // These listeners exist only during this cold file request. Latching records
    // A→B→A and later input, rather than comparing only the final selected Mote.
    unsubscribers.push(useAppStore.subscribe(current => {
      if (fileNavigationSelection(current) !== navigation) cancel()
    }), subscribePmoTeamsTopicFloatingState(() => {
      if (floatingSelection() !== floating) cancel()
    }))
    for (const event of events) document.addEventListener(event, cancel, true)
    let opened = false, revealed = false
    // Older original File Tabs without a Space remain in their existing placement.
    // Opening them through the normal File owner does not assign a new identity.
    try { revealed = await state.openFile(path, group.id, undefined, workspaceId, true, existing && !existing.space ? undefined : {
      displayWorkspaceId: workspaceId, space,
      resource: { hostId: owner.workspace.hostId, path: owner.workspace.path }, focus: false,
      ...(existing ? { reference: { displayWorkspaceId: workspaceId, groupId: group.id, tabId, regionId } } : {}),
      selection: { ...space, workspaceId, groupId: group.id, tabId, regionId, topicId: topicId ?? null },
      onResult: result => { opened = result.placement.status === 'created' || result.placement.status === 'reused' }
    }, controller.signal) } finally { release() }
    // The original foreground owner may commit its own navigation before this
    // await resumes. Its true verdict proves no earlier cancellation occurred.
    if (existing && !existing.space) opened = revealed
    const currentOwner = latest.current.scope
    if ((!revealed && controller.signal.aborted) || !opened || currentOwner?.topic.id !== owner.topic.id ||
      currentOwner.workspace.id !== workspaceId || currentOwner.topic.directoryPath !== owner.topic.directoryPath) return
    if (captured.options.floating && topicId === owner.topic.id && captured.options.onTabSelect) captured.options.onTabSelect(tabId)
    else {
      const current = useAppStore.getState()
      current.focusRegion(workspaceId, tabId, regionId, 'pointer', group.id)
      useAppStore.setState({ activeWorkspaceId: workspaceId, mainSurface: 'workbench',
        workbenchSpaceSelection: existing && !existing.space ? null : { ...space, workspaceId, groupId: group.id, tabId, regionId, topicId: topicId ?? null } })
      if (captured.options.floating) requestPmoTeamsTopicFloatingClose({ restoreFocus: false })
    }
    captured.options.onOpened?.()
  }, [])
  const terminal = useCallback(async (path: string) => {
    const captured = latest.current, owner = captured.scope
    if (!owner) return
    const state = useAppStore.getState(), workspaceId = owner.workspace.id, layout = state.layouts[workspaceId]
    if (!layout) { state.reportError(new Error('The original directory layout is still restoring.')); return }
    const inMote = fileExplorerContains(owner.rootPath, path)
    const group = inMote ? layout.groups.find(group => group.tabOrder.some(id => state.tabs[id]?.topicId === owner.topic.id)) ?? layout.groups.find(group => group.id === layout.activeGroupId) : layout.groups.find(group => group.id === layout.activeGroupId)
    if (!group) return
    const tabId = state.openLauncher({ workspaceId, tabGroupId: group.id, ...(inMote ? { topicId: owner.topic.id } : {}), reveal: false })
    const tab = tabId ? useAppStore.getState().tabs[tabId] : undefined
    if (!tab) return
    if (captured.options.floating && inMote && captured.options.onTabSelect) captured.options.onTabSelect(tab.id)
    else {
      state.activateTab(workspaceId, group.id, tab.id)
      if (captured.options.floating) requestPmoTeamsTopicFloatingClose({ restoreFocus: false })
    }
    captured.options.onOpened?.()
    await useAppStore.getState().launchTerminal(group.id, { tabId: tab.id, regionId: tab.layout.activeRegionId }, joinWorkspacePath(owner.workspace.path, path))
  }, [])
  return { open, terminal }
}
