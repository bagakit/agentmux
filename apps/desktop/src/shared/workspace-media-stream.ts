/** A visible File's playback lease. Main owns the bytes; the Renderer only holds this URL. */
export type WorkspaceMediaStreamKind = 'audio' | 'video' | 'playlist'

export type WorkspaceMediaStreamOpenResult =
  | { status: 'ready'; id: string; url: string; kind: WorkspaceMediaStreamKind; mimeType: string; byteLength: number }
  | { status: 'directory' }
  | { status: 'deleted'; message: string }
  | { status: 'unsupported'; message: string }
  | { status: 'unavailable'; code: string; message: string }

/** The lease owner's own record of why it refused bytes. Media element errors cannot tell these apart. */
export type WorkspaceMediaStreamFact =
  | { state: 'active' }
  | { state: 'released' }
  | { state: 'deleted'; path: string }
  | { state: 'changed'; path: string }
  | { state: 'outside-workspace'; path: string }
  | { state: 'external-reference'; path: string }
  | { state: 'unsupported-resource'; path: string }
  | { state: 'read-error'; path: string; code: string }
  /** Refused once for a retryable reason (a moved live window, a rewrite in progress); not a verdict on the file. */
  | { state: 'transient'; path: string; code: string }

export const WORKSPACE_MEDIA_PLAYLIST_EXTENSION = 'm3u8'
