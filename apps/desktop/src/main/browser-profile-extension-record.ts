import { z } from 'zod'
import { parseBrowserProfileExtensionPermissions, parseBrowserProfileExtensionSource, parseBrowserProfileExtensionInputSource, type BrowserProfileExtensionInputSource, type BrowserProfileExtensionPermissions, type BrowserProfileExtensionSource } from '@agentmux/core/control'
const permissions = z.custom<BrowserProfileExtensionPermissions>(value => { try { parseBrowserProfileExtensionPermissions(value); return true } catch { return false } })
const acquisition = z.custom<Exclude<BrowserProfileExtensionInputSource, { kind: 'local' }>>(value => { try { return parseBrowserProfileExtensionInputSource(value).kind !== 'local' } catch { return false } })
const source = z.custom<BrowserProfileExtensionSource>(value => { try { parseBrowserProfileExtensionSource(value); return true } catch { return false } })
export const browserProfileExtensionRecordSchema = z.object({ id: z.string().min(1), nativeId: z.string().min(1), key: z.string().min(1),
  reviewId: z.string().min(1), name: z.string().min(1), version: z.string().min(1), sha256: z.string().regex(/^[a-f0-9]{64}$/), permissions, source, acquisition: acquisition.optional() }).strict()
export type BrowserProfileExtensionRecord = z.infer<typeof browserProfileExtensionRecordSchema>
export const browserProfileExtensionReceiptSchema = z.object({ operationId: z.string().min(1), profileId: z.string().min(1), extensionId: z.string().min(1),
  kind: z.enum(['install', 'update', 'remove']), sha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict()
export type BrowserProfileExtensionReceipt = z.infer<typeof browserProfileExtensionReceiptSchema>

export const browserProfileExtensionPendingSchema = browserProfileExtensionReceiptSchema.extend({ expectedRevision: z.string().min(1), version: z.string().min(1), previousSha256: z.string().regex(/^[a-f0-9]{64}$/).optional(), nativeId: z.string().min(1).optional() }).strict().transform(({ previousSha256, nativeId, ...base }) => ({ ...base, ...(previousSha256 === undefined ? {} : { previousSha256 }), ...(nativeId === undefined ? {} : { nativeId }) }))
export type BrowserProfileExtensionPending = z.infer<typeof browserProfileExtensionPendingSchema>
