import { lazy, Suspense } from 'react'
import { useWorkspaceMediaStream } from '../../lib/use-workspace-media-stream'
import { FilePreviewState } from '../FilePreviewState'

const MediaPlayer = lazy(async () => ({ default: (await import('../MediaPlayer')).MediaPlayer }))

/** A playlist's preview plays the saved file through its playback lease; its source stays editable text. */
export function PlaylistFilePreview({ workspaceId, path, visible }: { workspaceId: string; path: string; visible: boolean }) {
  const stream = useWorkspaceMediaStream(workspaceId, path, visible)
  if (stream.failure) return <div className="file-preview-state" role="alert"><strong>{stream.failure.status === 'deleted' ? 'File was deleted' : 'Playback unavailable'}</strong>
    <span>{stream.failure.message}</span><button className="small-button" onClick={stream.reload}>Retry</button></div>
  if (!stream.lease) return <FilePreviewState title="Opening playlist" />
  return <Suspense fallback={<FilePreviewState title="Preparing player" />}>
    <MediaPlayer key={stream.lease.id} lease={stream.lease} name={path} onRetry={stream.reload} />
  </Suspense>
}
