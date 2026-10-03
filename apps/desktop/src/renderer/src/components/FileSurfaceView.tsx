import { lazy, Suspense, useEffect, useMemo, useState } from 'react'
import { Eye, Save } from 'lucide-react'
import { WORKSPACE_FILE_MAX_BYTES } from '../../../shared/workspace-file-bytes'
import { workspaceFileFormat } from '../../../shared/workspace-file-format'
import { documentKey, tabGroupForTab, type FileWorkbenchSurface } from '../lib/workbench-tabs'
import { joinWorkspacePath } from '../lib/workspace-paths'
import { effectiveFileRegionMode } from '../lib/file-region-presentation'
import { useAppStore } from '../store'
import { AgentMarkdown } from '@agentmux/client-ui/components/AgentMarkdown'
import * as DropdownMenu from './HoverDropdownMenu'
import { FilePreviewPane, ImageContent } from './FilePreviewPane'
import { FullPageLoadingSurface } from './FullPageLoadingSurface'
import { WorkspaceImage } from './WorkspaceImage'

const EditorPane = lazy(async () => ({ default: (await import('./EditorPane')).EditorPane }))
const NoteFileSurfaceView = lazy(async () => ({ default: (await import('./NoteFileSurfaceView')).NoteFileSurfaceView }))
const FileDataPreview = lazy(async () => ({ default: (await import('./FileDataPreview')).FileDataPreview }))

function SourceImage({ content, name, visible }: { content: string; name: string; visible: boolean }) {
  const [loaded, setLoaded] = useState<{ content: string; url: string } | null>(null)
  useEffect(() => {
    setLoaded(null)
    if (!visible) return
    const value = URL.createObjectURL(new Blob([content], { type: 'image/svg+xml' }))
    setLoaded({ content, url: value })
    return () => URL.revokeObjectURL(value)
  }, [content, visible])
  const url = visible && loaded?.content === content ? loaded.url : null
  return url ? <ImageContent key={url} src={url} name={name} /> : null
}

