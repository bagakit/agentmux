import { createHash } from 'node:crypto'
import { mkdir, readFile } from 'node:fs/promises'
import { dirname, isAbsolute } from 'node:path'
import { durableWriteFile, DurableWriteError } from '@agentmux/core'

import type { WorkbenchUserStateFailure, WorkbenchUserStateReceipt, WorkbenchUserStateObservation } from '../shared/workbench-user-state.js'
export type { WorkbenchUserStateFailure, WorkbenchUserStateReceipt, WorkbenchUserStateObservation } from '../shared/workbench-user-state.js'

type UserStateIo = {
  read?: (path: string, encoding: 'utf8') => Promise<string>
  write?: typeof durableWriteFile
}

function invalid(): Error & { code: string } {
  return Object.assign(new Error('Desktop user state must be a JSON object containing an object state and numeric version. Original data is retained.'),
    { code: 'WORKBENCH_USER_STATE_INVALID' })
}

/** Validate the existing Zustand envelope without interpreting or removing user fields. */
function validate(value: unknown): asserts value is string {
  if (typeof value !== 'string') throw invalid()
  let parsed: unknown
  try { parsed = JSON.parse(value) } catch { throw invalid() }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw invalid()
  const envelope = parsed as Record<string, unknown>
  if (!envelope.state || typeof envelope.state !== 'object' || Array.isArray(envelope.state) ||
    typeof envelope.version !== 'number' || !Number.isFinite(envelope.version)) throw invalid()
}

const digest = (value: string) => createHash('sha256').update(value).digest('hex')
const size = (value: string) => Buffer.byteLength(value)

/**
 * One Main-owned document for the Desktop's existing persisted user projection.
 * Reads join admitted writes. No browser API, Session lifecycle or second layout owner lives here.
 */
export class WorkbenchUserStateStore {
  private tail: Promise<void> = Promise.resolve()
  private diagnosticRead = false
  private diagnosticWrite: Promise<void> | null = null
  private pendingDiagnostic: WorkbenchUserStateFailure | null = null
  private observation: WorkbenchUserStateObservation

  constructor(readonly path: string, private readonly io: UserStateIo = {}) {
    if (!isAbsolute(path)) throw new Error('Desktop user state requires an absolute host-owned path.')
    this.observation = { path, availability: 'unconfirmed', contentDigest: null, sizeBytes: null,
      diskDurability: 'unconfirmed', confirmedAt: null, lastConfirmedWrite: null, lastFailure: null }
  }

  observe(): WorkbenchUserStateObservation { return structuredClone(this.observation) }

  private queue<T>(action: () => Promise<T>): Promise<T> {
    const result = this.tail.then(action)
    // An unsuccessful request must not poison later explicit saves or reads.
    this.tail = result.then(() => {}, () => {})
    return result
  }

  private async readDiagnostic(): Promise<void> {
    if (this.diagnosticRead) return
    this.diagnosticRead = true
    if (this.observation.lastFailure) return
    try {
      const value = JSON.parse(await (this.io.read ?? readFile)(this.path + '.failure.json', 'utf8'))
      const failure = value?.schema === 'agentmux.workbench-user-state-failure.v1' ? value.failure : null
      if (failure && ['read', 'write'].includes(failure.operation) &&
        [null, 'request', 'before-replace', 'after-replace'].includes(failure.phase) &&
        (failure.code === null || typeof failure.code === 'string' && failure.code.length <= 128) &&
        typeof failure.observedAt === 'number' && Number.isFinite(failure.observedAt)) {
        this.observation.lastFailure = { operation: failure.operation, phase: failure.phase,
          code: failure.code, observedAt: failure.observedAt }
      }
    } catch { /* Diagnostic availability never gates the original user data. */ }
  }

