/** A native file choice grants one exact local file to one screenshot editor. */
export type ScreenshotOriginalGrant = { grantId: string; path: string; revision: string | null }
export type ScreenshotOriginalSaveInput = { content: string; file?: { grantId: string; expectedRevision: string | null } }
export type ScreenshotOriginalFailure = { status: 'error' | 'conflict' | 'unknown'; message: string; file?: ScreenshotOriginalGrant }
export type ScreenshotOriginalReadResult = { status: 'read'; file: ScreenshotOriginalGrant & { revision: string }; content: string;
  verification?: 'saved' | 'unchanged' | 'changed' } | { status: 'cancelled' } | ScreenshotOriginalFailure
export type ScreenshotOriginalSaveResult = { status: 'saved'; file: ScreenshotOriginalGrant & { revision: string } } |
  { status: 'cancelled' } | ScreenshotOriginalFailure
export type ScreenshotOriginalInspectResult = ScreenshotOriginalReadResult |
  { status: 'absent'; file: ScreenshotOriginalGrant & { revision: null }; verification: 'unchanged' }
export type ScreenshotOriginalApi = {
  open(): Promise<ScreenshotOriginalReadResult>
  save(input: ScreenshotOriginalSaveInput, operationId?: string): Promise<ScreenshotOriginalSaveResult>
  inspect(grantId: string): Promise<ScreenshotOriginalInspectResult>
  /** Read an original save receipt only; pending/null never authorizes another write. */
  reconcile?(operationId: string): Promise<ScreenshotOriginalSaveResult | { status: 'pending' } | null>
}