/** One File identity with format-specific presentation, never a second editable document. */
export function FileSurfaceView({ tabId, surface, released = false, visible = true }: {
  tabId: string; surface: FileWorkbenchSurface; released?: boolean; visible?: boolean
}) {
  const key = documentKey(surface.workspaceId, surface.path)
  const doc = useAppStore(state => state.documents[key])
  const binary = useAppStore(state => state.documentIssues[key]?.kind === 'binary')
  const dirty = useAppStore(state => Boolean(state.dirtyDocuments[key]))
  const saving = useAppStore(state => Boolean(state.savingDocuments[key]))
  const workspaceRoot = useAppStore(state => state.config?.workspaces.find(workspace => workspace.id === surface.workspaceId)?.path ?? '')
  const isLocal = useAppStore(state => state.config?.workspaces.find(workspace => workspace.id === surface.workspaceId)?.hostId === 'local')
  const reportError = useAppStore(state => state.reportError)
  const openFile = useAppStore(state => state.openFile)
  const noteReveal = useAppStore(state => state.documentRevealTargets[key]?.noteBlock)
  const format = workspaceFileFormat(surface.path)
  const markdown = format.sourcePreview === 'markdown'
  const svg = format.sourcePreview === 'svg'
  const html = format.browserPreview
  const note = format.sourcePreview === 'note'
  const dataKind = format.sourcePreview === 'json' || format.sourcePreview === 'csv' || format.sourcePreview === 'tsv' ? format.sourcePreview : null
  const regionMode = useAppStore(state => effectiveFileRegionMode(state.editorRegionModes, surface.regionId, surface.path, binary))
  const setRegionMode = useAppStore(state => state.setEditorRegionMode)
  const previewing = regionMode === 'preview'
  useEffect(() => { if (note && noteReveal) void setRegionMode(surface.regionId, surface.workspaceId, surface.path, 'preview') },
    [note, noteReveal, setRegionMode, surface.regionId, surface.workspaceId, surface.path])
  const overBudget = useMemo(() => {
    if (!visible || released || !previewing || !doc || !(markdown || svg || note)) return false
    if (doc.content.length > WORKSPACE_FILE_MAX_BYTES) return true
    // UTF-8 needs at most three bytes per UTF-16 unit. Encode only up to the preview ceiling.
    const bytes = new Uint8Array(Math.min(WORKSPACE_FILE_MAX_BYTES + 1, doc.content.length * 3))
    const result = new TextEncoder().encodeInto(doc.content, bytes)
    return result.written > WORKSPACE_FILE_MAX_BYTES || result.read < doc.content.length
  }, [visible, released, previewing, doc?.content, markdown, svg, note])

  if (!format.sourceEditable || (!doc && binary)) {
    return <FilePreviewPane surface={surface} visible={visible && !released} onRetryBinary={() => { void useAppStore.getState().reloadDocument(tabId, surface.regionId) }} />
  }
  const openReference = (path: string, location?: { line: number; column?: number }) => {
    const layout = useAppStore.getState().layouts[surface.workspaceId]
    const group = layout ? tabGroupForTab(layout, tabId) ?? undefined : undefined
    void openFile(path, group, location, surface.workspaceId).catch(reportError)
  }
  const previewSavedHtml = async (saveFirst: boolean) => {
    const state = useAppStore.getState(), original = state.documents[key]
    const owner = state.tabs[tabId]?.regions[surface.regionId]
    const originalGeneration = state.documentGenerations[key]
    const originalWorkspace = state.activeWorkspaceId, originalMainSurface = state.mainSurface
    const originalLayout = state.layouts[originalWorkspace ?? '']
    const originalTab = originalLayout?.groups.find(group => group.id === originalLayout.activeGroupId)?.activeTabId
    const originalRegion = originalTab ? state.tabs[originalTab]?.layout.activeRegionId : undefined
    try {
      if (saveFirst) {
        await state.saveDocument(tabId, surface.regionId)
        const current = useAppStore.getState()
        const currentLayout = current.layouts[current.activeWorkspaceId ?? '']
        const currentTab = currentLayout?.groups.find(group => group.id === currentLayout.activeGroupId)?.activeTabId
        const currentRegion = currentTab ? current.tabs[currentTab]?.layout.activeRegionId : undefined
        if (current.tabs[tabId]?.regions[surface.regionId] !== owner ||
          current.activeWorkspaceId !== originalWorkspace || current.mainSurface !== originalMainSurface ||
          currentLayout?.activeGroupId !== originalLayout?.activeGroupId || currentTab !== originalTab || currentRegion !== originalRegion ||
          current.dirtyDocuments[key] || current.documentIssues[key] ||
          current.documentGenerations[key] !== originalGeneration || current.documents[key]?.content !== original?.content) return
      }
      const current = useAppStore.getState(), layout = current.layouts[surface.workspaceId]
      const group = layout ? tabGroupForTab(layout, tabId) : undefined
      if (!group || !workspaceRoot || !isLocal) throw new Error('Local file Browser preview is unavailable for this workspace.')
      // Browser normalizes the absolute file path, in its existing sandboxed native view.
      await current.createBrowser(group, undefined, joinWorkspacePath(workspaceRoot, surface.path), undefined, surface.workspaceId)
    } catch (error) { reportError(error) }
  }
  const preview = doc && visible && !released && previewing ? overBudget
    ? <div className="file-preview-state" role="status"><strong>Source exceeds the preview budget</strong><span>Preview is limited to 16 MB of UTF-8 content. The full source and its unsaved draft remain editable.</span></div>
    : note
    ? <NoteFileSurfaceView tabId={tabId} surface={surface} />
    : svg
    ? <SourceImage key={key} content={doc.content} name={surface.path} visible={visible} />
    : dataKind
    ? <FileDataPreview key={key} content={doc.content} kind={dataKind} comments={format.extension === 'jsonc'} />
    : <AgentMarkdown documentMode className="file-markdown-preview" content={doc.content} workspaceRoot={workspaceRoot} sourcePath={surface.path}
      renderWorkspaceImage={(path, alt, linked) => <WorkspaceImage key={`${surface.workspaceId}:${path}`} workspaceId={surface.workspaceId} path={path} alt={alt} linked={Boolean(linked)} openFile={() => openReference(path)} />}
      openWorkspaceFile={openReference}
      openHttpLink={(url) => {
        const state = useAppStore.getState(), layout = state.layouts[surface.workspaceId]
        const group = layout ? tabGroupForTab(layout, tabId) : undefined
        if (group) void state.openHttpLink({ workspaceId: surface.workspaceId, tabGroupId: group, tabId, regionId: surface.regionId }, url, 'tab').catch(reportError)
      }} /> : null
  return <Suspense fallback={<FullPageLoadingSurface scope="region" phase="loading" eyebrow="File" title="Loading file" detail="Loading file content" />}>
    <EditorPane tabId={tabId} surface={surface} released={released} visible={visible}
      {...(format.sourcePreview ? { preview, onTogglePreview: () => { void setRegionMode(surface.regionId, surface.workspaceId, surface.path, previewing ? 'edit' : 'preview') } } : {})}
      {...(html ? { extraActions: <>
        <DropdownMenu.Item className="tab-context-menu__item" title="Open the saved file in Browser; keep the current source draft" disabled={!isLocal} onSelect={() => void previewSavedHtml(false)}><Eye size={13} />Preview saved file</DropdownMenu.Item>
        {dirty ? <DropdownMenu.Item className="tab-context-menu__item" disabled={saving || !isLocal} onSelect={() => void previewSavedHtml(true)}><Save size={13} />Save & Preview</DropdownMenu.Item> : null}
      </> } : {})} />
  </Suspense>
}
