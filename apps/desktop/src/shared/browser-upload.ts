export type BrowserUploadSource = {
  workspaceId: string | null
  browserId: string
  operationId: string
  navigationId: string
}

export type BrowserUploadFile = { path: string; name: string; byteLength: number; revision: string }
export type BrowserUploadReceipt = Omit<BrowserUploadSource, 'workspaceId'> & {
  kind: 'browser-upload-files'
  workspaceId: string
  files: BrowserUploadFile[]
  byteLength: number
}

/** Local person-only retained-file view; it never grants access to a browser page. */
export type BrowserRetainedUploadSelection = { id: string; browserId: string | null; navigationId: string | null;
  workspaceId: string | null; files: string[]; byteLength: number; status: 'selected' | 'unknown' }
export type BrowserRetainedUploads = { selections: BrowserRetainedUploadSelection[]; selectionCount: number;
  byteLength: number; selectionLimit: number; byteLimit: number; warning?: string }
