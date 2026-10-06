import { RetainedDocumentDraftNotice } from './RetainedDocumentDraftNotice'
import { lazy, Suspense, useEffect, useRef, useState, type ReactNode } from 'react'
import { semanticIconComponent } from '@agentmux/client-ui/icons'
import { api } from '../lib/api'
import { effectiveFileRegionMode } from '../lib/file-region-presentation'
import { FullPageLoadingSurface } from './FullPageLoadingSurface'
import { revealInFileManagerLabel } from '../lib/host-platform'
import { detectLanguage } from '../lib/language-detect'
import { FilePathLabel } from './FilePathLabel'
import { useMonacoTheme } from '../hooks/useMonacoTheme'
import { documentKey, type FileWorkbenchSurface } from '../lib/workbench-tabs'
import { useAppStore } from '../store'
import * as DropdownMenu from './HoverDropdownMenu'
import { EditorReleasedState } from './EditorReleasedState'
import { loadFileSourceEditor } from '../lib/file-surface-loading'
import type { FileEditorViewState } from './FileSourceEditor'
import { useWorkspaceResource } from '../hooks/useWorkspaceResource'
import { canFormatFile } from '../lib/file-formats/format-support'
import { cancelFileRegionFormat, formatFileRegion, type FileFormatResult } from '../lib/file-formats/format-file-region'

const ThemeActionRefreshIcon = semanticIconComponent('action.refresh')
const ThemeObjectFolderOpenIcon = semanticIconComponent('object.folder-open')
const ThemeObjectSourceCodeIcon = semanticIconComponent('object.source-code')
const ThemeActionRevealIcon = semanticIconComponent('action.reveal')
const ThemeActionSaveIcon = semanticIconComponent('action.save')
const ThemeActionMoreIcon = semanticIconComponent('action.more')
const ThemeActionWrapTextIcon = semanticIconComponent('action.wrap-text')
const ThemeStatusSelectedIcon = semanticIconComponent('status.selected')
const ThemeObjectMapIcon = semanticIconComponent('object.map')
const ThemeGitCompareIcon = semanticIconComponent('git.compare')
const ThemeStatusWarningIcon = semanticIconComponent('status.warning')


const FileSourceEditor = lazy(loadFileSourceEditor)
const GitDiffCanvas = lazy(async () => ({ default: (await import('../features/git/diff/GitDiffCanvas')).GitDiffCanvas }))

// The failure state of a file surface. It stays hookless so it can be exercised without a Monaco
// render context: the reveal action is the one output an unopenable file must still offer, and the
// only escape hatch that answers "is it actually still there?". Absent — not disabled — when reveal
// cannot work, because a button that is guaranteed to error is not an offer.
export function EditorUnavailableState({
  canReveal,
  onReveal,
  message,
  onRetry
}: {
  canReveal: boolean
  onReveal: () => void
  message?: string
  onRetry?: () => void
}) {
  return (
    <section className="pane-state pane-state--error">
      <strong>{message ? 'File could not be read' : 'File is no longer available'}</strong>
      <span>{message ?? 'Refresh the explorer and open it again.'}</span>
      {onRetry ? <button className="small-button" onClick={onRetry}><ThemeActionRefreshIcon size={13} /> Retry</button> : null}
      {canReveal ? (
        <button className="small-button" onClick={onReveal}>
          <ThemeObjectFolderOpenIcon size={13} /> {revealInFileManagerLabel()}
        </button>
      ) : null}
    </section>
  )
}

// Routes the failure-state reveal through the SAME channel the file tree uses (api.files.reveal →
// files:reveal → localPathForReveal). A deleted target is handled downstream by falling back to its
// nearest existing ancestor, so this stays a plain call; when reveal still cannot land, the error
// surfaces on the shared reportError banner rather than replacing the pane with a second dead end.
export async function revealFileInFileManager(
  workspaceId: string,
  path: string,
  reportError: (error: unknown) => void
): Promise<void> {
  try {
    await api.files.reveal(workspaceId, path)
  } catch (error) {
    reportError(error)
  }
}


