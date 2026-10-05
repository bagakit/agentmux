import { lazy, Suspense, useEffect, useMemo } from 'react'
import { semanticIconComponent } from '@agentmux/client-ui/icons'
import { WORKSPACE_FILE_MAX_BYTES } from '../../../shared/workspace-file-bytes'
import { workspaceFileFormat } from '../../../shared/workspace-file-format'
import { documentKey, type FileWorkbenchSurface } from '../lib/workbench-tabs'
import { joinWorkspacePath } from '../lib/workspace-paths'
import { effectiveFileRegionMode } from '../lib/file-region-presentation'
import { fileNavigationSelection, useAppStore } from '../store'
import { resolveWorkbenchOccurrenceSelection, workbenchSelectionCatalog } from '../lib/desktop-focus-navigation'
import { useWorkbenchBrowserPresentation } from '../lib/workbench-presentation'
import * as DropdownMenu from './HoverDropdownMenu'
import { FilePreviewPane } from './FilePreviewPane'
import { FullPageLoadingSurface } from './FullPageLoadingSurface'
import { SourceFilePreview } from './file-preview/SourceFilePreview'
import { useWorkspaceResource } from '../hooks/useWorkspaceResource'
import { registerFileRegionBuilder, type FileBuildSource } from '../lib/file-formats/build-file-region'

const ThemeActionRevealIcon = semanticIconComponent('action.reveal')
const ThemeActionSaveIcon = semanticIconComponent('action.save')


