import type { WorkspaceFileByteRead } from './workspace-file-bytes'

/** File routing and declared MIME candidates. Read success does not prove codec support. */
export const WORKSPACE_FILE_PREVIEW_FORMATS = {
  png: { kind: 'image', mimeType: 'image/png', sourceEditable: false },
  jpg: { kind: 'image', mimeType: 'image/jpeg', sourceEditable: false },
  jpeg: { kind: 'image', mimeType: 'image/jpeg', sourceEditable: false },
  gif: { kind: 'image', mimeType: 'image/gif', sourceEditable: false },
  webp: { kind: 'image', mimeType: 'image/webp', sourceEditable: false },
  bmp: { kind: 'image', mimeType: 'image/bmp', sourceEditable: false },
  avif: { kind: 'image', mimeType: 'image/avif', sourceEditable: false },
  ico: { kind: 'image', mimeType: 'image/x-icon', sourceEditable: false },
  svg: { kind: 'image', mimeType: 'image/svg+xml', sourceEditable: true },
  mp3: { kind: 'audio', mimeType: 'audio/mpeg', sourceEditable: false },
  wav: { kind: 'audio', mimeType: 'audio/wav', sourceEditable: false },
  ogg: { kind: 'audio', mimeType: 'audio/ogg', sourceEditable: false },
  oga: { kind: 'audio', mimeType: 'audio/ogg', sourceEditable: false },
  opus: { kind: 'audio', mimeType: 'audio/ogg', sourceEditable: false },
  flac: { kind: 'audio', mimeType: 'audio/flac', sourceEditable: false },
  m4a: { kind: 'audio', mimeType: 'audio/mp4', sourceEditable: false },
  aac: { kind: 'audio', mimeType: 'audio/aac', sourceEditable: false },
  mp4: { kind: 'video', mimeType: 'video/mp4', sourceEditable: false },
  m4v: { kind: 'video', mimeType: 'video/mp4', sourceEditable: false },
  webm: { kind: 'video', mimeType: 'video/webm', sourceEditable: false },
  mov: { kind: 'video', mimeType: 'video/quicktime', sourceEditable: false },
  ogv: { kind: 'video', mimeType: 'video/ogg', sourceEditable: false },
  pdf: { kind: 'pdf', mimeType: 'application/pdf', sourceEditable: false }
} as const

export type WorkspaceFilePreviewFormat = (typeof WORKSPACE_FILE_PREVIEW_FORMATS)[keyof typeof WORKSPACE_FILE_PREVIEW_FORMATS]
export type WorkspaceFilePreviewKind = WorkspaceFilePreviewFormat['kind']
export type WorkspaceFilePreviewReadOptions = { expectedRevision?: string }

export function workspaceFilePreviewFormat(path: string): WorkspaceFilePreviewFormat | null {
  const name = path.slice(Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\')) + 1)
  const dot = name.lastIndexOf('.')
  if (dot <= 0) return null
  const extension = name.slice(dot + 1).toLowerCase()
  return Object.hasOwn(WORKSPACE_FILE_PREVIEW_FORMATS, extension)
    ? WORKSPACE_FILE_PREVIEW_FORMATS[extension as keyof typeof WORKSPACE_FILE_PREVIEW_FORMATS] : null
}

export type WorkspaceFilePreviewResult =
  | { status: 'ready'; kind: WorkspaceFilePreviewKind; mimeType: string; bytes: Uint8Array;
      revision: string; byteLength: number; readCost: WorkspaceFileByteRead['readCost'] }
  | { status: 'directory' }
  | { status: 'deleted'; message: string }
  | { status: 'too-large'; maxBytes: number; message: string }
  | { status: 'changed'; message: string }
  | { status: 'unsupported'; message: string }
  | { status: 'unavailable'; code: string; message: string }
