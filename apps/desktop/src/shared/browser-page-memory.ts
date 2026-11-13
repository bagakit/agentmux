import { z } from 'zod'
import { browserRecoveryPreviewScopeSchema } from './browser-recovery-preview.js'

/** Last-seen page facts of one exact Browser/Profile; never a live page or a navigation request. */
export const BROWSER_PAGE_MEMORY_MAX_ENTRIES = 50
export const BROWSER_PAGE_MEMORY_MAX_URL_LENGTH = 8 * 1024
export const BROWSER_PAGE_MEMORY_MAX_TITLE_LENGTH = 1024
export const BROWSER_PAGE_MEMORY_MAX_FAVICON_LENGTH = 96 * 1024
export const BROWSER_PAGE_MEMORY_MAX_RECORD_BYTES = 640 * 1024
export const BROWSER_LAST_SEEN_FAVICON_BATCH = 256

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

const FORWARD_ENTRIES = 10

/**
 * Bound one observation to a valid record: at most 50 entries around the current one (keeping up to
 * 10 forward entries). A favicon or history that does not fit is omitted whole, never truncated.
 */
export function browserPageMemory(scope: BrowserPageMemory['scope'], url: string, faviconDataUrl: string | undefined,
  history: { index: number; entries: readonly { url: string; title: string }[] } | undefined): BrowserPageMemory | null {
  let bounded: BrowserPageMemory['history']
  if (history && history.index >= 0 && history.index < history.entries.length) {
    const start = Math.max(0, Math.min(history.entries.length - BROWSER_PAGE_MEMORY_MAX_ENTRIES,
      history.index - (BROWSER_PAGE_MEMORY_MAX_ENTRIES - FORWARD_ENTRIES - 1)))
    bounded = { index: history.index - start, entries: history.entries.slice(start, start + BROWSER_PAGE_MEMORY_MAX_ENTRIES)
      .map(entry => ({ url: entry.url, title: entry.title.slice(0, BROWSER_PAGE_MEMORY_MAX_TITLE_LENGTH) })) }
  }
  const favicon = faviconDataUrl ? { dataUrl: faviconDataUrl } : undefined
  for (const candidate of [{ favicon, history: bounded }, { history: bounded }, { favicon }, {}]) {
    const parsed = browserPageMemorySchema.safeParse({ scope, url,
      ...(candidate.favicon ? { favicon: candidate.favicon } : {}), ...(candidate.history ? { history: candidate.history } : {}) })
    if (parsed.success) return parsed.data
  }
  return null
}
