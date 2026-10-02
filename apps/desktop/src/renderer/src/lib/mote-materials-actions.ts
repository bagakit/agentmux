import { useCallback, useEffect, useRef } from 'react'
import { groupIds } from '@agentmux/layout'
import { directoryIdentity, homeZoneId } from '../../../shared/space-addresses'
import { fileNavigationSelection, useAppStore } from '../store'
import { fileTabId } from './workbench-tabs'
import { fileExplorerContains } from './file-explorer-scope'
import { spatialCatalog } from './space-agent-control'
import { sameWorkbenchProjectionSelection, type WorkbenchProjectionSelection } from './workbench-projection'
import type { MoteWorkfaceScope } from './mote-workface'
import { scratchTopicIdentityPath, scratchTopicLogicalPath, scratchWorkspaceFilePath } from '../../../shared/scratch-topics'
import { scratchTopicsForWorkspace } from './scratch-topic-snapshots'
import { readPmoTeamsTopicFloatingState, requestPmoTeamsTopicFloatingClose, subscribePmoTeamsTopicFloatingState } from './pmo-teams-topic-floating'

function floatingSelection(): string {
  const current = readPmoTeamsTopicFloatingState()
  const reference = current?.reference
  return JSON.stringify([current?.open, current?.preview, current?.targetTopicId, current?.targetTabId,
    reference === null, reference?.displayWorkspaceId, reference?.groupId, reference?.tabId, reference?.regionId])
}

function confirmedMoteReference(state: ReturnType<typeof useAppStore.getState>, owner: MoteWorkfaceScope,
  options: { floating?: boolean | undefined; reference?: WorkbenchProjectionSelection | null | undefined }): WorkbenchProjectionSelection | null {
  const workspace = state.config?.workspaces.find(item => item.id === owner.workspace.id)
  if (workspace?.hostId !== owner.workspace.hostId || workspace.path !== owner.workspace.path ||
    scratchTopicLogicalPath(owner.workspace, owner.topic) !== owner.rootPath) return null
  let reference = options.reference
  if (reference === null) return null
  if (!reference) {
    // A floating caller owns its own selection; the background Space cannot supply it.
    if (options.floating) return null
    const choice = state.workbenchSpaceSelection
    if (choice) {
      if (!choice.groupId || !choice.tabId || !choice.regionId) return null
      reference = { displayWorkspaceId: choice.workspaceId, groupId: choice.groupId, tabId: choice.tabId, regionId: choice.regionId }
    } else {
      const displayWorkspaceId = state.activeWorkspaceId
      const layout = displayWorkspaceId ? state.layouts[displayWorkspaceId] : undefined
      const group = layout?.groups.find(item => item.id === layout.activeGroupId)
      const tab = group?.activeTabId ? state.tabs[group.activeTabId] : undefined
      if (!displayWorkspaceId || !group || !tab) return null
      reference = { displayWorkspaceId, groupId: group.id, tabId: tab.id, regionId: tab.layout.activeRegionId }
    }
  }
  const topics = scratchTopicsForWorkspace(state.scratchTopicSnapshots, owner.workspace) ?? [owner.topic]
  const catalog = spatialCatalog(state, topics)
  const spaceId = directoryIdentity(owner.workspace.hostId, scratchTopicIdentityPath(owner.workspace, owner.topic))
  return catalog.locations.some(location => location.workspaceId === owner.workspace.id && location.spaceId === spaceId &&
    sameWorkbenchProjectionSelection(location, reference!)) ? reference : null
}

function sameOwner(current: MoteWorkfaceScope | null, owner: MoteWorkfaceScope): boolean {
  return current?.topic.id === owner.topic.id && current.topic.directoryPath === owner.topic.directoryPath &&
    current.rootPath === owner.rootPath && current.workspace.id === owner.workspace.id &&
    current.workspace.hostId === owner.workspace.hostId && current.workspace.path === owner.workspace.path
}

type FileDestination = Pick<WorkbenchProjectionSelection, 'displayWorkspaceId' | 'groupId'>

