import type { Readable, Writable } from 'node:stream'

/** Dedicated helper-Run protocol, never an Agent's terminal or rendered output. */
export const EXECUTION_FRAME_LIMIT = 32 * 1024 * 1024

export function createExecutionFrameChannel(options: {
  input: Readable
  output: Writable
  maxFrameBytes?: number
  onFrame(frame: unknown, rawLine: Uint8Array): Promise<void>
  onError(error: Error): void
}): { send(frame: unknown): Promise<void>; close(): void } {
  const limit = options.maxFrameBytes ?? EXECUTION_FRAME_LIMIT
  let stopped = false
  let writing = Promise.resolve()
  let queuedBytes = 0
  const fail = (error: unknown) => {
    if (!stopped) options.onError(error instanceof Error ? error : new Error(String(error)))
  }
  // Async iteration applies Readable backpressure while the exact frame settles.
  void (async () => {
    let parts: Buffer[] = [], bytes = 0
    for await (const value of options.input.iterator({ destroyOnReturn: false })) {
      if (stopped) break
      const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value as string)
      let start = 0
      while (start < chunk.length) {
        const newline = chunk.indexOf(10, start)
        const end = newline < 0 ? chunk.length : newline
        const part = chunk.subarray(start, end)
        bytes += part.length
        if (bytes > limit) throw new Error('Execution protocol frame exceeds its declared byte limit')
        parts.push(part)
        if (newline < 0) break
        const line = Buffer.concat(parts, bytes)
        parts = []; bytes = 0
        if (line.length) await options.onFrame(JSON.parse(line.toString('utf8')), line)
        if (stopped) return
        start = newline + 1
      }
    }
    if (!stopped && bytes) throw new Error('Execution protocol ended with an incomplete frame')
  })().catch(fail)
  return {
    send(frame) {
      if (stopped) return Promise.reject(new Error('Execution protocol observation is closed'))
      const data = Buffer.from(JSON.stringify(frame) + '\n')
      if (data.length - 1 > limit) return Promise.reject(new Error('Execution protocol frame exceeds its declared byte limit'))
      if (queuedBytes + data.length > limit * 2) return Promise.reject(new Error('Execution protocol writer is backpressured; this frame was not enqueued'))
      queuedBytes += data.length
      const next = writing.then(() => new Promise<void>((resolve, reject) => {
        if (stopped) { reject(new Error('Execution protocol observation is closed')); return }
        options.output.write(data, error => error ? reject(error) : resolve())
      }))
      writing = next.catch(() => {}).finally(() => { queuedBytes -= data.length })
      return next
    },
    // Ending an observer must not end the Run's PTY or any native connection.
    close() { stopped = true },
  }
}
