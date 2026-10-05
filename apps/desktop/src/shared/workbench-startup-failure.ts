/** Only startup Error fields cross this private diagnostic path; no workbench values are read. */
export type WorkbenchStartupError = {
  name: string
  message: string
  stack?: string
  code?: string
}

export type WorkbenchRendererStartupFailure = {
  attemptId: string
  event: 'renderer-import-error' | 'renderer-error' | 'renderer-unhandled-rejection'
  error: WorkbenchStartupError
}