/** A user's new File/Terminal action in a confirmed empty Mote needs a Group,
 * not a made-up discussion. Saved unknown entities never use this route. */
function confirmedMoteDestination(state: ReturnType<typeof useAppStore.getState>, owner: MoteWorkfaceScope,
  destination: FileDestination, requireEmpty: boolean): FileDestination | null {
  const workspace = state.config?.workspaces.find(item => item.id === owner.workspace.id)
  const layout = state.layouts[destination.displayWorkspaceId]
  if (workspace?.hostId !== owner.workspace.hostId || workspace.path !== owner.workspace.path ||
    scratchTopicLogicalPath(owner.workspace, owner.topic) !== owner.rootPath || !layout ||
    !groupIds(layout.root).includes(destination.groupId) || !layout.groups.some(group => group.id === destination.groupId)) return null
  const catalog = spatialCatalog(state, scratchTopicsForWorkspace(state.scratchTopicSnapshots, owner.workspace) ?? [owner.topic])
  const spaceId = directoryIdentity(owner.workspace.hostId, scratchTopicIdentityPath(owner.workspace, owner.topic))
  const zones = new Set(catalog.bindings.filter(binding => binding.spaceId === spaceId && catalog.zones.some(zone =>
    zone.zoneId === binding.zoneId && zone.kind !== 'unknown' && zone.workspaceId === owner.workspace.id &&
    zone.hostId === owner.workspace.hostId)).map(binding => binding.zoneId))
  if (!zones.size || requireEmpty && (catalog.tabs.some(tab => tab.workspaceId === owner.workspace.id && tab.zoneId && zones.has(tab.zoneId)) ||
    Object.values(state.tabs).some(tab => tab.workspaceId === owner.workspace.id &&
      (tab.topicId === owner.topic.id || tab.space?.spaceId === spaceId)))) return null
  return destination
}

function emptyMoteDestination(state: ReturnType<typeof useAppStore.getState>, owner: MoteWorkfaceScope, options: {
  floating?: boolean | undefined; reference?: WorkbenchProjectionSelection | null | undefined; destination?: FileDestination | null | undefined
}): FileDestination | null {
  if (options.reference) return null
  let destination = options.destination
  if (options.floating) {
    const floating = readPmoTeamsTopicFloatingState()
    if (floating?.targetTopicId !== owner.topic.id || floating.targetTabId !== null) return null
  } else {
    const choice = state.workbenchSpaceSelection
    if (choice?.tabId || choice?.regionId) return null
    if (destination === undefined && choice && state.mainSurface === 'workbench' && state.activeWorkspaceId === choice.workspaceId) {
      const spaceId = directoryIdentity(owner.workspace.hostId, scratchTopicIdentityPath(owner.workspace, owner.topic))
      const catalog = spatialCatalog(state, scratchTopicsForWorkspace(state.scratchTopicSnapshots, owner.workspace) ?? [owner.topic])
      if (choice.spaceId !== spaceId || !catalog.bindings.some(binding => binding.spaceId === spaceId && binding.zoneId === choice.zoneId)) return null
      // A new File/Terminal action uses the active Pane of this actual empty Space.
      // This is not an address for any saved or unconfirmed discussion.
      const groupId = choice.groupId ?? state.layouts[choice.workspaceId]?.activeGroupId
      if (groupId) destination = { displayWorkspaceId: choice.workspaceId, groupId }
    }
  }
  return destination ? confirmedMoteDestination(state, owner, destination, true) : null
}

