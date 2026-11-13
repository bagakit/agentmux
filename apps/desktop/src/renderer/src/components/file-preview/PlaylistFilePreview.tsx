import { lazy, Suspense } from 'react'
import { useWorkspaceMediaStream } from '../../lib/use-workspace-media-stream'
import { documentKey } from '../../lib/workbench-tabs'
import { useAppStore } from '../../store'
import { FilePreviewState } from '../FilePreviewState'

const MediaPlayer = lazy(async () => ({ default: (await import('../MediaPlayer')).MediaPlayer }))

/**
 * A playlist's preview plays the saved file through its playback lease; its source stays editable text.
 * Unsaved source edits are said to be outside what plays, and each save restarts the player on the new file.
 */
export function PlaylistFilePreview({ workspaceId, path, visible }: { workspaceId: string; path: string; visible: boolean }) {
  const key = documentKey(workspaceId, path)
  const dirty = useAppStore(state => Boolean(state.dirtyDocuments[key]))
  const revision = useAppStore(state => state.documents[key]?.revision ?? null)
  const stream = useWorkspaceMediaStream(workspaceId, path, visible, revision)
  if (stream.failure) return <div className="file-preview-state" role="alert"><strong>{stream.failure.status === 'deleted' ? 'File was deleted' : 'Playback unavailable'}</strong>
    <span>{stream.failure.message}</span><button className="small-button" onClick={stream.reload}>Retry</button></div>
  if (!stream.lease) return <FilePreviewState title="Opening playlist" />
  return <div className="file-playlist-preview">
    {dirty ? <div className="file-html-preview__notice" role="status">Playing the saved playlist. Save to play your changes.</div> : null}
    <Suspense fallback={<FilePreviewState title="Preparing player" />}>
      <MediaPlayer key={stream.lease.id} lease={stream.lease} name={path} onRetry={stream.reload} resume={stream.resume} />
    </Suspense>
  </div>
}
