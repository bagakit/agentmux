import { createHash } from 'node:crypto'
import { lstat, opendir, realpath, stat } from 'node:fs/promises'
import { isAbsolute, join, relative, sep } from 'node:path'
import { AgentMuxError } from '../errors.js'
import { NativeJsonlHistoryReader } from '../native-jsonl-history-reader.js'
import type { AgentNativeSessionCatalog, AgentProviderNativeSessionListContext } from '../types.js'

export function nativeCatalogIssue(error: unknown): AgentNativeSessionCatalog['issues'][number] {
  return { code: error instanceof AgentMuxError ? error.code : (error as NodeJS.ErrnoException)?.code ?? 'AGENT_NATIVE_SESSION_DISCOVERY_FAILED',
    message: error instanceof Error ? error.message : 'Native conversation metadata could not be read.' }
}

/** Related source count controls IO; a failed entry does not erase other persisted conversations. */
export async function* nativeCatalogFiles(root: string, context: AgentProviderNativeSessionListContext,
  issues: AgentNativeSessionCatalog['issues'], accepts: (name: string) => boolean): AsyncGenerator<string> {
  context.signal.throwIfAborted()
  let directory
  try { directory = await opendir(root) } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') issues.push(nativeCatalogIssue(error))
    return
  }
  for await (const entry of directory) {
    context.signal.throwIfAborted()
    const path = join(root, entry.name)
    if (entry.isDirectory()) yield* nativeCatalogFiles(path, context, issues, accepts)
    else if (entry.isFile() && accepts(entry.name)) yield path
  }
}

export async function readNativeCatalogFile<T>(providerId: string, path: string,
  context: AgentProviderNativeSessionListContext,
  read: (reader: NativeJsonlHistoryReader) => Promise<T>): Promise<{ value: T; revision: string; updatedAt: number }> {
  const before = await lstat(path)
  if (!before.isFile()) throw new AgentMuxError('Native conversation metadata must be an original regular file.', 'INVALID_AGENT_NATIVE_RESUME_SOURCE')
  const revision = (metadata: typeof before): string => createHash('sha256')
    .update(JSON.stringify([metadata.dev, metadata.ino, metadata.birthtimeMs])).digest('hex')
  const reader = await NativeJsonlHistoryReader.open({ source: { providerId, nativeSessionId: 'catalog-metadata' },
    transcriptPath: path, command: '', args: [], env: context.env, workspacePath: context.workspacePath ?? '', limit: 1, signal: context.signal })
  try {
    const value = await read(reader)
    await reader.verifyUnchanged()
    const after = await lstat(path)
    if (!after.isFile() || revision(before) !== revision(after)) {
      throw new AgentMuxError('The original native conversation file changed. Refresh its exact source.', 'AGENT_NATIVE_RESUME_SOURCE_CHANGED')
    }
    return { value, revision: revision(before), updatedAt: after.mtimeMs }
  } finally { await reader.close() }
}

/** A selected UI locator grants no authority to read a file outside this Provider's actual roots. */
export async function assertNativeCatalogPath(path: string, roots: readonly string[]): Promise<void> {
  if (!isAbsolute(path) || await realpath(path) !== path || !(await stat(path)).isFile()) {
    throw new AgentMuxError('Native resume source is not an original Provider file. Refresh native conversations.', 'INVALID_AGENT_NATIVE_RESUME_SOURCE')
  }
  let contained = false
  for (const root of roots) {
    let actualRoot: string
    try { actualRoot = await realpath(root) } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
      throw error
    }
    const fromRoot = relative(actualRoot, path)
    if (fromRoot && !isAbsolute(fromRoot) && fromRoot !== '..' && !fromRoot.startsWith(`..${sep}`)) contained = true
  }
  if (!contained) throw new AgentMuxError('Native resume source belongs to another Provider storage location.', 'INVALID_AGENT_NATIVE_RESUME_SOURCE')
}
