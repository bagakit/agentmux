import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { mkdir, open, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { durableWriteFile } from '@agentmux/core'
import { z } from 'zod'
import {
  BROWSER_RECOVERY_PREVIEW_JPEG_PREFIX, BROWSER_RECOVERY_PREVIEW_MAX_IMAGE_BYTES,
  BROWSER_RECOVERY_PREVIEW_MAX_RECORD_BYTES, browserRecoveryPreviewSchema, browserRecoveryPreviewScopeSchema,
  type BrowserRecoveryPreview, type BrowserRecoveryPreviewReadResult, type BrowserRecoveryPreviewRecordResult,
  type BrowserRecoveryPreviewRemoveResult, type BrowserRecoveryPreviewScope
} from '../shared/browser-recovery-preview.js'

const documentSchema = z.object({ version: z.literal(1), preview: browserRecoveryPreviewSchema }).strict()
const digest = (value: string) => createHash('sha256').update(value).digest('hex')
const sameScope = (a: BrowserRecoveryPreviewScope, b: BrowserRecoveryPreviewScope) =>
  a.browserId === b.browserId && a.profileId === b.profileId && a.mode === b.mode && a.workspaceId === b.workspaceId

function checkedPreview(value: BrowserRecoveryPreview): BrowserRecoveryPreview {
  const preview = browserRecoveryPreviewSchema.parse(value)
  const payload = preview.image.dataUrl.slice(BROWSER_RECOVERY_PREVIEW_JPEG_PREFIX.length)
  const bytes = Buffer.from(payload, 'base64')
  if (bytes.length < 4 || bytes.length > BROWSER_RECOVERY_PREVIEW_MAX_IMAGE_BYTES || bytes.toString('base64') !== payload ||
      bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes.at(-2) !== 0xff || bytes.at(-1) !== 0xd9) {
    throw new Error('Browser preview has invalid JPEG bytes.')
  }
  return preview
}

function warning(operation: string, error: unknown): string {
  const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined
  return `Browser preview could not be ${operation}${typeof code === 'string' ? ` (${code})` : ''}. The page and Retry remain available.`
}

/**
 * One self-contained normal file per Browser/Profile, or private memory in this owner only.
 * Related Profile IO is ordered so clear cannot race a queued publication; no directory index or scan.
 */
export class BrowserRecoveryPreviewStore {
  private readonly tails = new Map<string, Promise<void>>()
  private readonly privatePreviews = new Map<string, BrowserRecoveryPreview>()
  private readonly warnings = new Map<string, Map<string, string>>()

  constructor(private readonly directory: string) {}

  async record(scope: BrowserRecoveryPreviewScope, value: BrowserRecoveryPreview, isCurrent: () => boolean,
    signal?: AbortSignal): Promise<BrowserRecoveryPreviewRecordResult> {
    let actual: BrowserRecoveryPreviewScope
    try { actual = browserRecoveryPreviewScopeSchema.parse(scope) }
    catch (error) { return { status: 'unavailable', warning: warning('saved', error) } }
    let preview: BrowserRecoveryPreview, document: string
    try {
      preview = checkedPreview(value)
      if (!sameScope(actual, preview.scope)) throw new Error('Browser preview belongs to another scope.')
      document = `${JSON.stringify(documentSchema.parse({ version: 1, preview }))}\n`
      if (Buffer.byteLength(document) > BROWSER_RECOVERY_PREVIEW_MAX_RECORD_BYTES) throw new Error('Browser preview exceeds its record budget.')
    } catch (error) {
      return this.enqueue(actual, async () => {
        const message = warning('saved', error)
        this.setWarning(actual, message)
        return { status: 'unavailable', warning: message }
      })
    }
    return this.enqueue(actual, async () => {
      try {
        if (signal?.aborted || !isCurrent()) return { status: 'skipped' }
        if (actual.mode === 'private') this.privatePreviews.set(actual.browserId, preview)
        else {
          await mkdir(this.profileDirectory(actual.profileId), { recursive: true })
          if (signal?.aborted || !isCurrent()) return { status: 'skipped' }
          await durableWriteFile(this.path(actual), document, { ...(signal ? { signal } : {}), requireDirectorySync: true })
          // No read can see this result before its source has been rechecked in this queue.
          if (signal?.aborted || !isCurrent()) {
            await rm(this.path(actual), { force: true })
            return { status: 'skipped' }
          }
        }
        this.setWarning(actual)
        return { status: 'recorded' }
      } catch (error) {
        if (signal?.aborted && (error === signal.reason || (error instanceof Error && error.cause === signal.reason))) return { status: 'skipped' }
        const message = warning('saved', error)
        this.setWarning(actual, message)
        return { status: 'unavailable', warning: message }
      }
    })
  }

  async read(scope: BrowserRecoveryPreviewScope): Promise<BrowserRecoveryPreviewReadResult> {
    let actual: BrowserRecoveryPreviewScope
    try { actual = browserRecoveryPreviewScopeSchema.parse(scope) }
    catch (error) { return { status: 'unavailable', warning: warning('read', error) } }
    return this.enqueue(actual, async () => {
      const previousWarning = this.warnings.get(this.queueKey(actual))?.get(actual.browserId)
      const noted = previousWarning ? { warning: previousWarning } : {}
      try {
        let preview: BrowserRecoveryPreview | undefined
        if (actual.mode === 'private') {
          const saved = this.privatePreviews.get(actual.browserId)
          preview = saved ? browserRecoveryPreviewSchema.parse(saved) : undefined
        } else {
          let handle
          try { handle = await open(this.path(actual), constants.O_RDONLY | constants.O_NOFOLLOW) }
          catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { status: 'missing', ...noted }
            throw error
          }
          try {
            const info = await handle.stat()
            if (!info.isFile() || info.size > BROWSER_RECOVERY_PREVIEW_MAX_RECORD_BYTES) throw new Error('Browser preview is not a bounded record.')
            const bytes = Buffer.alloc(info.size + 1)
            let length = 0
            while (length < bytes.length) {
              const part = await handle.read(bytes, length, bytes.length - length, length)
              if (!part.bytesRead) break
              length += part.bytesRead
            }
            if (length !== info.size) throw new Error('Browser preview changed during its read.')
            preview = checkedPreview(documentSchema.parse(JSON.parse(new TextDecoder('utf-8', { fatal: true })
              .decode(bytes.subarray(0, length)))).preview)
          } finally { await handle.close() }
        }
        if (!preview) return { status: 'missing', ...noted }
        if (!sameScope(preview.scope, actual)) throw new Error('Browser preview belongs to another scope.')
        return { status: 'available', preview, ...noted }
      } catch (error) { return { status: 'unavailable', warning: warning('read', error) } }
    })
  }

  async remove(scope: BrowserRecoveryPreviewScope): Promise<BrowserRecoveryPreviewRemoveResult> {
    let actual: BrowserRecoveryPreviewScope
    try { actual = browserRecoveryPreviewScopeSchema.parse(scope) }
    catch (error) { return { status: 'unavailable', warning: warning('removed', error) } }
    return this.enqueue(actual, async () => {
      try {
        if (actual.mode === 'private') this.privatePreviews.delete(actual.browserId)
        else await rm(this.path(actual), { force: true })
        this.setWarning(actual)
        return { status: 'removed' }
      } catch (error) {
        const message = warning('removed', error)
        this.setWarning(actual, message)
        return { status: 'unavailable', warning: message }
      }
    })
  }

  async clearProfile(profileId: string): Promise<BrowserRecoveryPreviewRemoveResult> {
    if (typeof profileId !== 'string' || !profileId) return { status: 'unavailable', warning: warning('removed', null) }
    return this.enqueueKey(`normal:${profileId}`, async () => {
      try {
        await rm(this.profileDirectory(profileId), { recursive: true, force: true })
        this.warnings.delete(`normal:${profileId}`)
        return { status: 'removed' }
      } catch (error) { return { status: 'unavailable', warning: warning('removed', error) } }
    })
  }

  async flush(): Promise<void> { await Promise.all(this.tails.values()) }

  /** Called at App end after its capture producers have stopped. Normal files remain. */
  async dispose(): Promise<void> { await this.flush(); this.privatePreviews.clear(); this.warnings.clear() }

  private queueKey(scope: BrowserRecoveryPreviewScope): string {
    return scope.mode === 'normal' ? `normal:${scope.profileId}` : `private:${scope.browserId}`
  }
  private enqueue<T>(scope: BrowserRecoveryPreviewScope, operation: () => Promise<T>): Promise<T> {
    return this.enqueueKey(this.queueKey(scope), operation)
  }
  private enqueueKey<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const result = (this.tails.get(key) ?? Promise.resolve()).then(operation)
    const tail = result.then(() => {}, () => {})
    this.tails.set(key, tail)
    void tail.then(() => { if (this.tails.get(key) === tail) this.tails.delete(key) })
    return result
  }
  private setWarning(scope: BrowserRecoveryPreviewScope, value?: string): void {
    const key = this.queueKey(scope)
    if (value) {
      let values = this.warnings.get(key)
      if (!values) { values = new Map(); this.warnings.set(key, values) }
      values.set(scope.browserId, value)
    } else {
      const values = this.warnings.get(key)
      values?.delete(scope.browserId)
      if (values?.size === 0) this.warnings.delete(key)
    }
  }
  private profileDirectory(profileId: string): string { return join(this.directory, digest(profileId)) }
  private path(scope: BrowserRecoveryPreviewScope & { mode: 'normal' }): string {
    return join(this.profileDirectory(scope.profileId), `${digest(scope.browserId)}.json`)
  }
}
