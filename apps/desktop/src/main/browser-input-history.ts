import { createHash } from 'node:crypto'
import { mkdir, open } from 'node:fs/promises'
import { join } from 'node:path'
import { durableWriteFile } from '@agentmux/core'
import { z } from 'zod'
import type {
  BrowserInputHistoryEntry, BrowserInputHistoryRecord,
  BrowserInputHistoryScope, BrowserInputHistorySnapshot
} from '../shared/browser-input-history.js'

export const MAX_BROWSER_INPUT_HISTORY_ENTRIES = 50
export const MAX_BROWSER_INPUT_HISTORY_TEXT_BYTES = 4096
export const MAX_BROWSER_INPUT_HISTORY_FILE_BYTES = 256 * 1024

const scopeSchema = z.object({
  workspaceId: z.string().min(1).max(1024),
  profileId: z.string().uuid()
}).strict()
const textSchema = z.string().min(1).refine(text =>
  text === text.trim() && Buffer.byteLength(text, 'utf8') <= MAX_BROWSER_INPUT_HISTORY_TEXT_BYTES)
const documentSchema = z.object({
  version: z.literal(1),
  scope: scopeSchema,
  entries: z.array(z.object({
    text: textSchema,
    submittedAt: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER)
  }).strict()).max(MAX_BROWSER_INPUT_HISTORY_ENTRIES)
}).strict().refine(document => new Set(document.entries.map(entry => entry.text)).size === document.entries.length)

function hasUrlUserinfo(text: string): boolean {
  let parsed: URL
  try { parsed = new URL(text) }
  catch {
    // This is the same distinction as the address input: spaced text is a search, not an authority.
    if (/\s/.test(text)) return false
    try { parsed = new URL(`https://${text}`) } catch { return false }
  }
  return parsed.username !== '' || parsed.password !== ''
}

function sameScope(first: BrowserInputHistoryScope, second: BrowserInputHistoryScope): boolean {
  return first.workspaceId === second.workspaceId && first.profileId === second.profileId
}

/** One bounded file per actual scope; no directory scan, cached empty success, or navigation hook. */
export class BrowserInputHistoryStore {
  private operationTail: Promise<void> = Promise.resolve()

  constructor(private readonly directory: string) {}

  list(scope: BrowserInputHistoryScope): Promise<BrowserInputHistorySnapshot> {
    return this.enqueue(async () => {
      const actualScope = scopeSchema.parse(scope)
      return { scope: actualScope, entries: await this.read(actualScope) }
    })
  }

  record(scope: BrowserInputHistoryScope, value: string): Promise<BrowserInputHistoryRecord> {
    return this.enqueue(async () => {
      const actualScope = scopeSchema.parse(scope)
      if (typeof value !== 'string') throw new Error('Browser input history requires submitted text.')
      const text = value.trim()
      const entries = await this.read(actualScope)
      if (!text) return { scope: actualScope, entries, outcome: 'empty' }
      textSchema.parse(text)
      if (hasUrlUserinfo(text)) return { scope: actualScope, entries, outcome: 'url-userinfo' }
      const next = [{ text, submittedAt: Date.now() }, ...entries.filter(entry => entry.text !== text)]
        .slice(0, MAX_BROWSER_INPUT_HISTORY_ENTRIES)
      // JSON escaping can enlarge a valid UTF-8 input. Bound the actual serialized file as well.
      while (Buffer.byteLength(this.document(actualScope, next), 'utf8') > MAX_BROWSER_INPUT_HISTORY_FILE_BYTES) next.pop()
      await this.write(actualScope, next)
      return { scope: actualScope, entries: next, outcome: 'recorded' }
    })
  }

  remove(scope: BrowserInputHistoryScope, text: string): Promise<BrowserInputHistorySnapshot> {
    return this.enqueue(async () => {
      const actualScope = scopeSchema.parse(scope)
      const entries = (await this.read(actualScope)).filter(entry => entry.text !== text)
      await this.write(actualScope, entries)
      return { scope: actualScope, entries }
    })
  }

  clear(scope: BrowserInputHistoryScope): Promise<BrowserInputHistorySnapshot> {
    return this.enqueue(async () => {
      const actualScope = scopeSchema.parse(scope)
      // A damaged/unreadable file is not silently replaced by a successful clear.
      await this.read(actualScope)
      await this.write(actualScope, [])
      return { scope: actualScope, entries: [] }
    })
  }

  flush(): Promise<void> { return this.operationTail }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operationTail.then(operation)
    this.operationTail = result.then(() => {}, () => {})
    return result
  }

  private path(scope: BrowserInputHistoryScope): string {
    const key = createHash('sha256').update(JSON.stringify([scope.workspaceId, scope.profileId])).digest('hex')
    return join(this.directory, `${key}.json`)
  }

  private async read(scope: BrowserInputHistoryScope): Promise<BrowserInputHistoryEntry[]> {
    let handle
    try { handle = await open(this.path(scope), 'r') }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw error
    }
    try {
      const info = await handle.stat()
      if (!info.isFile() || info.size > MAX_BROWSER_INPUT_HISTORY_FILE_BYTES) {
        throw new Error('Browser input history exceeds its file budget or is not a regular file.')
      }
      const buffer = Buffer.alloc(info.size + 1)
      let length = 0
      while (length < buffer.length) {
        const chunk = await handle.read(buffer, length, buffer.length - length, length)
        if (chunk.bytesRead === 0) break
        length += chunk.bytesRead
      }
      if (length !== info.size) throw new Error('Browser input history changed while being read.')
      const document = documentSchema.parse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, length))))
      if (!sameScope(document.scope, scope)) throw new Error('Browser input history belongs to another scope.')
      return document.entries
    } finally { await handle.close() }
  }

  private document(scope: BrowserInputHistoryScope, entries: BrowserInputHistoryEntry[]): string {
    return `${JSON.stringify(documentSchema.parse({ version: 1, scope, entries }))}\n`
  }

  private async write(scope: BrowserInputHistoryScope, entries: BrowserInputHistoryEntry[]): Promise<void> {
    const document = this.document(scope, entries)
    if (Buffer.byteLength(document, 'utf8') > MAX_BROWSER_INPUT_HISTORY_FILE_BYTES) throw new Error('Browser input history exceeds its file budget.')
    await mkdir(this.directory, { recursive: true })
    await durableWriteFile(this.path(scope), document)
  }
}
