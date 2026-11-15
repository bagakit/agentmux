import { lazy, Suspense, useState } from 'react'
import { semanticIconComponent } from '@agentmux/client-ui/icons'
import { fileActionLocation } from '../../../shared/source-files'
import { fileViewHost, fileViewReadSource } from '../lib/file-view-path'
import { api } from '../lib/api'
import { revealInFileManagerLabel } from '../lib/host-platform'
import { documentKey, type FileWorkbenchSurface } from '../lib/workbench-tabs'
import { useAppStore } from '../store'
import { useWorkspaceResource } from '../hooks/useWorkspaceResource'

import { usePreviewObjectUrl, useWorkspaceFilePreview } from '../lib/use-workspace-file-preview'
import { useWorkspaceMediaStream } from '../lib/use-workspace-media-stream'
import { usePreparePdfReader } from '../lib/use-prepare-pdf-reader'
import { BookPreview } from './BookPreview'
import { useWorkspaceFileSource } from '../lib/use-workspace-file-source'
import { workspaceFilePreviewFormat } from '@agentmux/editor-extensions/catalog'
import { FilePathLabel } from './FilePathLabel'
import { FilePreviewState } from '@agentmux/editor-extensions/ui/FilePreviewState'
import { ImageContent } from '@agentmux/editor-extensions/ui/ImageContent'
import { formatFileBytes } from '@agentmux/editor-extensions/format-file-bytes'

const ThemeActionRefreshIcon = semanticIconComponent('action.refresh')
const ThemeActionOpenExternalIcon = semanticIconComponent('action.open-external')
const ThemeObjectFolderOpenIcon = semanticIconComponent('object.folder-open')


const PdfReader = lazy(async () => ({ default: (await import('@agentmux/editor-extensions/pdf')).PdfReader }))
const MediaPlayer = lazy(async () => ({ default: (await import('@agentmux/editor-extensions/ui/MediaPlayer')).MediaPlayer }))


export function FilePreviewPane({ tabId, surface, visible = true, onRetryBinary, onShowSource, hasUnsavedSource }: { tabId: string; surface: FileWorkbenchSurface; visible?: boolean; onRetryBinary?: () => void; onShowSource?: () => void; hasUnsavedSource?: boolean }) {
  const [bookAttempt, setBookAttempt] = useState(0)
  const key = documentKey(surface.workspaceId, surface.path)
  const binary = useAppStore(state => state.documentIssues[key]?.kind === 'binary' ? state.documentIssues[key] : null)
  const source = useAppStore(state => fileViewReadSource(state, tabId, surface))
  const location = fileActionLocation(surface.workspaceId, surface.path, source)
  const canOpenExternally = fileViewHost(location, useWorkspaceResource(surface.workspaceId)?.hostId) === 'local'
  const reportError = useAppStore(state => state.reportError)
  const playable = workspaceFilePreviewFormat(surface.path)
  const isMedia = playable?.kind === 'audio' || playable?.kind === 'video'
  const isPdf = playable?.kind === 'pdf'
  const isBook = playable?.kind === 'book'
  const snapshot = useWorkspaceFilePreview(surface.workspaceId, surface.path, visible && !binary && !isMedia && !isPdf && !isBook)
  const stream = useWorkspaceMediaStream(surface.workspaceId, surface.path, visible && !binary && isMedia)
  usePreparePdfReader(visible && !binary && isPdf)
  const pdf = useWorkspaceFileSource(surface.workspaceId, surface.path, visible && !binary && isPdf)
  const { preview } = snapshot
  const failure = isMedia ? stream.failure : isPdf ? pdf.failure : snapshot.failure
  const reload = isMedia ? stream.reload : isPdf ? pdf.reload : isBook ? () => setBookAttempt(value => value + 1) : snapshot.reload
  const url = usePreviewObjectUrl(preview)
  const external = async (action: 'openSystem' | 'reveal') => {
    try { await api.files[action](location) } catch (error) { reportError(error) }
  }
  return <section className="file-preview-pane" data-preview-state={binary ? 'binary' : failure?.status ?? (preview ? 'loaded' : visible ? 'loading' : 'inactive')}>
    <header className="editor-header file-preview__header">
      <FilePathLabel path={surface.path} />
      <div className="editor-header__actions">
        {onShowSource ? <button className="small-button" onClick={onShowSource}>Source</button> : null}
        {!binary || onRetryBinary ? <button className="icon-button" aria-label="Reload file preview" title="Reload file preview" onClick={() => binary ? onRetryBinary?.() : reload()}><ThemeActionRefreshIcon size={13} /></button> : null}
        {canOpenExternally ? <>
          <button className="icon-button" aria-label="Open file in system application" title="Open in system application" onClick={() => void external('openSystem')}><ThemeActionOpenExternalIcon size={13} /></button>
          <button className="icon-button" aria-label={revealInFileManagerLabel()} title={revealInFileManagerLabel()} onClick={() => void external('reveal')}><ThemeObjectFolderOpenIcon size={13} /></button>
        </> : null}
      </div>
    </header>
    {hasUnsavedSource ? <div className="file-preview__source-notice" role="status">Preview reads the saved file. Unsaved source changes are retained.</div> : null}
    {binary ? <div className="file-preview-state"><strong>Binary file</strong><span>This file has no editable text content. Open it in a system application to inspect it.</span>{binary.kind === 'binary' ? <span className="file-preview__metadata">{formatFileBytes(binary.byteLength)}</span> : null}</div>
      : failure ? <div className="file-preview-state" role="alert"><strong>{failure.status === 'too-large' ? 'File exceeds the preview budget' : failure.status === 'deleted' ? 'File was deleted' : failure.status === 'changed' ? 'File changed while reading' : failure.status === 'directory' ? 'This path is a directory' : 'Preview unavailable'}</strong><span>{failure.message}</span><button className="small-button" onClick={() => reload()}>Retry</button></div>
      : isBook ? <BookPreview key={bookAttempt} tabId={tabId} surface={surface} visible={visible && !binary} format={playable.engine} />
      : isMedia ? stream.lease ? <Suspense fallback={<FilePreviewState title="Preparing player" />}><MediaPlayer readStatus={api.files.mediaStreamStatus} key={stream.lease.id} lease={stream.lease} name={surface.path} onRetry={reload} resume={stream.resume} /></Suspense>
        : <div className="file-preview-state" role="status">{visible ? 'Opening media…' : 'Playback paused while hidden'}</div>
      : isPdf ? pdf.source ? <Suspense fallback={<FilePreviewState title="Loading PDF reader" />}><PdfReader source={pdf.source} name={surface.path} visible={visible} /></Suspense>
        : <div className="file-preview-state" role="status">{visible ? 'Opening PDF…' : 'Preview paused while hidden'}</div>
      : !preview ? <div className="file-preview-state" role="status">{visible ? 'Reading file…' : 'Preview paused while hidden'}</div>
      : !url ? <FilePreviewState title="Preparing file preview" />
      : <ImageContent key={url} src={url} name={surface.path} byteLength={preview.byteLength} />}
  </section>
}