export function EditorPane({
  tabId,
  surface,
  released = false,
  visible = true,
  preview,
  onTogglePreview,
  extraActions
}: {
  tabId: string
  surface: FileWorkbenchSurface
  released?: boolean
  visible?: boolean
  preview?: ReactNode
  onTogglePreview?: () => void
  extraActions?: ReactNode
}) {
  const key = documentKey(surface.workspaceId, surface.path)
  const document = useAppStore((state) => {
    return state.documents[key] ?? null
  })
  const dirty = useAppStore((state) => {
    return Boolean(state.dirtyDocuments[key])
  })
  const issue = useAppStore((state) => {
    return state.documentIssues[key]
  })
  const saving = useAppStore((state) => {
    return Boolean(state.savingDocuments[key])
  })
  const save = useAppStore((state) => state.saveDocument)
  const reload = useAppStore((state) => state.reloadDocument)
  const overwrite = useAppStore((state) => state.overwriteDocument)
  const isLocalWorkspace = useWorkspaceResource(surface.workspaceId)?.hostId === 'local'
  const reportError = useAppStore((state) => state.reportError)
  const attachPersistedDocument = useAppStore((state) => state.attachPersistedFileDocument)
  // Word wrap is one global viewing preference (like a theme), not a document property: it is read
  // here and mapped to Monaco's enum through the single wordWrapOption seam, so the option is
  // controlled/reactive rather than a mount-time constant.
  const wordWrap = useAppStore((state) => state.editorWordWrap)
  const toggleWordWrap = useAppStore((state) => state.toggleEditorWordWrap)
  const minimap = useAppStore((state) => state.editorMinimap)
  const toggleMinimap = useAppStore((state) => state.toggleEditorMinimap)
  // Diff is a display MODE of this same file Region, not a separate surface kind: it carries no
  // identity beyond the file it compares, so it lives as per-Region ephemeral state keyed by regionId
  // (never persisted — a diff depends on git HEAD and is transient; reopening returns to edit).
  const regionMode = useAppStore((state) => effectiveFileRegionMode(state.editorRegionModes, surface.regionId, surface.path, issue?.kind === 'binary'))
  const previewing = regionMode === 'preview'
  const regionDiff = useAppStore((state) => Object.hasOwn(state.editorRegionDiffs, surface.regionId) ? state.editorRegionDiffs[surface.regionId] : undefined)
  const setRegionMode = useAppStore((state) => state.setEditorRegionMode)
  const reloadDiff = useAppStore((state) => state.reloadRegionDiff)
  const monacoTheme = useMonacoTheme()
  const conflict = issue?.kind === 'changed' || issue?.kind === 'deleted'
  const sourceViewState = useRef<FileEditorViewState | null>(null)
  const [formatResult, setFormatResult] = useState<FileFormatResult | { status: 'formatting'; message: string } | null>(null)
  const formatRequest = useRef(0)
  useEffect(() => {
    setFormatResult(null)
    return () => { ++formatRequest.current; cancelFileRegionFormat(surface.regionId) }
  }, [surface.regionId, key, visible, regionMode])
  function formatDraft(): void {
    if (formatResult?.status === 'formatting') { cancelFileRegionFormat(surface.regionId); return }
    const request = ++formatRequest.current
    setFormatResult({ status: 'formatting', message: 'Formatting current draft…' })
    void formatFileRegion(surface.regionId).then(result => { if (formatRequest.current === request) setFormatResult(result) })
  }

  // A file Region restored from persistence arrives with no document behind it: the surface is only
  // {regionId,kind,workspaceId,path}, and every other way a file Region appears loads its document as
  // part of opening it. Without this the Tab is present and reports "unavailable" — which reads as a
  // broken file rather than an unloaded one. Asking for it here, from the very pane that would render
  // that state, is what makes a Region in a Workspace the user has not switched back to yet work too.
  //
  // Retained hidden tabs do not read content. The original surface stays durable and loads when shown.
  //
  // Guarded on `issue`, not just on `document`: a read that failed (the file was deleted while the app
  // was closed, or the read errored) records the reason and leaves `document` null, so without that
  // guard this would re-read a known-unreadable path on every dependency change. The user's route out
  // of that state is the Reveal action below, not a silent retry.
  useEffect(() => {
    if (document || issue || released || !visible) return
    void attachPersistedDocument(surface.workspaceId, surface.path)
  }, [document, issue, released, visible, attachPersistedDocument, surface.workspaceId, surface.path])

  if (released) return <EditorReleasedState />

  if (!document) {
    if (!issue) return <FullPageLoadingSurface scope="region" phase="loading" title="Loading file" detail={visible ? 'Reading file content' : 'File content loads when shown'} />
    return (
      <EditorUnavailableState
        {...(issue.kind === 'read-error' ? { message: issue.message, onRetry: () => { void reload(tabId, surface.regionId) } } : {})}
        canReveal={isLocalWorkspace}
        onReveal={() => void revealFileInFileManager(surface.workspaceId, surface.path, reportError)}
      />
    )
  }

  return (
    <section
      className={`editor-pane ${onTogglePreview || extraActions ? 'editor-pane--format' : ''}`}
      data-file-state={issue?.kind ?? (saving ? 'saving' : dirty ? 'dirty' : 'clean')}
    >
      <header className="editor-header">
        <FilePathLabel path={document.path} />
        <div className="editor-header__actions">
          {onTogglePreview ? <button className="small-button" aria-pressed={previewing} aria-label={previewing ? 'Show source' : 'Preview current content'} onClick={onTogglePreview} title={previewing ? 'Show source' : 'Preview current content'}>{previewing ? <ThemeObjectSourceCodeIcon size={13} /> : <ThemeActionRevealIcon size={13} />}<span className="editor-header__label">{previewing ? 'Source' : 'Preview'}</span></button> : null}
          {regionMode === 'diff' ? <button className="small-button" disabled={Boolean(regionDiff?.loading)} title="Reload diff" aria-label="Reload diff" onClick={() => void reloadDiff(surface.regionId, surface.workspaceId, surface.path)}><ThemeActionRefreshIcon size={13} /><span className="editor-header__label">{regionDiff?.loading ? 'Loading…' : 'Refresh'}</span></button>
            : conflict ? <button className="small-button small-button--warning" disabled={saving} title="Overwrite file with this draft" aria-label="Overwrite file with this draft" onClick={() => void overwrite(tabId, surface.regionId)}><ThemeActionSaveIcon size={13} /><span className="editor-header__label">{saving ? 'Overwriting…' : 'Overwrite'}</span></button>
              : issue?.kind === 'write-unknown' ? <button className="small-button" disabled={saving} title="Check saved file before retrying" aria-label="Check saved file" onClick={() => void reload(tabId, surface.regionId)}><ThemeActionRefreshIcon size={13} /><span className="editor-header__label">{saving ? 'Checking…' : 'Check saved file'}</span></button>
                : issue?.kind === 'read-error' ? <button className="small-button" disabled={saving} title="Retry reading file" aria-label="Retry reading file" onClick={() => void reload(tabId, surface.regionId)}><ThemeActionRefreshIcon size={13} /><span className="editor-header__label">Retry</span></button>
                : saving ? <span className="editor-header__status" role="status" aria-label="Saving file">Saving…</span>
                  : dirty ? <button className="small-button" title="Save file" aria-label="Save file" onClick={() => void save(tabId, surface.regionId)}><ThemeActionSaveIcon size={13} /><span className="editor-header__label">Save</span></button>
                    : <span className="editor-header__status" role="status" aria-label="File saved">Saved</span>}
          <DropdownMenu.Root><DropdownMenu.Trigger asChild><button type="button" className="small-button editor-header__more" aria-label="File options" title="File options"><ThemeActionMoreIcon size={14} /></button></DropdownMenu.Trigger>
            <DropdownMenu.Portal><DropdownMenu.Content className="tab-context-menu file-options-menu" align="end" sideOffset={6} collisionPadding={8}>
              {regionMode === 'edit' && canFormatFile(document.path) ? <DropdownMenu.Item className="tab-context-menu__item" onSelect={formatDraft}><ThemeObjectSourceCodeIcon size={13} /><span>{formatResult?.status === 'formatting' ? 'Cancel formatting' : 'Format document'}</span></DropdownMenu.Item> : null}
              <DropdownMenu.CheckboxItem className="tab-context-menu__item" checked={wordWrap} onSelect={event => event.preventDefault()} onCheckedChange={() => toggleWordWrap()}><ThemeActionWrapTextIcon size={13} /><span>Word wrap</span><kbd>Alt+Z</kbd><DropdownMenu.ItemIndicator className="file-menu-check"><ThemeStatusSelectedIcon size={12} /></DropdownMenu.ItemIndicator></DropdownMenu.CheckboxItem>
              {regionMode === 'edit' ? <DropdownMenu.CheckboxItem className="tab-context-menu__item" checked={minimap} onSelect={event => event.preventDefault()} onCheckedChange={() => toggleMinimap()}><ThemeObjectMapIcon size={13} /><span>Minimap</span><DropdownMenu.ItemIndicator className="file-menu-check"><ThemeStatusSelectedIcon size={12} /></DropdownMenu.ItemIndicator></DropdownMenu.CheckboxItem> : null}
              <DropdownMenu.CheckboxItem className="tab-context-menu__item" checked={regionMode === 'diff'} onSelect={event => event.preventDefault()} onCheckedChange={value => void setRegionMode(surface.regionId, surface.workspaceId, surface.path, value === true ? 'diff' : 'edit')}><ThemeGitCompareIcon size={13} /><span>Diff against HEAD</span><DropdownMenu.ItemIndicator className="file-menu-check"><ThemeStatusSelectedIcon size={12} /></DropdownMenu.ItemIndicator></DropdownMenu.CheckboxItem>
              {conflict ? <DropdownMenu.Item className="tab-context-menu__item" disabled={saving} onSelect={() => void reload(tabId, surface.regionId)}><ThemeActionRefreshIcon size={13} />Reload from disk</DropdownMenu.Item> : null}
              {extraActions ? <><DropdownMenu.Separator className="tab-context-menu__separator" />{extraActions}</> : null}
            </DropdownMenu.Content></DropdownMenu.Portal>
          </DropdownMenu.Root>
        </div>
      </header>
      <div className="editor-file-notices">
        {document.noteWriteAttribution?.status === 'unconfirmed' ? <div className="editor-file-notice" role="status">The Note was saved. Block authorship is unconfirmed: {document.noteWriteAttribution.reason} Your Note remains editable; a later save with a confirmed author records its changed blocks.</div> : null}
        {formatResult?.message ? <div className="editor-file-notice" role={formatResult.status === 'failed' ? 'alert' : 'status'}>{formatResult.message}</div> : null}
        <RetainedDocumentDraftNotice tabId={tabId} surface={surface} />
        {issue ? (
          <div className={`editor-file-notice editor-file-notice--${issue.kind}`} role="alert">
            <ThemeStatusWarningIcon size={13} />
            <span>
              {issue.kind === 'changed'
                ? 'File changed on disk. Your draft is preserved.'
                : issue.kind === 'deleted'
                  ? 'File was deleted on disk. Reload accepts the deletion; Overwrite recreates it.'
                  : issue.kind === 'read-error'
                    ? `Could not refresh the file (${issue.message}). The last buffer is preserved.`
                    : issue.kind === 'write-unknown' ? `Save outcome is not confirmed. Your draft is preserved. Check the saved file before saving again.${issue.checkMessage ? ' Check unavailable: ' + issue.checkMessage : ''}`
                      : issue.kind === 'write-error' ? `Save failed (${issue.message}). Your draft is still unsaved.`
                      : 'The file is binary. The existing text buffer is preserved.'}
            </span>
          </div>
        ) : null}
      </div>
      <div className="editor-canvas">
        <Suspense fallback={<FullPageLoadingSurface scope="region" phase="loading" title="Loading editor" detail="Preparing the editor" />}>
        {previewing ? preview : regionMode === 'diff' ? (
          <GitDiffCanvas diff={regionDiff} wordWrap={wordWrap} language={detectLanguage(document.path)} theme={monacoTheme} />
        ) : (
          <FileSourceEditor tabId={tabId} surface={surface} visible={visible} viewState={sourceViewState} />
        )}
        </Suspense>
      </div>
    </section>
  )
}
