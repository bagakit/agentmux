import type { WorkbenchWindowDocument } from './workbench-windows'

/** Main calls this only in the original trusted workbench frame, never a Browser page. */
export type ScreenshotAttachmentReceiver = {
  prepare(operationId: string): WorkbenchWindowDocument | null
  complete(operationId: string, path: string | null): Promise<void>
}

export const SCREENSHOT_ATTACHMENT_RECEIVER = 'agentmuxScreenshotAttachment' as const