/** Materials use the original File/launcher owners, never the background Project. */
export function useMoteMaterialsActions(scope: MoteWorkfaceScope | null, options: {
  floating?: boolean | undefined
  onTabSelect?: ((tabId: string) => void) | undefined
  onReferenceSelect?: ((reference: WorkbenchProjectionSelection) => void) | undefined
  onOpened?: (() => void) | undefined
  reference?: WorkbenchProjectionSelection | null | undefined
  destination?: FileDestination | null | undefined
} = {}) {
  const latest = useRef({ scope, options }); latest.current = { scope, options }
  const pending = useRef<(() => void) | null>(null)
  useEffect(() => () => pending.current?.(), [scope?.topic.id, scope?.topic.directoryPath, scope?.rootPath,
    scope?.workspace.id, scope?.workspace.hostId, scope?.workspace.path, options.reference?.displayWorkspaceId,
    options.reference?.groupId, options.reference?.tabId, options.reference?.regionId,
    options.destination?.displayWorkspaceId, options.destination?.groupId])
  const open = useCallback(async (path: string) => {
    const captured = latest.current, owner = captured.scope
    pending.current?.()
    if (!owner) return
    const state = useAppStore.getState(), workspaceId = owner.workspace.id
    const reference = captured.options.destination !== undefined && !captured.options.reference ? null : confirmedMoteReference(state, owner, captured.options)
    const destination = reference ?? emptyMoteDestination(state, owner, captured.options)
    if (!destination) { state.reportError(new Error('The exact original Mote display is unconfirmed. Your work is kept; choose its Tab and Region, or an exact empty destination, then retry opening the file.')); return }
    const { displayWorkspaceId, groupId } = destination
    const tabId = fileTabId(workspaceId, path)
    const existing = state.tabs[tabId]
    const topic = scratchTopicsForWorkspace(state.scratchTopicSnapshots, owner.workspace)?.find(item => {
      const root = scratchTopicLogicalPath(owner.workspace, item)
      return root !== null && fileExplorerContains(root, path)
    })
    const topicId = existing ? existing.topicId : topic?.id ?? (fileExplorerContains(owner.rootPath, path) ? owner.topic.id : undefined)
    const identityTopic = topic ?? (topicId === owner.topic.id ? owner.topic : undefined)
    const spaceId = directoryIdentity(owner.workspace.hostId, identityTopic ? scratchTopicIdentityPath(owner.workspace, identityTopic) : owner.workspace.path)
    const space = existing?.space ?? { spaceId, zoneId: homeZoneId(spaceId) }
    const fileRegions = existing ? Object.values(existing.regions).filter(region => region.kind === 'file' &&
      region.workspaceId === workspaceId && region.path === path) : []
    const heldFileRegion = existing?.id === reference?.tabId ? fileRegions.find(region => region.regionId === reference?.regionId) : undefined
    if (existing && !heldFileRegion && fileRegions.length !== 1) {
      state.reportError(new Error('The original File Region is unconfirmed or ambiguous. Its content is kept; choose the exact File Region and retry.')); return
    }
    const regionId = heldFileRegion?.regionId ?? fileRegions[0]?.regionId ?? 'region:' + tabId
    const fileReference = { displayWorkspaceId, groupId, tabId, regionId }
    const catalog = spatialCatalog(state, scratchTopicsForWorkspace(state.scratchTopicSnapshots, owner.workspace) ?? [owner.topic])
    const alreadyPlaced = catalog.locations.some(location => sameWorkbenchProjectionSelection(location, fileReference))
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
    let opened = false, openedReference: WorkbenchProjectionSelection | null = null
    // A retained File keeps its entity/Space. The File owner adds or reuses only
    // the requested occurrence, including legacy Tabs without a stored Space.
    try { await state.openFile(path, groupId, undefined, workspaceId, true, {
      displayWorkspaceId, space,
      resource: { hostId: owner.workspace.hostId, path: owner.workspace.path }, focus: false,
      ...(existing?.space && alreadyPlaced ? { reference: fileReference } : {}),
      selection: { ...space, workspaceId: displayWorkspaceId, groupId, tabId, regionId, topicId: topicId ?? null },
      onResult: result => {
        opened = result.placement.status === 'created' || result.placement.status === 'reused'
        if (opened && result.placement.tabId && result.placement.regionId) openedReference = {
          displayWorkspaceId, groupId, tabId: result.placement.tabId, regionId: result.placement.regionId }
      }
    }, controller.signal) } finally { release() }
    const currentOwner = latest.current.scope
    if (controller.signal.aborted || !opened || !sameOwner(currentOwner, owner) || captured.options.reference &&
      !sameWorkbenchProjectionSelection(latest.current.options.reference ?? null, captured.options.reference)) return
    if (reference ? !confirmedMoteReference(useAppStore.getState(), owner, { ...captured.options, reference }) :
      !confirmedMoteDestination(useAppStore.getState(), owner, destination, false)) {
      useAppStore.getState().reportError(new Error('The original Mote display changed while the file was opening. Its data and your work are kept; choose the exact Tab and Region, then retry.')); return
    }
    if (captured.options.floating && topicId === owner.topic.id && (captured.options.onReferenceSelect || captured.options.onTabSelect)) {
      if (captured.options.onReferenceSelect) {
        if (!openedReference) { useAppStore.getState().reportError(new Error('The original File placement is unconfirmed. Its content and your work are kept; inspect the exact File Region and retry.')); return }
        captured.options.onReferenceSelect(openedReference)
      } else captured.options.onTabSelect?.(tabId)
    }
    else {
      const current = useAppStore.getState()
      current.focusRegion(displayWorkspaceId, tabId, regionId, 'pointer', groupId)
      useAppStore.setState({ activeWorkspaceId: displayWorkspaceId, mainSurface: 'workbench',
        workbenchSpaceSelection: { ...space, workspaceId: displayWorkspaceId, groupId, tabId, regionId, topicId: topicId ?? null } })
      if (captured.options.floating) requestPmoTeamsTopicFloatingClose({ restoreFocus: false })
    }
    captured.options.onOpened?.()
  }, [])
  const terminal = useCallback(async (path: string) => {
    const captured = latest.current, owner = captured.scope
    pending.current?.()
    if (!owner) return
    const state = useAppStore.getState(), workspaceId = owner.workspace.id
    const reference = captured.options.destination !== undefined && !captured.options.reference ? null : confirmedMoteReference(state, owner, captured.options)
    const destination = reference ?? emptyMoteDestination(state, owner, captured.options)
    if (!destination) { state.reportError(new Error('The exact original Mote display is unconfirmed. Your work is kept; choose its Tab and Region, or an exact empty destination, then retry opening the terminal.')); return }
    const { displayWorkspaceId, groupId } = destination
    const physicalPath = scratchWorkspaceFilePath(owner.workspace, scratchTopicsForWorkspace(state.scratchTopicSnapshots, owner.workspace), path)
    if (!physicalPath) { state.reportError(new Error('The original directory read is not confirmed. Refresh materials and retry opening its terminal.')); return }
    const inMote = fileExplorerContains(owner.rootPath, path)
    const topic = scratchTopicsForWorkspace(state.scratchTopicSnapshots, owner.workspace)?.find(item => {
      const root = scratchTopicLogicalPath(owner.workspace, item)
      return root !== null && fileExplorerContains(root, path)
    }) ?? (inMote ? owner.topic : undefined)
    const spaceId = directoryIdentity(owner.workspace.hostId, topic ? scratchTopicIdentityPath(owner.workspace, topic) : owner.workspace.path)
    const tabId = state.openLauncher({ workspaceId, displayWorkspaceId, tabGroupId: groupId, zoneId: homeZoneId(spaceId), reveal: false })
    const tab = tabId ? useAppStore.getState().tabs[tabId] : undefined
    if (!tab) return
    if (captured.options.floating && inMote && (captured.options.onReferenceSelect || captured.options.onTabSelect)) {
      if (captured.options.onReferenceSelect) captured.options.onReferenceSelect({ displayWorkspaceId, groupId, tabId: tab.id, regionId: tab.layout.activeRegionId })
      else captured.options.onTabSelect?.(tab.id)
    }
    else {
      state.activateTab(displayWorkspaceId, groupId, tab.id)
      if (captured.options.floating) requestPmoTeamsTopicFloatingClose({ restoreFocus: false })
    }
    captured.options.onOpened?.()
    await useAppStore.getState().launchTerminal(groupId, { tabId: tab.id, regionId: tab.layout.activeRegionId }, physicalPath)
  }, [])
  return { open, terminal }
}
