export type DjvuRequest = { type: 'open'; id: number; size: number } | { type: 'render'; id: number; size: number; index: number }
export type DjvuRead = { type: 'read'; request: number; offset: number; length: number }
export type DjvuReadResult = { type: 'bytes'; request: number; bytes: Uint8Array } | { type: 'read-error'; request: number; message: string }
export type DjvuResult = DjvuRead | { type: 'opened'; id: number; pages: number } | { type: 'rendered'; id: number; blob: Blob } | { type: 'error'; id: number; message: string }
