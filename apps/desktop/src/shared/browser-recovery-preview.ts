import { z } from 'zod'

/** Optional historical appearance, never a live screenshot or a recovery target. */
export const BROWSER_RECOVERY_PREVIEW_MAX_WIDTH = 480
export const BROWSER_RECOVERY_PREVIEW_MAX_HEIGHT = 300
export const BROWSER_RECOVERY_PREVIEW_MAX_IMAGE_BYTES = 64 * 1024
export const BROWSER_RECOVERY_PREVIEW_MAX_RECORD_BYTES = 128 * 1024
export const BROWSER_RECOVERY_PREVIEW_JPEG_PREFIX = 'data:image/jpeg;base64,'

const identity = z.string().min(1)
const commonScope = { browserId: identity, workspaceId: identity.nullable() }
export const browserRecoveryPreviewScopeSchema = z.discriminatedUnion('mode', [
  z.object({ ...commonScope, mode: z.literal('normal'), profileId: identity }).strict(),
  z.object({ ...commonScope, mode: z.literal('private'), profileId: z.null() }).strict()
])
export type BrowserRecoveryPreviewScope = z.infer<typeof browserRecoveryPreviewScopeSchema>

export const browserRecoveryPreviewSchema = z.object({
  scope: browserRecoveryPreviewScopeSchema,
  url: z.string().min(1),
  title: z.string(),
  navigationId: identity,
  capturedAt: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  image: z.object({
    dataUrl: z.string().startsWith(BROWSER_RECOVERY_PREVIEW_JPEG_PREFIX)
      .max(BROWSER_RECOVERY_PREVIEW_JPEG_PREFIX.length + 4 * Math.ceil(BROWSER_RECOVERY_PREVIEW_MAX_IMAGE_BYTES / 3)),
    width: z.number().int().min(1).max(BROWSER_RECOVERY_PREVIEW_MAX_WIDTH),
    height: z.number().int().min(1).max(BROWSER_RECOVERY_PREVIEW_MAX_HEIGHT)
  }).strict()
}).strict()
export type BrowserRecoveryPreview = z.infer<typeof browserRecoveryPreviewSchema>

export type BrowserRecoveryPreviewReadResult = (
  | { status: 'available'; preview: BrowserRecoveryPreview }
  | { status: 'missing' }
  | { status: 'unavailable' }
) & { warning?: string }
export type BrowserRecoveryPreviewRecordResult = {
  status: 'recorded' | 'skipped' | 'unavailable'
  warning?: string
}
export type BrowserRecoveryPreviewRemoveResult = {
  status: 'removed' | 'unavailable'
  warning?: string
}
