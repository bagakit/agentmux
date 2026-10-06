import { watch, type FSWatcher } from 'node:fs'
import { stat } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join } from 'node:path'
import { AgentMuxError } from './errors.js'
import type { AgentProviderSessionHistoryObservationContext, AgentSessionHistoryObservationHandle } from './types.js'

/** SQLite owns commit interpretation; a Provider supplies only its exact source revision. */
export async function observeNativeSqliteHistory(
  context: AgentProviderSessionHistoryObservationContext,
  path: string,
  readRevision: () => Promise<string>
): Promise<AgentSessionHistoryObservationHandle> {
  context.signal.throwIfAborted()
  if (!isAbsolute(path)) throw new AgentMuxError('Native history path has not been established.', 'AGENT_SESSION_HISTORY_LOCATOR_UNAVAILABLE')
  const initial = await stat(path, { bigint: true })
  if (!initial.isFile()) throw new AgentMuxError('Native history is not a regular file.', 'AGENT_SESSION_HISTORY_INVALID_TRANSCRIPT')
  let revision = await readRevision()
  context.signal.throwIfAborted()
  const name = basename(path)
  const names = new Set([name, `${name}-wal`, `${name}-journal`])
  let disposed = false, checking = false, queued = false
  let failed = false
  let directoryWatch: FSWatcher | undefined
  const files = new Map<string, { watcher: FSWatcher; dev: bigint; ino: bigint }>()
  const closed = new AbortController()
  const dispose = (): void => {
    if (disposed) return
    disposed = true
    queued = false
    directoryWatch?.close()
    for (const file of files.values()) file.watcher.close()
    files.clear()
    context.signal.removeEventListener('abort', dispose)
    closed.abort(new AgentMuxError('Native history observation was released.', 'AGENT_SESSION_HISTORY_CANCELLED'))
  }
  const unavailable = (error: unknown, fatal = false): void => {
    if (disposed) return
    failed = true
    try {
      context.onChange({ kind: 'unavailable', source: context.source,
        code: error instanceof AgentMuxError ? error.code : 'AGENT_SESSION_HISTORY_OBSERVATION_UNAVAILABLE',
        message: error instanceof Error ? error.message : 'Native history observation is unavailable.' })
    } finally { if (fatal) dispose() }
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
          try {
            const current = await stat(path, { bigint: true })
            if (disposed) return
            if (!current.isFile() || current.dev !== initial.dev || current.ino !== initial.ino) {
              unavailable(new AgentMuxError('Native history database was replaced. The original window is retained; refresh to reopen its source.', 'AGENT_SESSION_HISTORY_SOURCE_CHANGED'), true)
              return
            }
            await attachFiles()
            if (disposed) return
            const next = await readRevision()
            if (disposed) return
            if (next === revision && !failed) continue
            revision = next
            failed = false
            context.onChange({ kind: 'invalidated', source: context.source })
          } catch (error) {
            // A writer may be mid-commit. Keep the exact watch and original
            // content; its next event can confirm the source and recover.
            unavailable(error)
          }
        }
      } finally { checking = false }
    })()
  }
  const attachFiles = async (): Promise<void> => {
    // Directory notifications miss writes through an already-open descriptor on
    // macOS. Observe each exact SQLite file; the parent only handles sidecar creation.
    for (const file of names) {
      const target = join(dirname(path), file)
      let current
      try { current = await stat(target, { bigint: true }) } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
      if (disposed) return
      const previous = files.get(file)
      if (previous && current?.dev === previous.dev && current.ino === previous.ino) continue
      previous?.watcher.close(); files.delete(file)
      if (!current) continue
      if (!current.isFile()) throw new AgentMuxError('Native SQLite sidecar is not a regular file.', 'AGENT_SESSION_HISTORY_INVALID_TRANSCRIPT')
      const watcher = watch(target, { persistent: false }, () => check())
      watcher.on('error', error => unavailable(error))
      files.set(file, { watcher, dev: current.dev, ino: current.ino })
    }
  }
  directoryWatch = watch(dirname(path), { persistent: false }, (_event, file) => {
    if (disposed) return
    if (file == null) unavailable(new AgentMuxError('Native source event had no exact filename.', 'AGENT_SESSION_HISTORY_OBSERVATION_UNAVAILABLE'))
    else if (names.has(file.toString())) check()
  })
  directoryWatch.on('error', error => unavailable(error, true))
  context.signal.addEventListener('abort', dispose, { once: true })
  if (context.signal.aborted) { dispose(); context.signal.throwIfAborted() }
  try { await attachFiles() } catch (error) { dispose(); throw error }
  check() // Confirm changes in the initial read → watch setup gap.
  return { source: context.source, closed: closed.signal, dispose }
}
