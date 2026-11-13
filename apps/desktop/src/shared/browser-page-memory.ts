import { z } from 'zod'
import { browserRecoveryPreviewScopeSchema } from './browser-recovery-preview.js'

/** Last-seen page facts of one exact Browser/Profile; never a live page or a navigation request. */
export const BROWSER_PAGE_MEMORY_MAX_ENTRIES = 50
export const BROWSER_PAGE_MEMORY_MAX_URL_LENGTH = 8 * 1024
export const BROWSER_PAGE_MEMORY_MAX_TITLE_LENGTH = 1024
export const BROWSER_PAGE_MEMORY_MAX_FAVICON_LENGTH = 96 * 1024
export const BROWSER_PAGE_MEMORY_MAX_RECORD_BYTES = 640 * 1024

const address = z.string().min(1).max(BROWSER_PAGE_MEMORY_MAX_URL_LENGTH)
export const browserPageMemoryEntrySchema = z.object({
  url: address,
  title: z.string().max(BROWSER_PAGE_MEMORY_MAX_TITLE_LENGTH)
}).strict()
export type BrowserPageMemoryEntry = z.infer<typeof browserPageMemoryEntrySchema>

export const browserPageMemorySchema = z.object({
  scope: browserRecoveryPreviewScopeSchema,
  /** The committed address every other field was observed on. */
  url: address,
  favicon: z.object({
    dataUrl: z.string().regex(/^data:image\/[a-z0-9.+-]+;base64,[a-z0-9+/]+=*$/iu).max(BROWSER_PAGE_MEMORY_MAX_FAVICON_LENGTH)
  }).strict().optional(),
  history: z.object({
    index: z.number().int().min(0),
    entries: z.array(browserPageMemoryEntrySchema).min(1).max(BROWSER_PAGE_MEMORY_MAX_ENTRIES)
  }).strict().refine(history => history.index < history.entries.length, 'The current history entry must exist.').optional()
}).strict()
export type BrowserPageMemory = z.infer<typeof browserPageMemorySchema>

export type BrowserPageMemoryReadResult = (
  | { status: 'available'; memory: BrowserPageMemory }
  | { status: 'missing' }
  | { status: 'unavailable' }
) & { warning?: string }
