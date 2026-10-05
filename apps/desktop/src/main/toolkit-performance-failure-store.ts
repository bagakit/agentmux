import { mkdir, open } from 'node:fs/promises'
import { dirname } from 'node:path'
import { AgentMuxError, durableWriteFile } from '@agentmux/core'
import { parseToolkitPerformanceFailure, TOOLKIT_PERFORMANCE_FAILURE_MAX_BYTES,
  type ToolkitPerformanceFailure } from '@agentmux/core/control'
type Write = { body: string; resolve(): void; reject(error: unknown): void }

/** One latest explicit capture; at most one active and one replaceable pending write. */
export class PerformanceFailureStore {
  private active = false
  private pending: Write | null = null
  constructor(private readonly path: string) {}
  async read(): Promise<ToolkitPerformanceFailure | null> {
    let file
    try { file = await open(this.path, 'r') }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error }
    try {
      const bytes = Buffer.alloc(TOOLKIT_PERFORMANCE_FAILURE_MAX_BYTES + 1)
      let length = 0
      while (length < bytes.length) {
        const read = await file.read(bytes, length, bytes.length - length, null)
        if (!read.bytesRead) break
        length += read.bytesRead
      }
      if (length > TOOLKIT_PERFORMANCE_FAILURE_MAX_BYTES) throw new Error('Performance failure file exceeds its budget.')
      return parseToolkitPerformanceFailure(JSON.parse(bytes.subarray(0, length).toString('utf8')))
    } finally { await file.close() }
  }
  save(failure: ToolkitPerformanceFailure): Promise<void> {
    const body = JSON.stringify(parseToolkitPerformanceFailure(failure)) + '\n'
    return new Promise((resolve, reject) => {
      const next = { body, resolve, reject }
      if (this.active) {
        const replaced = this.pending
        this.pending = next
        replaced?.reject(new AgentMuxError('A newer Performance capture replaced this pending diagnostic write; its original failure remains independent.', 'TOOLKIT_DIAGNOSTIC_SUPERSEDED'))
      } else { this.active = true; void this.write(next) }
    })
  }
  private async write(value: Write): Promise<void> {
    try {
      await mkdir(dirname(this.path), { recursive: true })
      await durableWriteFile(this.path, value.body, { mode: 0o600, requireDirectorySync: true })
      value.resolve()
    } catch (error) { value.reject(error) }
    finally {
      const next = this.pending; this.pending = null
      if (next) void this.write(next)
      else this.active = false
    }
  }
}
