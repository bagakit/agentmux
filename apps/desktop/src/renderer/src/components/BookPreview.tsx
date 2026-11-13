import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { BookFormat } from '@agentmux/editor-extensions/books'
import type { BookReaderHost, BookReadingPosition } from '@agentmux/editor-extensions/book-reader/protocol'
import { FilePreviewState } from '@agentmux/editor-extensions/ui/FilePreviewState'
import type { FileWorkbenchSurface } from '../lib/workbench-tabs'
import { useWorkspaceFileSource } from '../lib/use-workspace-file-source'
import { api } from '../lib/api'
import { useAppStore } from '../store'
import { createFileViewReadingBinding, readingProjection, type FileViewReadingBinding } from '../lib/file-view-reading'

const BookReader = lazy(async () => ({default: (await import('@agentmux/editor-extensions/book-reader')).BookReader}))
export function BookPreview({ tabId, surface, visible, format }: {tabId: string; surface: FileWorkbenchSurface; visible: boolean; format: BookFormat}) {
  const {source, id, failure, reload, binding: sourceBinding} = useWorkspaceFileSource(surface.workspaceId, surface.path, visible)
  const host = useMemo<BookReaderHost | null>(() => id && source ? {
    open: () => api.files.openBook({sourceId: id, size: source.size, format, name: surface.path}),
    load: api.files.loadBookSection, unload: api.files.unloadBookSection, resolve: api.files.resolveBookHref, close: api.files.closeBook,
  } : null, [id, source, format, surface.path])
  const positionCheckpoint = useRef<(() => void) | null>(null)
  const readingBinding = useMemo(() => sourceBinding ? createFileViewReadingBinding(sourceBinding, tabId, surface.regionId, surface.path,
    useAppStore.getState, () => positionCheckpoint.current?.()) : null, [sourceBinding, tabId, surface.regionId, surface.path])
  const reading = useAppStore(state => readingBinding ? readingProjection(state.fileViewReading, readingBinding.owner) : undefined)
  const [continueReading, setContinueReading] = useState<FileViewReadingBinding | null>(null)
  useEffect(() => { if (visible && readingBinding) void useAppStore.getState().loadFileViewReading(readingBinding) }, [visible, readingBinding])
  const position = useCallback((value: BookReadingPosition, origin: 'initial' | 'scroll' | 'checkpoint') => {
    if (readingBinding) useAppStore.getState().setFileViewReading(readingBinding, value, origin === 'initial')
  }, [readingBinding])
  if (failure) return <FilePreviewState title={failure.status === 'deleted' ? 'File was deleted' : failure.status === 'changed' ? 'File changed while reading' : 'Book source unavailable'} detail={failure.message} error><button className="small-button" onClick={reload}>Retry</button></FilePreviewState>
  if (!host) return <FilePreviewState title={visible ? 'Opening book source' : 'Reading paused while hidden'} />
  if (readingBinding && (!reading || reading.phase === 'loading' && !reading.position) && continueReading !== readingBinding) return <FilePreviewState title="Restoring reading position"><button className="small-button" onClick={() => setContinueReading(readingBinding)}>Continue reading</button></FilePreviewState>
  return <>
    {!readingBinding ? <div className="file-preview__source-notice" role="status">The original Workspace resource is unconfirmed. Reading remains available; its position cannot yet be saved.</div> : null}
    {reading?.error && readingBinding ? <div className="file-preview__source-notice" role="status">Reading position storage is unavailable: {reading.error} Your book and current position are retained. <button className="small-button" onClick={() => void useAppStore.getState().retryFileViewReading(readingBinding)}>Retry position storage</button></div> : null}
    <Suspense fallback={<FilePreviewState title="Loading book reader" />}><BookReader key={`${id}:${reading?.restoration ?? 0}`} host={host} name={surface.path} {...(reading?.position ? {position: reading.position} : {})} positionCheckpoint={positionCheckpoint} onPosition={position} onRetry={reload} /></Suspense>
  </>
}
