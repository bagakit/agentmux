import { useEffect, useMemo, useRef, useState } from 'react'
import type { LinkClickModifiers } from '@agentmux/client-ui'
import { resolveFocusLinkDestination } from '../../../shared/focus-preferences'
import { useAppStore } from '../store'
import { api } from './api'
import { mainFocusPresentation } from './focus-tab-projection'
import { createSessionProjectFileContextSelector, type SessionProjectFileContext } from './session-project-file-context'
import { spatialCatalog, spatialDestination } from './space-agent-control'
import { scratchTopicsForWorkspace } from './scratch-topic-snapshots'
import { fileTabId, initialWorkbenchRegionId } from './workbench-tabs'
import { terminalLinkModifierOpensSystemBrowser } from './terminal-link-gesture'
import { isMacPlatform } from './host-platform'
import type { FileOpenResult } from './file-workbench-state'
import type { OpenDestination, OpenHttpLinkOrigin } from './open-destination'
import type { OpenDestinationRequest } from '../components/OpenDestinationBar'
import { useWorkbenchBrowserPresentation, type WorkbenchPresentation } from './workbench-presentation'

type FileLocation = { line: number; column?: number }
type LinkRequest = OpenDestinationRequest & { origin: OpenHttpLinkOrigin; presentation: Pick<WorkbenchPresentation, 'surface' | 'onSelectRegion'>; file?: { context: SessionProjectFileContext; location?: FileLocation } }

export function sessionFileRegionAvailable(origin: OpenHttpLinkOrigin, context: SessionProjectFileContext): boolean {
  const state = useAppStore.getState(), tab = origin.tabId ? state.tabs[origin.tabId] : undefined
  const resource = state.config?.workspaces.find(workspace => workspace.id === tab?.workspaceId)
  return Boolean(origin.tabGroupId && origin.regionId && tab?.regions[origin.regionId] && context.placement && resource &&
    resource.hostId === context.placement.resource.hostId && resource.path === context.placement.resource.path &&
    (!tab?.space || tab.space.zoneId === context.placement.space.zoneId && tab.space.spaceId === context.placement.space.spaceId))
}

/** Human link navigation consumes the original File owner and the exact Focus/Space address. */
export async function openSessionFileLink(origin: OpenHttpLinkOrigin, context: SessionProjectFileContext,
  path: string, location: FileLocation | undefined, destination: OpenDestination, surface?: WorkbenchPresentation['surface']): Promise<void> {
  const state = useAppStore.getState()
  const placement = context.placement
  if (!placement || context.kind === 'unconfirmed' || context.kind === 'unassigned') throw new Error(context.issue ?? 'The original file resource is unconfirmed. The Agent keeps running.')
  const workspace = state.config?.workspaces.find(item => item.hostId === placement.resource.hostId && item.path === placement.resource.path)
  if (!workspace) throw new Error('The original file Workspace is unavailable. The Agent keeps running.')
  if (destination === 'system') { await api.files.openSystem(workspace.id, path); return }
  const topics = scratchTopicsForWorkspace(state.scratchTopicSnapshots, workspace) ?? []
  const catalog = spatialCatalog(state, topics)
  let actual: FileOpenResult | undefined
  const receipt = (result: FileOpenResult) => { actual = result }
  if (destination === 'tab') {
    const tabId = fileTabId(workspace.id, path), regionId = initialWorkbenchRegionId(tabId)
    const target = spatialDestination(catalog, { zoneId: placement.space.zoneId, spaceId: placement.space.spaceId, newTab: true }, { tabId, regionId }, state.layouts).address
    await state.openFile(path, target.groupId, location, workspace.id, undefined, { ...placement,
      displayWorkspaceId: target.displayWorkspaceId, focus: true,
      selection: { workspaceId: target.displayWorkspaceId, spaceId: target.spaceId, zoneId: placement.space.zoneId,
        groupId: target.groupId, tabId, regionId, topicId: catalog.spaces.find(space => space.spaceId === target.spaceId)?.topicId ?? null }, onResult: receipt })
  } else {
    if (!sessionFileRegionAvailable(origin, context)) throw new Error('This file belongs to another resource or Zone. Choose Tab to view it in Space; the Agent is kept.')
    const expected = state.workbenchSpaceSelection
    const mainFocus = state.mainSurface === 'agents' && surface !== 'mote'
    const focus = mainFocus && expected?.workspaceId === origin.workspaceId && expected.groupId === origin.tabGroupId && expected.tabId === origin.tabId && expected.regionId === origin.regionId
    if (mainFocus && !focus) throw new Error('The selected Focus Region changed. Choose its original work surface explicitly; the Agent is kept.')
    const projection = focus ? mainFocusPresentation(expected, state.tabs, catalog,
      reference => useAppStore.getState().selectMainRegion(reference, expected)).projection : null
    if (focus && (!projection || projection.selection[0]?.tabId !== origin.tabId || projection.selection[0]?.groupId !== origin.tabGroupId ||
      projection.selection[0]?.displayWorkspaceId !== origin.workspaceId)) throw new Error('The selected Focus occurrence changed. Choose the original work surface explicitly.')
    await state.openFile(path, origin.tabGroupId, location, workspace.id, undefined, { ...placement,
      split: { tabId: origin.tabId!, regionId: origin.regionId!, direction: destination },
      ...(projection ? { projection } : { focus: true, selection: { workspaceId: origin.workspaceId,
        spaceId: placement.space.spaceId, zoneId: placement.space.zoneId, groupId: origin.tabGroupId!,
        tabId: origin.tabId!, regionId: origin.regionId!, topicId: null } }), onResult: receipt })
  }
  if (!actual || actual.data.kind === 'failed' || actual.data.kind === 'not-file' || actual.placement.status === 'unconfirmed' || actual.placement.status === 'none') {
    throw new Error(actual?.data.reason ?? 'The file or its exact original placement could not be confirmed. The Agent is kept.')
  }
  if (actual.navigation === 'cancelled' || actual.navigation === 'unconfirmed') throw new Error('The file is kept. A later selection owns the current display; open it again when ready.')
}