const EditorPane = lazy(async () => ({ default: (await import('./EditorPane')).EditorPane }))
const NoteFileSurfaceView = lazy(async () => ({ default: (await import('./NoteFileSurfaceView')).NoteFileSurfaceView }))
/** One File identity with format-specific presentation, never a second editable document. */
export function FileSurfaceView({ tabId, surface, released = false, visible = true }: {
  tabId: string; surface: FileWorkbenchSurface; released?: boolean; visible?: boolean
}) {
  const presentation = useWorkbenchBrowserPresentation()
  const reference = presentation.reference?.tabId === tabId ? { ...presentation.reference, regionId: surface.regionId } : undefined
  const key = documentKey(surface.workspaceId, surface.path)
  const doc = useAppStore(state => state.documents[key])
  const binary = useAppStore(state => state.documentIssues[key]?.kind === 'binary')
  const dirty = useAppStore(state => Boolean(state.dirtyDocuments[key]))
  const saving = useAppStore(state => Boolean(state.savingDocuments[key]))
  const workspace = useWorkspaceResource(surface.workspaceId)
  const workspaceRoot = workspace?.path ?? ''
  const isLocal = workspace?.hostId === 'local'
  const reportError = useAppStore(state => state.reportError)
  const openFile = useAppStore(state => state.openFile)
  const noteReveal = useAppStore(state => state.documentRevealTargets[key]?.noteBlock)
  const format = workspaceFileFormat(surface.path)
  const markdown = format.sourcePreview === 'markdown'
  const svg = format.sourcePreview === 'svg'
  const html = format.browserPreview
  const note = format.sourcePreview === 'note'
  const regionMode = useAppStore(state => effectiveFileRegionMode(state.editorRegionModes, surface.regionId, surface.path, binary))
  const setRegionMode = useAppStore(state => state.setEditorRegionMode)
  const previewing = regionMode === 'preview'
  useEffect(() => {
    if (!visible || released) return
    const read = (): FileBuildSource | null => {
      const state = useAppStore.getState(), document = state.documents[key]
      const region = state.tabs[tabId]?.regions[surface.regionId]
      const resource = state.config?.workspaces.find(item => item.id === surface.workspaceId)
      if (!document || !resource || region?.kind !== 'file' || region.workspaceId !== surface.workspaceId || region.path !== surface.path) return null
      const kind = workspaceFileFormat(surface.path).sourcePreview
      return { workspaceId: surface.workspaceId, path: surface.path, content: document.content, model: document,
        generation: state.documentGenerations[key] ?? 0, region,
        kind: kind === 'latex' || kind === 'typst' ? kind : null, resource: { hostId: resource.hostId, path: resource.path } }
    }
    const isCurrent = (source: FileBuildSource) => {
      const now = read()
      return now !== null && now.model === source.model && now.region === source.region && now.content === source.content &&
        now.generation === source.generation && now.resource.hostId === source.resource.hostId && now.resource.path === source.resource.path
    }
    return registerFileRegionBuilder(surface.regionId, {
      snapshot: read, isCurrent,
      watch: (source, invalidate) => useAppStore.subscribe((next, previous) => {
        if (next.documents[key] !== previous.documents[key] || next.documentGenerations[key] !== previous.documentGenerations[key] ||
          next.tabs[tabId]?.regions[surface.regionId] !== previous.tabs[tabId]?.regions[surface.regionId] || next.config?.workspaces !== previous.config?.workspaces) {
          if (!isCurrent(source)) invalidate()
        }
      })
    })
  }, [key, tabId, surface.regionId, surface.workspaceId, surface.path, visible, released])
  useEffect(() => { if (note && noteReveal) void setRegionMode(surface.regionId, surface.workspaceId, surface.path, 'preview') },
    [note, noteReveal, setRegionMode, surface.regionId, surface.workspaceId, surface.path])
  const overBudget = useMemo(() => {
    if (!visible || released || !previewing || !doc || !format.sourcePreview) return false
    if (doc.content.length > WORKSPACE_FILE_MAX_BYTES) return true
    // UTF-8 needs at most three bytes per UTF-16 unit. Encode only up to the preview ceiling.
    const bytes = new Uint8Array(Math.min(WORKSPACE_FILE_MAX_BYTES + 1, doc.content.length * 3))
    const result = new TextEncoder().encodeInto(doc.content, bytes)
    return result.written > WORKSPACE_FILE_MAX_BYTES || result.read < doc.content.length
  }, [visible, released, previewing, doc?.content, format.sourcePreview])

  if (!format.sourceEditable || (!doc && binary)) {
    return <FilePreviewPane surface={surface} visible={visible && !released} onRetryBinary={() => { void useAppStore.getState().reloadDocument(tabId, surface.regionId) }} />
  }
  const openReference = (path: string, location?: { line: number; column?: number }) => {
    try {
      const state = useAppStore.getState(), resource = state.config?.workspaces.find(item => item.id === surface.workspaceId)
      if (!reference || !resource) throw new Error('The original File display position or resource is unconfirmed. Its content is retained.')
      const choice = resolveWorkbenchOccurrenceSelection(state, workbenchSelectionCatalog(state), {
        workspaceId: reference.displayWorkspaceId, groupId: reference.groupId, tabId, regionId: surface.regionId }, 'navigation')
      if (!choice.spaceId || !choice.zoneId) throw new Error('The original File context is unconfirmed. Its content is retained.')
      void openFile(path, reference.groupId, location, surface.workspaceId, undefined, {
        displayWorkspaceId: reference.displayWorkspaceId, space: { spaceId: choice.spaceId, zoneId: choice.zoneId },
        resource: { hostId: resource.hostId, path: resource.path }, ...(presentation.projection ? { projection: presentation.projection } : {})
      }).catch(reportError)
    } catch (error) { reportError(error) }
  }
  const previewSavedHtml = async (saveFirst: boolean) => {
    const state = useAppStore.getState(), original = state.documents[key]
    const owner = state.tabs[tabId]?.regions[surface.regionId]
    const originalGeneration = state.documentGenerations[key]
    const originalWorkspace = state.activeWorkspaceId, originalMainSurface = state.mainSurface
    const originalSelection = fileNavigationSelection(state)
    try {
      if (saveFirst) {
        await state.saveDocument(tabId, surface.regionId)
        const current = useAppStore.getState()
        if (current.tabs[tabId]?.regions[surface.regionId] !== owner ||
          current.activeWorkspaceId !== originalWorkspace || current.mainSurface !== originalMainSurface ||
          fileNavigationSelection(current) !== originalSelection ||
          current.dirtyDocuments[key] || current.documentIssues[key] ||
          current.documentGenerations[key] !== originalGeneration || current.documents[key]?.content !== original?.content) return
      }
      const current = useAppStore.getState(), layout = reference ? current.layouts[reference.displayWorkspaceId] : undefined
      const group = reference && layout?.groups.find(item => item.id === reference.groupId && item.tabOrder.includes(tabId))
      if (!reference || !group || !workspaceRoot || !isLocal) throw new Error('Local file Browser preview is unavailable for this workspace.')
      // Browser normalizes the absolute file path, in its existing sandboxed native view.
      await current.createBrowser(group.id, undefined, joinWorkspacePath(workspaceRoot, surface.path), undefined, surface.workspaceId, reference.displayWorkspaceId)
    } catch (error) { reportError(error) }
  }
  const preview = doc && visible && !released && previewing ? overBudget
    ? <div className="file-preview-state" role="status"><strong>Source exceeds the preview budget</strong><span>Preview is limited to 16 MB of UTF-8 content. The full source and its unsaved draft remain editable.</span></div>
    : note
    ? <NoteFileSurfaceView tabId={tabId} surface={surface} />
    : format.sourcePreview
    ? <SourceFilePreview key={key} regionId={surface.regionId} kind={format.sourcePreview} content={doc.content} path={surface.path}
      workspaceId={surface.workspaceId} workspaceRoot={workspaceRoot} visible={visible} openReference={openReference}
      openHttpLink={(url) => {
        if (!reference) { reportError(new Error('The original File display position is unconfirmed. Its content is retained.')); return }
        void useAppStore.getState().openHttpLink({ workspaceId: reference.displayWorkspaceId, tabGroupId: reference.groupId, tabId, regionId: surface.regionId }, url, 'tab').catch(reportError)
      }} /> : null : null
  return <Suspense fallback={<FullPageLoadingSurface scope="region" phase="loading" eyebrow="File" title="Loading file" detail="Loading file content" />}>
    <EditorPane tabId={tabId} surface={surface} released={released} visible={visible}
      {...(format.sourcePreview ? { preview, onTogglePreview: () => { void setRegionMode(surface.regionId, surface.workspaceId, surface.path, previewing ? 'edit' : 'preview') } } : {})}
      {...(html ? { extraActions: <>
        <DropdownMenu.Item className="tab-context-menu__item" title="Open the saved file in Browser; keep the current source draft" disabled={!isLocal} onSelect={() => void previewSavedHtml(false)}><ThemeActionRevealIcon size={13} />Preview saved file</DropdownMenu.Item>
        {dirty ? <DropdownMenu.Item className="tab-context-menu__item" disabled={saving || !isLocal} onSelect={() => void previewSavedHtml(true)}><ThemeActionSaveIcon size={13} />Save & Preview</DropdownMenu.Item> : null}
      </> } : {})} />
  </Suspense>
}
