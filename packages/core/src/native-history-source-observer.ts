import { watch } from 'node:fs'
import { stat } from 'node:fs/promises'
import { basename, dirname, isAbsolute } from 'node:path'
import { AgentMuxError } from './errors.js'
import type { AgentProviderSessionHistoryObservationContext, AgentSessionHistoryObservationHandle } from './types.js'

type Version = { dev: bigint; ino: bigint; size: bigint; mtimeNs: bigint; ctimeNs: bigint }

async function version(path: string): Promise<Version | null> {
  try {
    const value = await stat(path, { bigint: true })
    if (!value.isFile()) throw new AgentMuxError('Native transcript is not a regular file.', 'AGENT_SESSION_HISTORY_INVALID_TRANSCRIPT')
    return { dev: value.dev, ino: value.ino, size: value.size, mtimeNs: value.mtimeNs, ctimeNs: value.ctimeNs }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

function unchanged(a: Version | null, b: Version | null): boolean {
  return a === b || (a !== null && b !== null && a.dev === b.dev && a.ino === b.ino &&
    a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs)
}

/** Observe the exact durable JSONL file. No content reading, directory scan or polling. */
export async function observeNativeJsonlHistory(
  context: AgentProviderSessionHistoryObservationContext
): Promise<AgentSessionHistoryObservationHandle> {
  context.signal.throwIfAborted()
  const path = context.transcriptPath
  if (!path || !isAbsolute(path)) {
    throw new AgentMuxError('Native transcript path has not been established.', 'AGENT_SESSION_HISTORY_LOCATOR_UNAVAILABLE')
  }
  const name = basename(path)
  let baseline = await version(path)
  context.signal.throwIfAborted()
  let disposed = false
  let checking = false
  let queued = false
  const dispose = (): void => {
    if (disposed) return
    disposed = true
    queued = false
    watcher.close()
    context.signal.removeEventListener('abort', dispose)
  }
  const unavailable = (error: unknown): void => {
    if (disposed) return
    dispose()
    context.onChange({ kind: 'unavailable', source: context.source,
      code: error instanceof AgentMuxError ? error.code : 'AGENT_SESSION_HISTORY_OBSERVATION_UNAVAILABLE',
      message: error instanceof Error ? error.message : 'Native source observation failed. Refresh to read its current page.' })
  }
  const check = (): void => {
    if (disposed) return
    queued = true
    if (checking) return
    checking = true
    void (async () => {
      try {
        while (queued && !disposed) {
          queued = false
          const next = await version(path)
          if (disposed) return
          if (unchanged(baseline, next)) continue
          if (baseline && (!next || baseline.dev !== next.dev || baseline.ino !== next.ino || next.size < baseline.size)) {
            throw new AgentMuxError('Native history source was replaced or truncated. The existing window is retained; explicitly refresh to reopen its newest page.', 'AGENT_SESSION_HISTORY_SOURCE_CHANGED')
          }
          baseline = next
          context.onChange({ kind: 'invalidated', source: context.source })
        }
      } catch (error) { unavailable(error) }
      finally { checking = false }
    })()
  }
  const watcher = watch(dirname(path), { persistent: false }, (_event, filename) => {
    if (disposed) return
    if (filename == null) {
      unavailable(new AgentMuxError('Native source change had no exact filename. Refresh to read the current page.', 'AGENT_SESSION_HISTORY_OBSERVATION_UNAVAILABLE'))
    } else if (filename.toString() === name) check()
  })
  watcher.on('error', unavailable)
  context.signal.addEventListener('abort', dispose, { once: true })
  if (context.signal.aborted) {
    dispose()
    context.signal.throwIfAborted()
  }
  // Close the stat→watch setup gap. Buffered notifications for an unchanged
  // target do no work; only a confirmed physical version change invalidates.
  check()
  return { source: context.source, dispose }
}