/** One bounded chooser for Terminal and conversation links; explicit destinations beat defaults. */
export function useSessionLinkOpening(origin: OpenHttpLinkOrigin, onService?: (message: string) => void, selectRegion?: () => void, target?: Pick<WorkbenchPresentation, 'surface' | 'onSelectRegion'>) {
  const primaryPresentation = useWorkbenchBrowserPresentation()
  const presentation = target ?? primaryPresentation, { surface } = presentation
  const selector = useMemo(() => createSessionProjectFileContextSelector(origin.sessionId ?? '', origin),
    [origin.workspaceId, origin.tabGroupId, origin.tabId, origin.regionId, origin.sessionId])
  const context = useAppStore(selector)
  const [request, setRequest] = useState<LinkRequest | null>(null)
  const next = useRef(0)
  useEffect(() => { setRequest(null) }, [context, surface])
  const failure = (error: unknown) => {
    const message = error instanceof Error ? error.message : String(error)
    if (onService) onService(message); else useAppStore.getState().reportError(error)
  }
  const activateHttp = (url: string, event: LinkClickModifiers) => {
    selectRegion?.()
    const state = useAppStore.getState()
    if (terminalLinkModifierOpensSystemBrowser(event, isMacPlatform())) void state.openHttpLink(origin, url, 'system', presentation).catch(failure)
    else if (state.mainSurface === 'agents' && !event.altKey) void state.openHttpLink(origin, url,
      resolveFocusLinkDestination(state.config?.focus?.linkDestination) === 'region' ? 'right' : 'tab', presentation).catch(failure)
    else setRequest({ id: ++next.current, origin, presentation, url, x: event.clientX, y: event.clientY })
  }
  const activateFile = (path: string, location?: FileLocation, event?: LinkClickModifiers) => {
    selectRegion?.()
    if (selector(useAppStore.getState()) !== context) { failure(new Error('The rendered file resource or occurrence changed. The Agent is kept.')); return }
    const state = useAppStore.getState()
    if (event && terminalLinkModifierOpensSystemBrowser(event, isMacPlatform())) {
      void openSessionFileLink(origin, context, path, location, 'system', surface).catch(failure)
      return
    }
    const destination = resolveFocusLinkDestination(state.config?.focus?.linkDestination) === 'region' ? 'right' : 'tab'
    if (event?.altKey || state.mainSurface === 'agents' && destination === 'right' && !sessionFileRegionAvailable(origin, context)) {
      if (!sessionFileRegionAvailable(origin, context)) onService?.('Region is unavailable for this resource. Choose Tab to view it in Space.')
      setRequest({ id: ++next.current, origin, presentation, url: path, x: event?.clientX ?? 0, y: event?.clientY ?? 0,
        file: { context, ...(location ? { location } : {}) } })
    } else if (state.mainSurface === 'agents') void openSessionFileLink(origin, context, path, location, destination, surface).catch(failure)
    else void state.openFile(path, origin.tabGroupId, location, context.project?.workspaceId ?? origin.workspaceId, undefined, context.placement).catch(failure)
  }
  return { activateHttp, activateFile, request,
    canSplit: request?.file ? sessionFileRegionAvailable(origin, request.file.context) : Boolean(origin.tabId && origin.regionId),
    dismiss: (id: number) => setRequest(current => current?.id === id ? null : current),
    choose: (destination: OpenDestination) => {
      if (!request) return
      const current = request
      setRequest(null)
      selectRegion?.()
      if (current.file) void openSessionFileLink(current.origin, current.file.context, current.url, current.file.location, destination, current.presentation.surface).catch(failure)
      else void useAppStore.getState().openHttpLink(current.origin, current.url, destination, current.presentation).catch(failure)
    }
  }
}
