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