  private failed(operation: WorkbenchUserStateFailure['operation'], error: unknown, request = false): void {
    const rawCode = error && typeof error === 'object' && 'code' in error ? error.code : null
    const failure: WorkbenchUserStateFailure = { operation,
      phase: request ? 'request' : error instanceof DurableWriteError ? error.phase : null,
      code: typeof rawCode === 'string' ? rawCode.slice(0, 128) : null, observedAt: Date.now() }
    if (!request) {
      Object.assign(this.observation, { availability: 'unconfirmed', contentDigest: null, sizeBytes: null,
        diskDurability: 'unconfirmed', confirmedAt: null })
    }
    this.observation.lastFailure = failure
    this.pendingDiagnostic = failure
    this.publishDiagnostic()
  }

  private publishDiagnostic(): void {
    if (this.diagnosticWrite || !this.pendingDiagnostic) return
    const failure = this.pendingDiagnostic
    this.pendingDiagnostic = null
    // Keep at most one auxiliary write and the latest pending metadata. This
    // observation is deliberately outside the user-data request queue.
    this.diagnosticWrite = Promise.resolve().then(async () => {
      try {
        await (this.io.write ?? durableWriteFile)(this.path + '.failure.json',
          JSON.stringify({ schema: 'agentmux.workbench-user-state-failure.v1', failure }) + '\n', { requireDirectorySync: true })
      } catch { /* Diagnostic persistence never masks or delays the original business request. */ }
    }).finally(() => { this.diagnosticWrite = null; this.publishDiagnostic() })
  }

  /** Diagnostic observers may await this; user saving and ordinary exit must not depend on it. */
  async flushDiagnostics(): Promise<void> {
    while (this.diagnosticWrite) await this.diagnosticWrite
  }

  private async readCurrent(): Promise<string | null> {
    await this.readDiagnostic()
    let value: string
    try { value = await (this.io.read ?? readFile)(this.path, 'utf8') }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      Object.assign(this.observation, { availability: 'missing', contentDigest: null, sizeBytes: null,
        diskDurability: 'unconfirmed', confirmedAt: null })
      return null
    }
    validate(value)
    const contentDigest = digest(value)
    // Equal bytes do not establish that this path still names the file confirmed
    // by an earlier write. Retain that receipt as history, separate from this read.
    Object.assign(this.observation, { availability: 'present', contentDigest, sizeBytes: size(value),
      diskDurability: 'unconfirmed', confirmedAt: null })
    return value
  }

  read(): Promise<string | null> {
    return this.queue(async () => {
      try { return await this.readCurrent() }
      catch (error) { await this.failed('read', error); throw error }
    })
  }

  private async writeCurrent(value: string): Promise<WorkbenchUserStateReceipt> {
    try {
      await mkdir(dirname(this.path), { recursive: true, mode: 0o700 })
      // Explicit saves always obtain a writer ACK, including identical bytes
      // after replacement or a previous unknown directory sync. User-change
      // coalescing belongs to the existing Renderer batch writer.
      await (this.io.write ?? durableWriteFile)(this.path, value, { requireDirectorySync: true })
      const receipt: WorkbenchUserStateReceipt = { path: this.path, contentDigest: digest(value), sizeBytes: size(value),
        diskDurability: 'confirmed', confirmedAt: Date.now() }
      Object.assign(this.observation, { availability: 'present', ...receipt, lastConfirmedWrite: receipt })
      return structuredClone(receipt)
    } catch (error) { this.failed('write', error); throw error }
  }

  /** The native absence check and first import are one owner-serialized operation. */
  importIfAbsent(value: string): Promise<string> {
    return this.queue(async () => {
      let current: string | null
      try { current = await this.readCurrent() }
      catch (error) { this.failed('read', error); throw error }
      if (current !== null) {
        // A concurrent native winner must be acknowledged too: the importer
        // may remove equal legacy bytes only after this exact writer confirms.
        await this.writeCurrent(current)
        return current
      }
      try { validate(value) }
      catch (error) { this.failed('write', error, true); throw error }
      await this.writeCurrent(value)
      return value
    })
  }

  write(value: string): Promise<WorkbenchUserStateReceipt> {
    return this.queue(async () => {
      try { validate(value) }
      catch (error) { await this.failed('write', error, true); throw error }
      try { await this.readCurrent() }
      catch (error) { await this.failed('read', error); throw error }
      return this.writeCurrent(value)
    })
  }
}
