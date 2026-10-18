import type { NoteResource } from '@agentmux/core/notebook-catalog'
import { useCallback, useContext } from 'react'
import { NoteFileLinkContext } from '@agentmux/client-ui/components/NoteFileContext'
import { classifyMarkdownLinkHref, referenceRevealLocation } from '@agentmux/client-ui/markdown-file-reference'
import { parseHttpLinkUrl } from '@agentmux/client-ui/link-url'
import { api } from './api'
import { useAppStore } from '../store'
import { resolveWorkbenchOccurrenceSelection, workbenchSelectionCatalog } from './desktop-focus-navigation'
import { useWorkbenchBrowserPresentation, type WorkbenchPresentation } from './workbench-presentation'
import { zoneContext } from './space-agent-control'
import { scratchTopicsForWorkspace } from './scratch-topic-snapshots'
import { openNotebookAttachment } from './recall-notebooks'

export function useDesktopNoteLinkOpener() {
  const presentation = useWorkbenchBrowserPresentation()
  const inherited = useContext(NoteFileLinkContext)
  return useCallback((resource: NoteResource | null, href: string) =>
    !presentation.reference && inherited ? inherited(resource, href) : openDesktopNoteLink(resource, href, presentation), [presentation, inherited])
}

/** Opening a reference never adopts the display occurrence's Workspace. */
export async function openDesktopNoteLink(resource: NoteResource | null, href: string, presentation?: WorkbenchPresentation): Promise<boolean> {
  const url = parseHttpLinkUrl(href)
  if (url) { await api.ui.openExternal(url); return true }
  const target = resolveDesktopNoteFileLink(resource, href), state = useAppStore.getState()
  const occurrence = presentation?.reference
  if (occurrence) {
    const catalog = workbenchSelectionCatalog(state)
    const choice = resolveWorkbenchOccurrenceSelection(state, catalog, {
      workspaceId: occurrence.displayWorkspaceId, groupId: occurrence.groupId, tabId: occurrence.tabId, regionId: occurrence.regionId
    }, 'navigation')
    const zone = catalog.zones.find(item => item.zoneId === choice.zoneId)
    if (!zone) throw Error('The original Note display context is unconfirmed. Its attachment address is retained.')
    // An unbound Notebook Zone still has its original resource context.
    const spaceId = choice.spaceId ?? zoneContext(state, scratchTopicsForWorkspace(state.scratchTopicSnapshots,
      state.config?.workspaces.find(item => item.id === zone.workspaceId)) ?? [], zone)
    return openNotebookAttachment(target.resource, { workspaceId: zone.workspaceId, zoneId: zone.zoneId }, undefined, undefined, target.location, undefined,
      { reference: occurrence, space: { spaceId, zoneId: zone.zoneId }, ...(presentation.projection ? { projection: presentation.projection } : {}) })
  }
  return state.openFile(target.resource.path, undefined, target.location, target.resource.workspaceId)
}

export function resolveDesktopNoteFileLink(resource: NoteResource | null, href: string) {
  if (!resource) throw Error('The original Note file resource is unavailable. Its attachment reference is retained.')
  const state = useAppStore.getState(), workspace = state.config?.workspaces.find(item => item.id === resource.workspaceId)
  if (!workspace || workspace.hostId !== resource.hostId || workspace.path !== resource.workspacePath)
    throw Error('The original attachment Workspace changed. Restore that original resource before opening this reference.')
  const reference = classifyMarkdownLinkHref(href, resource.workspacePath, '', resource.path)
  if (!reference) throw Error('This attachment address cannot be resolved inside its original Workspace. Its source is retained.')
  return { resource: { ...resource, path: reference.path }, location: referenceRevealLocation(reference) }
}
