import { lazy, Suspense, useEffect, useRef } from 'react'
import { useWorkspaceMediaStream } from '../../lib/use-workspace-media-stream'
import { documentKey } from '../../lib/workbench-tabs'
import { api } from '../../lib/api'
import { useAppStore } from '../../store'
import { FilePreviewState } from '@agentmux/editor-extensions/ui/FilePreviewState'

const MediaPlayer = lazy(async () => ({ default: (await import('@agentmux/editor-extensions/ui/MediaPlayer')).MediaPlayer }))

/**
 * A playlist's preview plays the saved file through its playback lease; its source stays editable text.
 * Unsaved source edits are said to be outside what plays. When they are saved or dropped the player reopens
 * on the file, so a finished list plays the new one. A writer outside this view, such as an encoder appending
 * to a live list, changes the file without that and is read by the player's own reloads.
 */
export function PlaylistFilePreview({ workspaceId, path, visible }: { workspaceId: string; path: string; visible: boolean }) {
  const key = documentKey(workspaceId, path)
  const dirty = useAppStore(state => Boolean(state.dirtyDocuments[key]))
  const stream = useWorkspaceMediaStream(workspaceId, path, visible)
  const { reload } = stream, wasDirty = useRef(dirty)
  useEffect(() => { if (wasDirty.current && !dirty) reload(); wasDirty.current = dirty }, [dirty, reload])
  if (stream.failure) return <div className="file-preview-state" role="alert"><strong>{stream.failure.status === 'deleted' ? 'File was deleted' : 'Playback unavailable'}</strong>
    <span>{stream.failure.message}</span><button className="small-button" onClick={stream.reload}>Retry</button></div>
  if (!stream.lease) return <FilePreviewState title="Opening playlist" />
  return <div className="file-playlist-preview">
    {dirty ? <div className="file-html-preview__notice" role="status">Playing the saved playlist. Save to play your changes.</div> : null}
    <Suspense fallback={<FilePreviewState title="Preparing player" />}>
      <MediaPlayer readStatus={api.files.mediaStreamStatus} key={stream.lease.id} lease={stream.lease} name={path} onRetry={stream.reload} resume={stream.resume} />
    </Suspense>
  </div>
}
